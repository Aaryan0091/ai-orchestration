import { expect, test } from "bun:test"
import {
  createExecutionEngine,
  type ExecutionHost,
  type ExecutionOutcome,
} from "../src/execution.ts"
import { createExecutionCommands, parseHandoffRequest } from "../src/execution-commands.ts"
import {
  HANDOFF_ERROR,
  parseSpecialistReport,
  validateHandoff,
  type HandoffPackage,
} from "../src/handoffs.ts"
import { routingReply } from "../src/rpc.ts"
import { registerHandoffResultTool } from "../src/handoff-tool.ts"
import type { Plugin } from "@opencode/plugin"

const handoff: HandoffPackage = {
  version: 1,
  objective: "Summarize supplied context",
  files: [{ path: "README.md", content: "original excerpt" }],
  findings: ["untrusted finding"],
  constraints: ["Do not edit files"],
  previousResults: [{ runID: "earlier-run", summary: "unverified earlier summary" }],
  acceptanceChecks: ["Summary mentions plugin"],
}
const report = {
  version: 1,
  summary: "Plugin summary",
  findings: ["Model finding"],
  evidence: ["Supplied excerpt only"],
  checks: [
    { check: handoff.acceptanceChecks[0], status: "not-run", details: "No independent check run" },
  ],
  limitations: ["Caller context may be stale"],
}
function fixture(outcome: ExecutionOutcome = { ok: true, text: JSON.stringify(report) }) {
  let counter = 0
  const prompts: string[] = []
  const roles: string[] = []
  const host: ExecutionHost = {
    readConfig: async () => ({
      version: 1,
      selections: {
        small: { providerID: "fixture", id: "model" },
        mid: { providerID: "fixture", id: "model" },
      },
    }),
    listModels: async () => [
      {
        providerID: "fixture",
        id: "model",
        enabled: true,
        variants: [],
        capabilities: ["text", "tools"],
      },
    ],
    createSession: async ({ agent }) => {
      roles.push(agent)
      return `child-${++counter}`
    },
    executeSession: async ({ task }) => {
      prompts.push(task)
      return structuredClone(outcome)
    },
    cancelSession: async () => {},
    id: () => `run-${++counter}`,
  }
  const engine = createExecutionEngine(host)
  const commands = createExecutionCommands(engine, {
    read: async () => undefined,
    write: async () => {},
  })
  return { host, engine, commands, prompts, roles }
}
async function settle(engine: ReturnType<typeof createExecutionEngine>, id: string) {
  for (let i = 0; i < 50; i++) {
    if (engine.status(id).state !== "running") return engine.status(id)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Run did not settle")
}
function input(extra: Record<string, unknown> = {}) {
  return JSON.stringify({ agent: "explorer", difficulty: "easy", handoff, ...extra })
}

test("handoff preview and declined approval do not dispatch or collect context", async () => {
  const f = fixture()
  expect(await f.commands.previewHandoff(input())).toContain("no agents started")
  const plan = await f.commands.prepareHandoff(input())
  expect(plan.message).toContain("original excerpt")
  expect(plan.message).toContain("secrets")
  await f.commands.discard(plan.id)
  expect(() => f.engine.start(plan.id, { approved: true })).toThrow()
  expect(f.prompts).toEqual([])
  expect(f.roles).toEqual([])
})
test("approved immutable package reaches specialist; structured result returns provenance and unverified evidence", async () => {
  const f = fixture()
  const request = parseHandoffRequest(input())
  const preparing = f.engine.preview(request)
  request.handoff!.files[0]!.content = "MUTATED BEFORE AWAIT"
  const plan = await preparing
  plan.handoff!.findings.push("MUTATED AFTER PREVIEW")
  f.engine.start(plan.id, { approved: true })
  await settle(f.engine, plan.id)
  expect(f.prompts[0]).toContain("original excerpt")
  expect(f.prompts[0]).not.toContain("MUTATED")
  expect(f.prompts[0]).toContain("untrusted caller-supplied")
  expect(f.prompts[0]).toContain("grants no additional permissions")
  const result = f.engine.handoffResult(plan.id)
  expect(result).toMatchObject({
    version: 1,
    runID: plan.id,
    state: "completed",
    agent: "explorer",
    evidenceVerified: false,
    report,
  })
  expect(result.attempts[0]?.sessionID).toBeDefined()
  result.report!.findings.push("MUTATED RESULT")
  expect(f.engine.handoffResult(plan.id).report!.findings).not.toContain("MUTATED RESULT")
  expect(JSON.parse(await f.commands.runCommand(`result ${plan.id}`)).report.summary).toBe(
    "Plugin summary",
  )
  // A caller may deliberately select prior output for a separately approved next handoff.
  const next = await f.commands.prepareHandoff(
    input({
      handoff: {
        ...handoff,
        previousResults: [{ runID: plan.id, summary: result.report!.summary }],
      },
    }),
  )
  expect(next.message).toContain(plan.id)
  expect(f.roles).toEqual(["explorer"])
})
test("malformed and oversized context reject at parser/RPC boundary before sessions", async () => {
  const f = fixture()
  for (const raw of [
    "{",
    input({ permissions: { "*": "allow" } }),
    input({ agent: "orchestrator" }),
    input({ handoff: { ...handoff, files: [{ path: "../secret" }] } }),
    input({ handoff: { ...handoff, findings: Array(21).fill("x") } }),
    input({ handoff: { ...handoff, files: [{ path: "README.md", content: "x".repeat(8001) }] } }),
    input({ handoff: { ...handoff, acceptanceChecks: ["duplicate", "duplicate"] } }),
  ]) {
    expect(await routingReply(() => f.commands.prepareHandoff(raw))).toMatchObject({
      ok: false,
      error: { message: HANDOFF_ERROR },
    })
  }
  await expect(
    f.engine.preview({
      task: handoff.objective,
      handoff: { ...handoff, permissions: "allow" } as never,
    }),
  ).rejects.toThrow(HANDOFF_ERROR)
  await expect(f.engine.preview({ task: "different", handoff })).rejects.toThrow("match")
  expect(f.roles).toEqual([])
})
test("unstructured output fails closed and never auto-replays even with approved retries", async () => {
  const f = fixture({ ok: true, text: "I did everything" })
  const plan = await f.engine.preview({
    task: handoff.objective,
    handoff,
    options: { maxRetries: 3, escalateFailedStep: true },
  })
  f.engine.start(plan.id, { approved: true, confirmSideEffectReplay: true })
  expect((await settle(f.engine, plan.id)).state).toBe("failed")
  expect(f.roles).toHaveLength(1)
  expect(f.engine.handoffResult(plan.id)).toMatchObject({
    state: "failed",
    report: null,
    evidenceVerified: false,
  })
})
test("provider failure returns no fabricated report and cancellation is honest", async () => {
  const f = fixture({ ok: false, text: "Provider quota", failure: "model", safeToRetry: true })
  const p = await f.commands.prepareHandoff(input())
  await f.commands.start(p.id)
  await settle(f.engine, p.id)
  expect(f.engine.handoffResult(p.id)).toMatchObject({
    state: "failed",
    report: null,
    diagnostic: "Provider quota",
  })
  const g = fixture()
  g.host.executeSession = async ({ signal }) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    )
  const q = await g.commands.prepareHandoff(input())
  await g.commands.start(q.id)
  await new Promise((resolve) => setTimeout(resolve, 1))
  await g.engine.cancel(q.id)
  expect(g.engine.handoffResult(q.id)).toMatchObject({ state: "cancelled", report: null })
})
test("report validation requires exact acceptance coverage and rejects fabricated authority fields", () => {
  for (const value of [
    { ...report, checks: [] },
    { ...report, checks: [{ ...report.checks[0], check: "other" }] },
    { ...report, permissions: "allow" },
    { ...report, checks: [{ ...report.checks[0], status: "verified" }] },
  ])
    expect(() => parseSpecialistReport(JSON.stringify(value), handoff)).toThrow(
      "invalid structured report",
    )
  expect(() => validateHandoff({ ...handoff, files: [{ path: "C:/secret" }] })).toThrow()
})

