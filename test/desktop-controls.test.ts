import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createDesktopControls, desktopReply, type DesktopHost } from "../src/desktop-controls.ts"
import { createExecutionEngine, type ExecutionHost } from "../src/execution.ts"
import { createExecutionCommands } from "../src/execution-commands.ts"
import { createRoutingCommands, type RoutingConfig } from "../src/routing.ts"
import { registerDesktopTools } from "../src/desktop-tools.ts"

const request = () => ({
  agent: "explorer",
  difficulty: "easy",
  handoff: {
    version: 1,
    objective: "Summarize explicit context without tools",
    files: [{ path: "README.md", content: "original" }],
    findings: [],
    constraints: ["No changes"],
    previousResults: [],
    acceptanceChecks: [],
  },
})
function fixture() {
  let tick = 1000
  let counter = 0
  let config: RoutingConfig = {
    version: 1,
    selections: { small: { providerID: "local", id: "small" } },
  }
  const prompts: string[] = []
  const writes: RoutingConfig[] = []
  const events: string[] = []
  const cancellations: string[] = []
  const models = ["small", "big"].map((id) => ({
    providerID: "local",
    id,
    enabled: true,
    variants: [],
    capabilities: ["text", "tools"] as const,
  }))
  const routing = createRoutingCommands({
    directory: "/project",
    list: async () => models,
    read: async () => structuredClone(config),
    write: async (_key, value) => {
      config = structuredClone(value)
      writes.push(structuredClone(value))
    },
    remove: async () => {
      config = { version: 1, selections: {} }
    },
  })
  const executionHost: ExecutionHost = {
    readConfig: routing.config,
    listModels: async () => models,
    createSession: async () => `child-${++counter}`,
    executeSession: async ({ task }) => {
      prompts.push(task)
      return {
        ok: true,
        text: JSON.stringify({
          version: 1,
          summary: "done",
          findings: [],
          evidence: [],
          checks: [],
          limitations: [],
        }),
      }
    },
    cancelSession: async (id) => {
      cancellations.push(id)
    },
    id: () => `engine-${++counter}`,
    now: () => tick,
  }
  const engine = createExecutionEngine(executionHost)
  const execution = createExecutionCommands(engine, {
    read: async () => undefined,
    write: async () => {},
  })
  const host: DesktopHost = {
    directory: "/project",
    routing,
    execution,
    engine,
    session: async (sessionID) => ({
      location: { directory: sessionID === "wrong-project" ? "/other" : "/project" },
    }),
    listModels: async () => models,
    changed: async (sessionID) => {
      events.push(sessionID)
    },
    id: () => `desktop-${++counter}`,
    now: () => tick,
  }
  const controls = createDesktopControls(host)
  return {
    controls,
    host,
    engine,
    execution,
    prompts,
    writes,
    events,
    cancellations,
    executionHost,
    advance: (duration: number) => {
      tick += duration
    },
  }
}
async function settled(f: ReturnType<typeof fixture>, runID: string) {
  for (let i = 0; i < 30 && f.engine.status(runID).state === "running"; i++) await Bun.sleep(1)
  expect(f.engine.status(runID).state).toBe("completed")
}

test("desktop proposal is immutable, owner-bound and cannot be used as a legacy approval ID", async () => {
  const f = fixture()
  const input = request()
  const preparing = f.controls.prepareHandoff("origin", input)
  input.handoff.files[0]!.content = "MUTATED"
  const ticket = await preparing
  expect(ticket.message).toContain("original")
  expect(ticket.message).not.toContain("MUTATED")
  expect(JSON.stringify(ticket)).not.toContain("planID")
  expect(() => f.engine.start(ticket.id, { approved: true })).toThrow()
  expect(f.prompts).toHaveLength(0)
  expect(f.writes).toHaveLength(0)
  expect(f.events).toEqual(["origin"])
  await expect(f.controls.review({ sessionID: "other", ticketID: ticket.id })).rejects.toThrow(
    "another chat",
  )
  await expect(
    f.controls.approve({ sessionID: "wrong-project", ticketID: ticket.id }),
  ).rejects.toThrow("another project")
  await expect(
    f.controls.approve({ sessionID: "origin", ticketID: ticket.id, message: "replacement" }),
  ).rejects.toThrow("Invalid")
  ticket.message = "MUTATED PREVIEW"
  expect((await f.controls.review({ sessionID: "origin", ticketID: ticket.id })).message).toContain(
    "original",
  )
  const approved = await f.controls.approve({ sessionID: "origin", ticketID: ticket.id })
  expect(approved.runID).toBeDefined()
  await settled(f, approved.runID!)
  expect(f.prompts[0]).toContain("original")
  expect(f.prompts[0]).not.toContain("MUTATED")
  expect((await f.controls.state({ sessionID: "origin" })).runs[0]?.state).toBe("completed")
  expect((await f.controls.run({ sessionID: "origin", runID: approved.runID })).result).toContain(
    '"evidenceVerified": false',
  )
  await expect(f.controls.run({ sessionID: "other", runID: approved.runID })).rejects.toThrow(
    "does not belong",
  )
  const count = f.prompts.length
  await f.controls.run({ sessionID: "origin", runID: approved.runID })
  expect(f.prompts).toHaveLength(count)
  await expect(f.controls.approve({ sessionID: "origin", ticketID: ticket.id })).rejects.toThrow(
    "already used",
  )
})

