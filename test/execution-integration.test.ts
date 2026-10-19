import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { createExecutionEngine } from "../src/execution.ts"
import {
  createExecutionCommands,
  parseExecutionRequest,
  restorePolicy,
} from "../src/execution-commands.ts"
import { createSessionAdapter } from "../src/session-adapter.ts"
import tui from "../src/tui.ts"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"

function fixture() {
  const calls: string[] = []
  let outcome = "succeeded"
  let finish = "stop"
  let tool = false
  let waitError = false
  const context = {
    location: { directory: "/test-project" },
    model: {
      list: async () => ({
        data: [
          {
            providerID: "local",
            id: "small",
            enabled: true,
            variants: [{ id: "low" }],
            capabilities: { tools: true, input: ["text"], output: ["text"] },
          },
        ],
      }),
    },
    agent: { list: async () => ({ data: [{ id: "explorer" }] }) },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      create: async (input: unknown) => {
        calls.push("create")
        expect(input).toMatchObject({
          agent: "explorer",
          model: { providerID: "local", id: "small" },
          location: { directory: "/test-project" },
        })
        return { id: "child-1" }
      },
      prompt: async () => {
        calls.push("prompt")
      },
      wait: async () => {
        calls.push("wait")
        if (waitError) throw new Error("Network wait failed")
      },
      get: async () => ({ outcome }),
      context: async () => [
        {
          type: "assistant",
          finish,
          content: [{ type: "text", text: "done" }, ...(tool ? [{ type: "tool" }] : [])],
        },
      ],
      interrupt: async () => {
        calls.push("interrupt")
        outcome = "interrupted"
        waitError = false
        return { interrupted: true }
      },
    },
  } as unknown as Plugin.Context
  const adapter = createSessionAdapter(context, async () => ({
    version: 1,
    selections: { small: { providerID: "local", id: "small" } },
  }))
  const engine = createExecutionEngine(adapter)
  let policy: unknown
  const commands = createExecutionCommands(engine, {
    read: async () => policy,
    write: async (value) => {
      policy = structuredClone(value)
    },
  })
  return {
    calls,
    adapter,
    commands,
    engine,
    change: (values: {
      outcome?: string
      finish?: string
      tool?: boolean
      waitError?: boolean
    }) => {
      outcome = values.outcome ?? outcome
      finish = values.finish ?? finish
      tool = values.tool ?? tool
      waitError = values.waitError ?? waitError
    },
  }
}

test("real adapter API shape: preview and denied approval never prompt, approved run uses isolated session", async () => {
  const f = fixture()
  expect(await f.commands.preview("auto read README")).toContain("no agents started")
  expect(f.calls).toEqual([])
  const cancelled = await f.commands.prepare("easy read README")
  await f.commands.discard(cancelled.id)
  expect(() => f.engine.start(cancelled.id, { approved: true })).toThrow()
  expect(f.calls).toEqual([])
  const prepared = await f.commands.prepare("auto read README")
  await f.commands.start(prepared.id)
  for (let i = 0; i < 20 && f.engine.status(prepared.id).state === "running"; i++)
    await new Promise((resolve) => setTimeout(resolve, 1))
  expect(f.engine.status(prepared.id).state).toBe("completed")
  expect(f.calls).toEqual(["create", "prompt", "wait"])
  expect(await f.commands.runCommand(`status ${prepared.id}`)).toContain("child-1")
})

