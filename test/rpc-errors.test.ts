import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"
import server from "../src/index.ts"
import tui from "../src/tui.ts"
import { routingReply, safeApplicationMessage, unwrapRoutingReply } from "../src/rpc.ts"

const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

test("application errors survive a JSON-only RPC boundary without raw provider details", async () => {
  const reply = wire(
    await routingReply(async () => {
      throw new Error("Select a small model first.")
    }),
  )
  expect(reply).toEqual({
    ok: false,
    error: {
      code: "routing.application",
      message: expect.stringContaining("/orchestration-models set small"),
    },
  })
  expect(() => unwrapRoutingReply(reply)).toThrow("Select the small model first")
  for (const error of [
    new Error("Authorization: Bearer secret-value"),
    { message: "API key secret-value", data: { authorization: "Bearer secret-value" } },
    { error: { message: "secret-value", apiKey: "secret-value" } },
  ]) {
    const result = wire(
      await routingReply(async () => {
        throw error
      }),
    )
    expect(JSON.stringify(result)).not.toContain("secret-value")
    expect(JSON.stringify(result)).toContain("Routing operation failed")
  }
  expect(
    safeApplicationMessage(
      new Error("Model unavailable: API_KEY=secret-value. Run /orchestration-models list."),
    ),
  ).not.toContain("secret-value")
  expect(wire(await routingReply(async () => "Routing error: Invalid model variant."))).toEqual({
    ok: false,
    error: { code: "routing.application", message: "Invalid model variant." },
  })
})

test("malformed or errored approval replies never become successful plans", () => {
  for (const reply of [
    { ok: true, id: "bad", message: "bad" },
    { ok: false, error: "invalid" },
    { ok: false, error: { code: "wrong", message: "invalid" } },
  ])
    expect(() => unwrapRoutingReply(wire(reply))).toThrow()
})

test("all server RPC handlers return portable application failures, not opaque exceptions", async () => {
  let handlers: Record<string, (input: string, call: { signal: AbortSignal }) => Promise<unknown>> =
    {}
  const saved = new Map<string, unknown>()
  const cleanup = await server.setup({
    tool: { transform: async () => ({ dispose: async () => {} }) },
    location: { directory: "/rpc-errors" },
    options: {},
    storage: {
      get: async (key: string) => saved.get(key),
      set: async (key: string, value: unknown) => {
        saved.set(key, value)
      },
      remove: async (key: string) => {
        saved.delete(key)
      },
    },
    session: { hook: async () => ({ dispose: async () => {} }) },
    model: { list: async () => ({ data: [] }) },
    rpc: {
      register: async (_: unknown, value: typeof handlers) => {
        handlers = value
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context)
  try {
    for (const [method, input] of [
      ["models", "set"],
      ["route", "easy read README"],
      ["prepare", "easy read README"],
      ["handoff", 'run {"permissions":"allow"}'],
      ["handoff", "wrong"],
      ["start", "unknown"],
      ["run", "status unknown"],
      ["policy", "wrong"],
    ]) {
      const reply = wire(
        await handlers[method!]?.(input!, { signal: new AbortController().signal }),
      )
      expect(reply).toMatchObject({
        ok: false,
        error: { code: "routing.application", message: expect.any(String) },
      })
      expect(JSON.stringify(reply)).not.toContain("Request failed")
    }
    expect(
      typeof (await handlers.discard?.("unknown", { signal: new AbortController().signal })),
    ).toBe("string")
  } finally {
    await cleanup?.()
  }
})

test("server releases result tool and retry guard on registration failure or cleanup failure", async () => {
  for (const failRegistration of [true, false]) {
    const disposed: string[] = []
    const context = {
      location: { directory: "/cleanup" },
      options: {},
      storage: { set: async () => {}, get: async () => undefined },
      session: {
        hook: async () => ({
          dispose: async () => {
            disposed.push("retry")
          },
        }),
      },
      tool: {
        transform: async () => ({
          dispose: async () => {
            disposed.push("result-tool")
          },
        }),
      },
      rpc: {
        register: async () => {
          if (failRegistration) throw new Error("registration failed")
          return {
            dispose: async () => {
              disposed.push("rpc")
              throw new Error("cleanup failed")
            },
          }
        },
      },
    } as unknown as Plugin.Context
    if (failRegistration) await expect(server.setup(context)).rejects.toThrow("registration failed")
    else {
      const cleanup = await server.setup(context)
      await expect(cleanup?.()).rejects.toThrow("cleanup failed")
    }
    expect(disposed).toEqual(
      failRegistration ? ["result-tool", "retry"] : ["rpc", "result-tool", "retry"],
    )
  }
})

test("TUI shows serialized validation errors before approval and hides raw transport errors", async () => {
  type Layer = ReturnType<Parameters<TuiPlugin.Context["keymap"]["layer"]>[0]>
  let layer: Layer = {}
  const alerts: { title: string; message: string }[] = []
  let confirms = 0
  let starts = 0
  let failTransport = false
  await tui.setup({
    options: { notifyOnLoad: false },
    location: { directory: "/rpc-errors" },
    keymap: {
      layer: (get: () => Layer) => {
        layer = get()
      },
    },
    ui: {
      router: { current: () => ({ type: "home" }) },
      dialog: {
        alert: async (alert: (typeof alerts)[number]) => {
          alerts.push(alert)
        },
        confirm: async () => {
          confirms++
          return true
        },
      },
    },
    client: {
      rpc: () => ({
        prepare: async () => {
          if (failTransport)
            throw wire({ type: "rpc.internal", message: "Authorization Bearer secret-value" })
          return wire(
            await routingReply(async () => {
              throw new Error("Select a small model first.")
            }),
          )
        },
        route: async () =>
          wire(
            await routingReply(async () => {
              throw new Error("Select a small model first.")
            }),
          ),
        start: async () => {
          starts++
          return "should not run"
        },
      }),
    },
  } as unknown as TuiPlugin.Context)
  await layer.commands?.[1]?.run("/orchestration-route easy read README")
  await layer.commands?.[2]?.run("/orchestration-run easy read README")
  expect(alerts).toHaveLength(2)
  expect(alerts[0]).toMatchObject({
    title: "Routing error",
    message: expect.stringContaining("set small"),
  })
  expect(confirms).toBe(0)
  expect(starts).toBe(0)
  failTransport = true
  await layer.commands?.[2]?.run("/orchestration-run easy read README")
  expect(alerts[2]).toMatchObject({
    title: "Routing unavailable",
    message: expect.stringContaining("RPC request"),
  })
  expect(JSON.stringify(alerts)).not.toContain("secret-value")
  expect(confirms).toBe(0)
  expect(starts).toBe(0)
})