test("cancelled/expired/aborted desktop proposals never dispatch", async () => {
  const f = fixture()
  const first = await f.controls.prepareHandoff("origin", request())
  await f.controls.discard({ sessionID: "origin", ticketID: first.id })
  await expect(f.controls.approve({ sessionID: "origin", ticketID: first.id })).rejects.toThrow(
    "already used",
  )
  const second = await f.controls.prepareHandoff("origin", request())
  f.advance(10 * 60 * 1000)
  await expect(f.controls.approve({ sessionID: "origin", ticketID: second.id })).rejects.toThrow(
    "expired",
  )
  const third = await f.controls.prepareHandoff("origin", request())
  await expect(
    f.controls.approve({ sessionID: "origin", ticketID: third.id }, AbortSignal.abort()),
  ).rejects.toThrow()
  expect((await f.controls.state({ sessionID: "origin" })).pending).toHaveLength(1)
  await f.controls.dispose()
  expect((await f.controls.state({ sessionID: "origin" })).pending).toHaveLength(0)
  expect(f.prompts).toHaveLength(0)
})

test("aborting preparation discards its hidden engine plan and releases capacity", async () => {
  const f = fixture()
  const abort = new AbortController()
  const prepare = f.host.execution.prepareHandoff
  let planID = ""
  f.host.execution.prepareHandoff = async (text) => {
    const plan = await prepare(text)
    planID = plan.id
    abort.abort()
    return plan
  }
  await expect(f.controls.prepareHandoff("origin", request(), abort.signal)).rejects.toThrow()
  expect(() => f.engine.start(planID, { approved: true })).toThrow()
  expect((await f.controls.state({ sessionID: "origin" })).pending).toHaveLength(0)
  expect(f.prompts).toHaveLength(0)
})

test("model proposals validate and save only after GUI approval, with immutable selection", async () => {
  const f = fixture()
  const input = { sessionID: "origin", slot: "mid", selection: "local/big" }
  const pending = f.controls.proposeModel(input)
  input.selection = "local/small"
  const ticket = await pending
  expect(f.writes).toHaveLength(0)
  expect(ticket.message).toContain("local/big")
  await f.controls.approve({ sessionID: "origin", ticketID: ticket.id })
  expect(f.writes[0]?.selections).toEqual({
    small: { providerID: "local", id: "small" },
    mid: { providerID: "local", id: "big" },
  })
  const reset = await f.controls.proposeModel({ sessionID: "origin", slot: "mid", selection: null })
  await f.controls.approve({ sessionID: "origin", ticketID: reset.id })
  expect(f.writes[1]?.selections).toEqual({ small: { providerID: "local", id: "small" } })
  expect(f.prompts).toHaveLength(0)
  await expect(
    f.controls.proposeModel({ sessionID: "origin", slot: "mid", selection: "local/not-present" }),
  ).rejects.toThrow("unavailable")
  const models = await f.controls.models({ sessionID: "origin", query: "big", page: 1 })
  expect(models.models.map((model) => model.id)).toEqual(["local/big"])
})

test("parallel approval consumes a desktop ticket exactly once; notification failures never replay", async () => {
  const f = fixture()
  f.host.changed = async () => {
    throw new Error("disconnected")
  }
  const ticket = await f.controls.prepareHandoff("origin", request())
  const replies = await Promise.allSettled([
    f.controls.approve({ sessionID: "origin", ticketID: ticket.id }),
    f.controls.approve({ sessionID: "origin", ticketID: ticket.id }),
  ])
  expect(replies.filter((reply) => reply.status === "fulfilled")).toHaveLength(1)
  const approved = replies.find((reply) => reply.status === "fulfilled")!
  if (approved.status === "fulfilled") await settled(f, approved.value.runID!)
  expect(f.prompts).toHaveLength(1)
})

