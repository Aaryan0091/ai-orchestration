import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import server from "../src/index.ts"

type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
type Tool = Parameters<Editor["add"]>[0]
type Call = Parameters<Tool["execute"]>[1]
type Handler = (input: unknown, call: { signal: AbortSignal }) => Promise<unknown>
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function handoff() {
  return {
    agent: "explorer",
    difficulty: "easy",
    handoff: {
      version: 1,
      objective: "Return DESKTOP_CHAT_OK without using tools",
      files: [],
      findings: ["Explicit marker: DESKTOP_CHAT_OK"],
      constraints: ["Do not read or change files"],
      previousResults: [],
      acceptanceChecks: ["Summary contains DESKTOP_CHAT_OK"],
    },
  }
}

async function setup() {
  const tools = new Map<string, Tool>()
  const handlers = new Map<string, Record<string, Handler>>()
  const saved = new Map<string, unknown>()
  const storageWrites: string[] = []
  const calls: { action: string; input?: unknown }[] = []
  const changed: { name: string; data: unknown }[] = []
  const disposed: string[] = []
  let child = 0
  const report = {
    version: 1,
    summary: "DESKTOP_CHAT_OK",
    findings: [],
    evidence: ["Supplied marker"],
    checks: [
      {
        check: "Summary contains DESKTOP_CHAT_OK",
        status: "passed",
        details: "Exact marker present",
      },
    ],
    limitations: ["Deterministic session fixture, not a model answer"],
  }
  const context = {
    options: {},
    location: { directory: "/integration-desktop" },
    storage: {
      get: async (key: string) => saved.get(key),
      set: async (key: string, value: unknown) => {
        storageWrites.push(key)
        saved.set(key, wire(value))
      },
      remove: async (key: string) => {
        storageWrites.push(key)
        saved.delete(key)
      },
    },
    model: {
      list: async () => ({
        data: [
          {
            providerID: "fixture",
            id: "small",
            enabled: true,
            variants: [],
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        ],
      }),
    },
    agent: { list: async () => ({ data: [{ id: "explorer" }] }) },
    tool: {
      transform: async (apply: (editor: Editor) => void) => {
        apply({ add: (tool: Tool) => tools.set(tool.name, tool) } as unknown as Editor)
        return {
          dispose: async () => {
            disposed.push("tools")
          },
        }
      },
    },
    session: {
      hook: async () => ({
        dispose: async () => {
          disposed.push("retry")
        },
      }),
      get: async ({ sessionID }: { sessionID: string }) =>
        sessionID.startsWith("child-")
          ? { outcome: "succeeded" }
          : {
              location: {
                directory:
                  sessionID === "wrong-project" ? "/another-project" : "/integration-desktop",
              },
            },
      create: async (input: unknown) => {
        calls.push({ action: "create", input: wire(input) })
        return { id: `child-${++child}` }
      },
      prompt: async (input: unknown) => {
        calls.push({ action: "prompt", input: wire(input) })
      },
      wait: async () => {
        calls.push({ action: "wait" })
      },
      context: async () => [
        {
          type: "assistant",
          finish: "stop",
          content: [{ type: "text", text: JSON.stringify(report) }],
        },
      ],
      interrupt: async () => {
        calls.push({ action: "interrupt" })
        return { interrupted: true }
      },
    },
    rpc: {
      register: async (definition: { id: string }, value: Record<string, Handler>) => {
        handlers.set(definition.id, value)
        return {
          events: {
            emit: async (name: string, data: unknown) => {
              changed.push({ name, data: wire(data) })
            },
          },
          dispose: async () => {
            disposed.push(definition.id)
          },
        }
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await server.setup(context)
  const call = {
    agent: "orchestrator",
    sessionID: "origin",
    messageID: "message",
    id: "call",
    signal: new AbortController().signal,
  } as Call
  return {
    tools,
    calls,
    changed,
    saved,
    storageWrites,
    disposed,
    cleanup,
    call,
    rpc: async (method: string, input: unknown, contract = "ai-orchestration.desktop") =>
      wire(
        await handlers.get(contract)![method]!(wire(input), {
          signal: new AbortController().signal,
        }),
      ) as Record<string, unknown>,
    tool: async (name: string, input: unknown, actor: Call = call) =>
      JSON.parse((await tools.get(name)!.execute(wire(input), actor)).content as string) as Record<
        string,
        unknown
      >,
  }
}

test("agent-facing orchestration tools stay on the native tool list instead of Code Mode", async () => {
  const f = await setup()
  try {
    // OpenCode 2.2.5 defaults unspecified tools to Code Mode. Direct calls
    // from the Orchestrator then fail even though the registry contains them.
    const nativeNames = [...f.tools.values()]
      .filter((tool) => tool.options?.codemode === false)
      .map((tool) => tool.name)
    expect(nativeNames.sort()).toEqual(
      [
        "orchestration_prepare_handoff",
        "orchestration_prepare_model_change",
        "orchestration_prepare_cancel",
        "orchestration_desktop_status",
        "orchestration_project_models",
        "orchestration_handoff_result",
        "orchestration_prepare_workflow",
      ].sort(),
    )
    expect(f.tools.get("orchestration_handoff_result")?.options?.permission).toBe(
      "orchestration_result",
    )
  } finally {
    await f.cleanup?.()
  }
})

test("server contract wiring: chat proposes, trusted desktop approval saves models and dispatches an isolated handoff", async () => {
  const f = await setup()
  try {
    expect(f.tools.has("orchestration_approve")).toBe(false)
    expect(f.tools.has("orchestration_start")).toBe(false)
    const modelTicket = await f.tool("orchestration_prepare_model_change", {
      slot: "small",
      selection: "fixture/small",
    })
    expect(f.calls).toEqual([])
    expect((await f.rpc("models", { sessionID: "origin" })).selections).toEqual({})
    await f.rpc("approve", { sessionID: "origin", ticketID: modelTicket.id })
    expect((await f.rpc("models", { sessionID: "origin" })).selections).toEqual({
      small: "fixture/small",
    })
    expect(f.calls).toEqual([])

    const declined = await f.tool("orchestration_prepare_handoff", handoff())
    expect(f.calls).toEqual([])
    await f.rpc("discard", { sessionID: "origin", ticketID: declined.id })
    expect(f.calls).toEqual([])
    const proposed = await f.tool("orchestration_prepare_handoff", handoff())
    const reviewed = await f.rpc("review", { sessionID: "origin", ticketID: proposed.id })
    expect(reviewed.message).toContain("DESKTOP_CHAT_OK")
    expect(JSON.stringify(reviewed)).not.toContain('"planID"')
    const bypass = await f.rpc("start", proposed.id, "ai-orchestration.routing")
    expect(bypass).toMatchObject({ ok: false })
    expect(f.calls).toEqual([])

    const approved = await f.rpc("approve", { sessionID: "origin", ticketID: proposed.id })
    let state: Record<string, unknown> = {}
    for (let i = 0; i < 30; i++) {
      state = await f.rpc("state", { sessionID: "origin" })
      if ((state.runs as { state: string }[])[0]?.state === "completed") break
      await Bun.sleep(1)
    }
    expect((state.runs as { state: string }[])[0]?.state).toBe("completed")
    expect(f.calls.map((entry) => entry.action)).toEqual(["create", "prompt", "wait"])
    expect(f.calls[0]?.input).toMatchObject({
      agent: "explorer",
      model: { providerID: "fixture", id: "small" },
      location: { directory: "/integration-desktop" },
    })
    expect(f.calls[1]?.input).toMatchObject({ text: expect.stringContaining("DESKTOP_CHAT_OK") })
    const result = await f.rpc("run", { sessionID: "origin", runID: approved.runID })
    expect(JSON.parse(result.result as string)).toMatchObject({
      state: "completed",
      report: { summary: "DESKTOP_CHAT_OK" },
      evidenceVerified: false,
    })
    await f.rpc("run", { sessionID: "origin", runID: approved.runID })
    await f.tool("orchestration_desktop_status", {})
    expect(f.calls.filter((entry) => entry.action === "prompt")).toHaveLength(1)
    expect(await f.rpc("approve", { sessionID: "origin", ticketID: proposed.id })).toMatchObject({
      ok: false,
    })
    expect(
      f.changed.every(
        ({ name, data }) => name === "changed" && JSON.stringify(data) === '{"sessionID":"origin"}',
      ),
    ).toBe(true)
  } finally {
    await f.cleanup?.()
  }
  expect(f.disposed).toContain("ai-orchestration.desktop")
  expect(f.disposed).toContain("ai-orchestration.workflow")
  expect(f.disposed).toContain("ai-orchestration.routing")
  expect(f.disposed).toContain("retry")
})

test("workflow proposals are routed drafts, scoped to the originating chat, and cannot run", async () => {
  const f = await setup()
  const workflow = "ai-orchestration.workflow"
  const origin = { sessionID: "origin" }
  const other = { sessionID: "other" }
  const request = {
    title: "Inspect and implement a change",
    steps: [
      {
        id: "implement",
        task: "Implement the proposed change",
        agent: "builder",
        difficulty: "medium",
        dependsOn: ["inspect"],
      },
      {
        id: "inspect",
        task: "Inspect the project",
        agent: "explorer",
        difficulty: "easy",
        dependsOn: [],
      },
    ],
  }
  try {
    const model = await f.rpc("proposeModel", {
      ...origin,
      slot: "small",
      selection: "fixture/small",
    })
    await f.rpc("approve", { ...origin, ticketID: model.id })
    const writes = [...f.storageWrites]
    const changes = f.changed.length
    const draft = await f.tool("orchestration_prepare_workflow", request)
    expect(draft.id as string).toMatch(/^workflow-/)
    expect(draft).toMatchObject({
      sessionID: "origin",
      directory: "/integration-desktop",
      title: request.title,
      steps: [
        { id: "inspect", difficulty: "easy", tier: "small", model: "fixture/small", dependsOn: [] },
        {
          id: "implement",
          difficulty: "medium",
          tier: "mid",
          blocker: "Select a mid model first.",
          dependsOn: ["inspect"],
        },
      ],
    })
    expect((draft.steps as Record<string, unknown>[])[1]).not.toHaveProperty("model")
    expect(await f.rpc("state", origin, workflow)).toMatchObject({ drafts: [draft] })
    expect(await f.rpc("state", other, workflow)).toMatchObject({ drafts: [] })
    expect(await f.rpc("state", { sessionID: "wrong-project" }, workflow)).toMatchObject({
      ok: false,
    })
    expect(await f.rpc("state", origin)).toMatchObject({ pending: [], runs: [] })
    expect(await f.rpc("discard", { ...other, draftID: draft.id }, workflow)).toMatchObject({
      ok: false,
    })
    expect(await f.rpc("approve", { ...origin, ticketID: draft.id })).toMatchObject({ ok: false })
    expect(await f.rpc("start", draft.id, "ai-orchestration.routing")).toMatchObject({ ok: false })
    expect(f.calls).toEqual([])
    expect(f.storageWrites).toEqual(writes)

    const revision = await f.tool("orchestration_prepare_workflow", {
      ...request,
      title: "Revised workflow",
    })
    expect(revision.id).not.toBe(draft.id)
    expect(await f.rpc("state", origin, workflow)).toMatchObject({ drafts: [revision, draft] })
    expect(await f.rpc("discard", { ...origin, draftID: draft.id }, workflow)).toEqual({
      id: draft.id,
    })
    expect(await f.rpc("state", origin, workflow)).toMatchObject({ drafts: [revision] })
    expect(f.changed.slice(changes)).toEqual(
      Array.from({ length: 3 }, () => ({ name: "changed", data: { sessionID: "origin" } })),
    )
    expect(f.calls).toEqual([])
    expect(f.storageWrites).toEqual(writes)
  } finally {
    await f.cleanup?.()
  }
})

test("workflow native tool rejects malformed inputs, other roles, and aborted calls", async () => {
  const f = await setup()
  const name = "orchestration_prepare_workflow"
  const step = { id: "inspect", task: "Inspect the project", agent: "explorer", dependsOn: [] }
  const request = { title: "Inspect project", steps: [step] }
  try {
    for (const input of [
      { ...request, sessionID: "other" },
      { ...request, steps: [{ ...step, model: "fixture/small" }] },
      { ...request, steps: [{ ...step, dependsOn: ["unknown"] }] },
      { ...request, steps: [] },
    ])
      expect(await f.tool(name, input)).toMatchObject({ ok: false })
    for (const actor of [
      { ...f.call, agent: "explorer" },
      { ...f.call, sessionID: "wrong-project" },
      { ...f.call, signal: AbortSignal.abort() },
    ])
      expect(await f.tool(name, request, actor as Call)).toMatchObject({ ok: false })
    expect(
      await f.rpc("state", { sessionID: "origin" }, "ai-orchestration.workflow"),
    ).toMatchObject({ drafts: [] })
    expect(f.changed).toEqual([])
    expect(f.calls).toEqual([])
    expect(f.storageWrites).toEqual(["foundation"])
  } finally {
    await f.cleanup?.()
  }
})

test("desktop RPC and tool trust boundaries reject replacement identity, cross-chat use and malformed payloads", async () => {
  const f = await setup()
  try {
    const ticket = await f.rpc("proposeModel", {
      sessionID: "origin",
      slot: "small",
      selection: "fixture/small",
    })
    for (const input of [
      { sessionID: "other", ticketID: ticket.id },
      { sessionID: "wrong-project", ticketID: ticket.id },
      { sessionID: "origin", ticketID: ticket.id, selection: "fixture/unapproved" },
    ])
      expect(await f.rpc("approve", input)).toMatchObject({ ok: false })
    expect((await f.rpc("models", { sessionID: "origin" })).selections).toEqual({})
    expect(
      await f.tool("orchestration_prepare_model_change", {
        slot: "small",
        selection: "fixture/small",
        sessionID: "other",
      }),
    ).toMatchObject({ ok: false })
    expect(
      await f.tool("orchestration_prepare_handoff", handoff(), {
        ...f.call,
        agent: "explorer",
      } as Call),
    ).toMatchObject({ ok: false })
    expect(await f.rpc("state", { sessionID: "origin", arbitrary: true })).toMatchObject({
      ok: false,
    })
    expect(f.calls).toEqual([])
    expect((await f.rpc("state", { sessionID: "origin" })).pending).toHaveLength(1)
  } finally {
    await f.cleanup?.()
  }
})