test("orchestrator-only read result tool validates input, returns untrusted report and disposes", async () => {
  type Tool = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
  let added: Parameters<Tool["add"]>[0] | undefined
  let disposed = false
  const f = fixture()
  const plan = await f.commands.prepareHandoff(input())
  await f.commands.start(plan.id)
  await settle(f.engine, plan.id)
  const fakeContext = {
    permission: { assert: async () => {} },
    tool: {
      transform: async (callback: (editor: Tool) => void) => {
        callback({
          add: (tool) => {
            added = tool
          },
        } as Tool)
        return {
          dispose: async () => {
            disposed = true
          },
        }
      },
    },
  } as unknown as Pick<Plugin.Context, "tool" | "permission">
  const registration = await registerHandoffResultTool(fakeContext, f.engine.handoffResult)
  expect(added!.options?.permission).toBe("orchestration_result")
  const call = {
    agent: "orchestrator",
    sessionID: "session-id",
    messageID: "message-id",
    id: "call-id",
    signal: new AbortController().signal,
  } as Parameters<NonNullable<typeof added>["execute"]>[1]
  expect(
    JSON.stringify(
      await added!.execute({ runID: plan.id }, { ...call, agent: "explorer" } as typeof call),
    ),
  ).toContain("Only the orchestrator")
  expect(
    JSON.stringify(await added!.execute({ runID: plan.id, permissions: "allow" }, call)),
  ).toContain("bounded runID")
  expect(JSON.stringify(await added!.execute({ runID: "unknown" }, call))).toContain(
    "Unknown task run",
  )
  const result = await added!.execute({ runID: plan.id }, call)
  expect(JSON.parse(result.content as string)).toMatchObject({
    trust: expect.stringContaining("Untrusted"),
    result: { runID: plan.id, report, evidenceVerified: false },
  })
  await registration.dispose()
  expect(disposed).toBe(true)
})