test("cancellation proposals do not interrupt until the exact GUI approval", async () => {
  const f = fixture()
  f.executionHost.executeSession = async ({ task, signal }) => {
    f.prompts.push(task)
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    )
    signal.throwIfAborted()
    throw new Error("unreachable")
  }
  const pending = await f.controls.prepareHandoff("origin", request())
  const run = await f.controls.approve({ sessionID: "origin", ticketID: pending.id })
  for (let i = 0; i < 30 && f.prompts.length === 0; i++) await Bun.sleep(1)
  expect(f.engine.status(run.runID!).state).toBe("running")
  const cancelledProposal = await f.controls.proposeCancel({
    sessionID: "origin",
    runID: run.runID,
  })
  await f.controls.discard({ sessionID: "origin", ticketID: cancelledProposal.id })
  expect(f.cancellations).toHaveLength(0)
  await expect(f.controls.proposeCancel({ sessionID: "other", runID: run.runID })).rejects.toThrow(
    "does not belong",
  )
  const exact = await f.controls.proposeCancel({ sessionID: "origin", runID: run.runID })
  expect(f.cancellations).toHaveLength(0)
  await f.controls.approve({ sessionID: "origin", ticketID: exact.id })
  expect(f.cancellations).toHaveLength(1)
  expect(f.engine.status(run.runID!).state).toBe("cancelled")
  expect(f.prompts).toHaveLength(1)
})

test("desktop state rejects malformed identity and caps pending work before generation", async () => {
  const f = fixture()
  for (const value of [
    {},
    { sessionID: "origin", extra: true },
    { sessionID: [] },
    { sessionID: "" },
  ])
    await expect(f.controls.state(value)).rejects.toThrow("Invalid")
  const created = await Promise.all(
    Array.from({ length: 10 }, () => f.controls.prepareHandoff("origin", request())),
  )
  await expect(f.controls.prepareHandoff("origin", request())).rejects.toThrow("Too many pending")
  expect((await f.controls.state({ sessionID: "origin" })).pending).toHaveLength(10)
  await f.controls.discard({ sessionID: "origin", ticketID: created[0]!.id })
  await f.controls.prepareHandoff("origin", request())
  expect(f.prompts).toHaveLength(0)
  await f.controls.dispose()
})

test("invalid handoffs and cross-project proposals produce portable errors without dispatch", async () => {
  const f = fixture()
  expect(
    await desktopReply(() =>
      f.controls.prepareHandoff("origin", { ...request(), permission: "allow" }),
    ),
  ).toMatchObject({ ok: false, error: { code: "routing.application" } })
  expect(
    await desktopReply(() => f.controls.prepareHandoff("wrong-project", request())),
  ).toMatchObject({ ok: false, error: { message: expect.stringContaining("another project") } })
  expect(f.prompts).toHaveLength(0)
  expect((await f.controls.state({ sessionID: "origin" })).pending).toHaveLength(0)
})

test("chat tools contain no approve/start/mutation authority even under stale default-allow profiles", async () => {
  type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
  type Definition = Parameters<Editor["add"]>[0]
  type Call = Parameters<Definition["execute"]>[1]
  const f = fixture()
  const definitions = new Map<string, Definition>()
  let disposed = false
  const registration = await registerDesktopTools(
    {
      tool: {
        transform: async (apply: (editor: Editor) => void) => {
          apply({
            add: (tool: Definition) => {
              definitions.set(tool.name, tool)
            },
          } as Editor)
          return {
            dispose: async () => {
              disposed = true
            },
          }
        },
      },
    } as unknown as Plugin.Context,
    f.controls,
  )
  expect([...definitions.keys()]).toEqual([
    "orchestration_prepare_handoff",
    "orchestration_prepare_model_change",
    "orchestration_prepare_cancel",
    "orchestration_desktop_status",
    "orchestration_project_models",
  ])
  const call = {
    sessionID: "origin",
    agent: "orchestrator",
    messageID: "message",
    id: "tool-call",
    signal: new AbortController().signal,
  } as Call
  const prepare = definitions.get("orchestration_prepare_handoff")!
  const result = await prepare.execute(request(), call)
  expect(JSON.parse(result.content as string).kind).toBe("handoff")
  await definitions
    .get("orchestration_prepare_model_change")!
    .execute({ slot: "mid", selection: "local/big" }, call)
  expect(f.prompts).toHaveLength(0)
  expect(f.writes).toHaveLength(0)
  expect(
    JSON.stringify(await prepare.execute(request(), { ...call, agent: "explorer" } as Call)),
  ).toContain("Only the orchestrator")
  expect(
    JSON.stringify(
      await definitions.get("orchestration_desktop_status")!.execute({ sessionID: "other" }, call),
    ),
  ).toContain("no arguments")
  expect(
    JSON.stringify(
      await definitions
        .get("orchestration_prepare_model_change")!
        .execute({ slot: "small", selection: null, sessionID: "other" }, call),
    ),
  ).toContain("only slot")
  await registration.dispose()
  await f.controls.dispose()
  expect(disposed).toBe(true)
})