test("truncation does not mean success; tool-bearing attempts never safely retry", async () => {
  const f = fixture()
  f.change({ finish: "length" })
  expect(
    await f.adapter.executeSession({
      sessionID: "child-1",
      task: "read",
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ ok: false, failure: "model", safeToRetry: false })
  f.change({ tool: true })
  expect(
    await f.adapter.executeSession({
      sessionID: "child-1",
      task: "read",
      signal: new AbortController().signal,
    }),
  ).toMatchObject({ ok: false, safeToRetry: false })
  f.change({ finish: "content-filter" })
  expect(
    (
      await f.adapter.executeSession({
        sessionID: "child-1",
        task: "read",
        signal: new AbortController().signal,
      })
    ).ok,
  ).toBe(false)
})

test("wait failure explicitly interrupts; cancellation proves idle outcome", async () => {
  const f = fixture()
  f.change({ waitError: true })
  await expect(
    f.adapter.executeSession({
      sessionID: "child-1",
      task: "read",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Network wait failed")
  expect(f.calls).toContain("interrupt")
  await f.adapter.cancelSession("child-1")
  expect(f.calls.slice(-2)).toEqual(["interrupt", "wait"])
})

test("optional policies persist, default off, invalid nested policy rejects", async () => {
  const f = fixture()
  expect(await f.commands.policy("show")).toContain("{}")
  await f.commands.policy("reasoning easy low")
  await f.commands.policy("fallback small local/small")
  await f.commands.policy("escalation on")
  await f.commands.policy("retries 1")
  expect(await f.commands.policy("show")).toContain('"maxRetries": 1')
  expect((await f.commands.prepare("easy read README")).message).toContain("local/small#low")
  await f.commands.policy("reset")
  expect(await f.commands.policy("show")).toContain("{}")
  await expect(f.commands.policy("retries 99")).rejects.toThrow()
  for (const options of [
    { reasoningVariants: "low" },
    { sameTierFallbacks: [] },
    { sameTierFallbacks: { small: [null] } },
  ])
    expect(() => restorePolicy({ version: 1, options })).toThrow()
  expect(
    parseExecutionRequest("auto --agent explorer --model local/small read --coverage"),
  ).toMatchObject({ task: "read --coverage", agent: "explorer" })
  expect(() => parseExecutionRequest("auto --agent explorer --agent builder read")).toThrow()
})

test("terminal confirmation dispatches only on explicit Run; cancel/escape dispatch nothing", async () => {
  type Layer = ReturnType<Parameters<TuiPlugin.Context["keymap"]["layer"]>[0]>
  for (const approved of [false, undefined, true]) {
    let layer: Layer = {}
    const calls: string[] = []
    await tui.setup({
      options: { notifyOnLoad: false },
      location: { directory: "/project" },
      keymap: {
        layer: (get: () => Layer) => {
          layer = get()
        },
      },
      client: {
        rpc: () => ({
          prepare: async () => {
            calls.push("prepare")
            return { id: "ticket", message: "Exact model approval" }
          },
          start: async (id: string) => {
            expect(id).toBe("ticket")
            calls.push("start")
            return "running"
          },
          discard: async () => {
            calls.push("discard")
            return "cancelled"
          },
        }),
      },
      ui: {
        router: { current: () => ({ type: "home" }) },
        dialog: { confirm: async () => approved, alert: async () => undefined },
      },
    } as unknown as TuiPlugin.Context)
    await layer.commands
      ?.find((command) => command.slash?.name === "orchestration-run")
      ?.run("/orchestration-run auto read README")
    expect(calls).toEqual(["prepare", approved === true ? "start" : "discard"])
  }
})

test("image generation rejects locally while text diagrams remain supported", async () => {
  const f = fixture()
  await expect(f.commands.preview("easy generate an image of a cat")).rejects.toThrow(
    "Image generation is not supported",
  )
  expect(await f.commands.preview("easy explain an ASCII diagram")).toContain(
    "Routing preview only",
  )
  expect(f.calls).toEqual([])
})

test("an interrupt response without proven idle reports uncertain stop", async () => {
  const context = {
    location: { directory: "/test" },
    session: {
      prompt: async () => undefined,
      wait: async () => {
        throw new Error("wait failed")
      },
      interrupt: async () => ({ interrupted: true }),
      get: async () => ({}),
    },
  } as unknown as Plugin.Context
  const adapter = createSessionAdapter(context, async () => ({ version: 1, selections: {} }))
  await expect(
    adapter.executeSession({
      sessionID: "uncertain",
      task: "read",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Stop not confirmed for session uncertain")
})

test("known never-prompted child can cancel with idle wait and empty context without outcome", async () => {
  const calls: string[] = []
  const context = {
    location: { directory: "/test" },
    agent: { list: async () => ({ data: [{ id: "explorer" }] }) },
    session: {
      hook: async () => ({ dispose: async () => undefined }),
      create: async () => {
        calls.push("create")
        return { id: "fresh" }
      },
      interrupt: async () => {
        calls.push("interrupt")
        return { interrupted: false }
      },
      wait: async () => {
        calls.push("wait")
      },
      get: async () => ({}),
      context: async () => [],
    },
  } as unknown as Plugin.Context
  const adapter = createSessionAdapter(context, async () => ({ version: 1, selections: {} }))
  const id = await adapter.createSession({
    agent: "explorer",
    model: { providerID: "local", id: "small" },
    signal: new AbortController().signal,
  })
  await adapter.cancelSession(id)
  expect(calls).toEqual(["create", "interrupt", "wait"])
  expect(calls).not.toContain("prompt")
})

for (const [status, message] of [
  [429, "You exceeded your current quota. Retry in 51 seconds."],
  [503, "This model is currently experiencing high demand."],
] as const)
  test(`provider ${status}: only owned children suppress hidden retries; terminal proof precedes failed state`, async () => {
    type Retry = {
      sessionID: string
      decision: { retry: boolean; delay?: number }
    }
    let retryHook: ((input: Retry) => void) | undefined
    let releaseWait!: () => void
    let prompted!: () => void
    const promptSeen = new Promise<void>((resolve) => {
      prompted = resolve
    })
    const finished = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    const calls: string[] = []
    let outcome: "failed" | undefined
    let decision: Retry | undefined
    const context = {
      location: { directory: "/quota-test" },
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
      session: {
        hook: async (name: string, callback: (input: Retry) => void) => {
          expect(name).toBe("retry")
          calls.push("hook")
          retryHook = callback
          return {
            dispose: async () => {
              calls.push("dispose")
            },
          }
        },
        create: async () => {
          calls.push("create")
          return { id: "owned" }
        },
        prompt: async () => {
          calls.push("prompt")
          decision = { sessionID: "owned", decision: { retry: true, delay: 51000 } }
          retryHook!(decision)
          prompted()
        },
        wait: async () => {
          calls.push("wait")
          await finished
          outcome = "failed"
        },
        get: async () => ({ outcome }),
        context: async () => [
          {
            type: "assistant",
            content: [],
            error: { type: "provider", message, status },
          },
        ],
      },
    } as unknown as Plugin.Context
    const adapter = createSessionAdapter(context, async () => ({
      version: 1,
      selections: { small: { providerID: "fixture", id: "small" } },
    }))
    await adapter.initialize()
    await adapter.initialize()
    const engine = createExecutionEngine(adapter)
    const plan = await engine.preview({ task: "read README", difficulty: "easy" })
    engine.start(plan.id, { approved: true })
    await promptSeen
    expect(decision?.decision).toEqual({ retry: false })
    const originalChat: Retry = { sessionID: "user-chat", decision: { retry: true, delay: 51000 } }
    retryHook!(originalChat)
    expect(originalChat.decision).toEqual({ retry: true, delay: 51000 })
    const before = [...calls]
    // Status is read-only and cannot claim failure until OpenCode finishes.
    expect(engine.status(plan.id).state).toBe("running")
    expect(engine.status(plan.id).state).toBe("running")
    expect(calls).toEqual(before)
    releaseWait()
    for (let i = 0; i < 30 && engine.status(plan.id).state === "running"; i++)
      await new Promise((resolve) => setTimeout(resolve, 1))
    expect(engine.status(plan.id)).toMatchObject({ state: "failed", result: message })
    expect(engine.status(plan.id).attempts).toHaveLength(1)
    expect(calls.filter((call) => call === "prompt")).toHaveLength(1)
    // A finished child's future manual use is not controlled by this run.
    const finishedChild: Retry = { sessionID: "owned", decision: { retry: true, delay: 1000 } }
    retryHook!(finishedChild)
    expect(finishedChild.decision.retry).toBe(true)
    await adapter.dispose()
    expect(calls.filter((call) => call === "hook")).toHaveLength(1)
    expect(calls.at(-1)).toBe("dispose")
  })

test("wait without a terminal outcome is uncertain, not a failed replayable attempt", async () => {
  const f = fixture()
  f.change({ outcome: "" })
  await expect(
    f.adapter.executeSession({
      sessionID: "child-1",
      task: "read",
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("Stop not confirmed")
})