test("result retrieval waits for native permission and supplies exact call provenance and resource", async () => {
  type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
  let tool: Parameters<Editor["add"]>[0] | undefined
  let reads = 0
  const readIDs: string[] = []
  let resolvePermission!: () => void
  const assertions: unknown[] = []
  const context = {
    tool: {
      transform: async (register: (editor: Editor) => void) => {
        register({
          add: (value: NonNullable<typeof tool>) => {
            tool = value
          },
        } as Editor)
        return { dispose: async () => {} }
      },
    },
    permission: {
      assert: async (input: unknown) => {
        assertions.push(input)
        await new Promise<void>((resolve) => {
          resolvePermission = resolve
        })
      },
    },
  } as unknown as Pick<Plugin.Context, "tool" | "permission">
  await registerHandoffResultTool(context, (runID) => {
    reads++
    readIDs.push(runID)
    return { report, evidenceVerified: false }
  })
  const call = {
    agent: "orchestrator",
    sessionID: "session",
    messageID: "message",
    id: "call",
    signal: new AbortController().signal,
  } as Parameters<NonNullable<typeof tool>["execute"]>[1]
  let completed = false
  const mutableInput = { runID: "exact-run" }
  const pending = tool!.execute(mutableInput, call).then((value) => {
    completed = true
    return value
  })
  await Promise.resolve()
  expect(reads).toBe(0)
  expect(completed).toBe(false)
  mutableInput.runID = "different-unapproved-run"
  expect(assertions).toEqual([
    {
      sessionID: "session",
      agent: "orchestrator",
      source: { type: "tool", messageID: "message", id: "call" },
      action: "orchestration_result",
      resources: ["exact-run"],
      save: ["exact-run"],
    },
  ])
  resolvePermission()
  expect(JSON.stringify(await pending)).toContain("evidenceVerified")
  expect(reads).toBe(1)
  expect(readIDs).toEqual(["exact-run"])
})

test("denied, aborted or unsupported permission cannot read or return a handoff report", async () => {
  type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
  for (const kind of ["denied", "already-aborted", "pending-abort", "unsupported"] as const) {
    let tool: Parameters<Editor["add"]>[0] | undefined
    let reads = 0
    let asks = 0
    let release!: () => void
    const controller = new AbortController()
    const denied = new Error("Native permission rejected")
    const context = {
      tool: {
        transform: async (register: (editor: Editor) => void) => {
          register({
            add: (value: NonNullable<typeof tool>) => {
              tool = value
            },
          } as Editor)
          return { dispose: async () => {} }
        },
      },
      permission:
        kind === "unsupported"
          ? {}
          : {
              assert: async () => {
                asks++
                if (kind === "denied") throw denied
                if (kind === "pending-abort")
                  await new Promise<void>((resolve) => {
                    release = resolve
                  })
              },
            },
    } as unknown as Pick<Plugin.Context, "tool" | "permission">
    await registerHandoffResultTool(context, () => {
      reads++
      return { report }
    })
    const call = {
      agent: "orchestrator",
      sessionID: "session",
      messageID: "message",
      id: "call",
      signal: controller.signal,
    } as Parameters<NonNullable<typeof tool>["execute"]>[1]
    // Invalid role/input are refused before any permission evaluation.
    await tool!.execute({ runID: "run" }, { ...call, agent: "explorer" } as typeof call)
    await tool!.execute({ runID: "run", permissions: "allow" }, call)
    expect(asks).toBe(0)
    if (kind === "already-aborted") controller.abort(new Error("Call aborted"))
    const pending = tool!.execute({ runID: "run" }, call)
    if (kind === "pending-abort") {
      controller.abort(new Error("Call aborted"))
      release()
    }
    if (kind === "unsupported") {
      const refused = JSON.stringify(await pending)
      expect(refused).toContain("lacks permission.assert")
      expect(refused).not.toContain("Plugin summary")
    } else
      await expect(pending).rejects.toThrow(
        kind === "denied" ? "Native permission rejected" : "Call aborted",
      )
    expect(reads).toBe(0)
    expect(asks).toBe(kind === "already-aborted" || kind === "unsupported" ? 0 : 1)
  }
})
