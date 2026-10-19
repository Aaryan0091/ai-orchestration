import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import server from "../src/index.ts"
import tui from "../src/tui.ts"
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui"
import { commandArguments } from "../src/rpc.ts"
import {
  createRoutingCommands,
  parseSelection,
  restoreConfig,
  type ModelCandidate,
  type RoutingConfig,
  validateSelection,
} from "../src/routing.ts"

test("observed big-pickle restriction is rejected without excluding unrelated local free models", () => {
  expect(() =>
    validateSelection({ providerID: "opencode", id: "big-pickle" }, [
      { providerID: "opencode", id: "big-pickle", enabled: true, variants: [] },
    ]),
  ).toThrow("cannot run our custom agents")
  expect(() =>
    validateSelection({ providerID: "local", id: "free" }, [
      { providerID: "local", id: "free", enabled: true, variants: [] },
    ]),
  ).not.toThrow()
})

const models: ModelCandidate[] = [
  { providerID: "openrouter", id: "vendor/small", enabled: true, variants: [{ id: "low" }] },
  { providerID: "local", id: "mid", enabled: true, variants: [] },
  { providerID: "local", id: "big", enabled: true, variants: [] },
  { providerID: "local", id: "disabled", enabled: false, variants: [] },
  { providerID: "opencode", id: "example-free", enabled: true, variants: [] },
]
function fixture() {
  const saved = new Map<string, unknown>()
  const commands = (directory = "/project/a") =>
    createRoutingCommands({
      directory,
      list: async () => models,
      read: async (key) => saved.get(key),
      write: async (key, config: RoutingConfig) => {
        saved.set(key, structuredClone(config))
      },
      remove: async (key) => {
        saved.delete(key)
      },
    })
  return { saved, commands }
}

describe("task model routing", () => {
  test("inventory pages preserve full IDs and mark ineligible models", async () => {
    const { commands } = fixture()
    const first = await commands().models("list")
    const second = await commands().models("list 2")
    expect(first).toContain("page 1/2")
    expect(first).toContain("Next: /orchestration-models list 2")
    expect(second).toContain("openrouter/vendor/small")
    expect(first + second).toContain("[ineligible for custom agents]")
    expect(await commands().models("list 99")).toContain("Choose a page from 1 to 2")
    expect(await commands().models("list -1")).toStartWith("Routing error:")
  })
  test("restores selections without leaking across projects or overwriting on construction", async () => {
    const { commands, saved } = fixture()
    expect(saved.size).toBe(0)
    expect(await commands().models("")).toContain("small: not selected")
    await commands().models("set small openrouter/vendor/small#low")
    expect(await commands().models("show")).toContain("small: openrouter/vendor/small#low")
    expect(await commands("/project/b").models("show")).toContain("small: not selected")
    expect(saved.size).toBe(1)
    expect(parseSelection("openrouter/vendor/small#low")).toEqual({
      providerID: "openrouter",
      id: "vendor/small",
      variant: "low",
    })
  })
  test("rejects unavailable, disabled, free and invented variants without saving", async () => {
    const { commands, saved } = fixture()
    for (const id of [
      "unknown/nope",
      "local/disabled",
      "opencode/example-free",
      "openrouter/vendor/small#invented",
    ]) {
      expect(await commands().models(`set small ${id}`)).toStartWith("Routing error:")
    }
    expect(saved.size).toBe(0)
  })
  test("routes by difficulty, uses explicit overrides and leaves saved selections unchanged", async () => {
    const { commands } = fixture()
    const command = commands()
    await command.models("set small openrouter/vendor/small")
    await command.models("set mid local/mid")
    await command.models("set big local/big")
    await command.models("set orchestrator local/mid")
    for (const [difficulty, model] of [
      ["easy", "openrouter/vendor/small"],
      ["medium", "local/mid"],
      ["hard", "local/big"],
    ]) {
      expect(await command.route(`${difficulty} inspect code`)).toContain(`Model: ${model}`)
    }
    expect(await command.route("easy --model local/big inspect code")).toContain(
      "Model: local/big (explicit override)",
    )
    expect(await command.models("show")).toContain("small: openrouter/vendor/small")
    expect(await command.route("easy --model unknown/model inspect")).toContain("Model unavailable")
    expect(await command.route("unknown inspect")).toContain("Specify easy, medium or hard")
  })
  test("rechecks saved model availability and exposes explicit reset recovery", async () => {
    const { commands, saved } = fixture()
    await commands().models("set small local/mid")
    const key = [...saved.keys()][0] as string
    saved.set(key, { version: 1, selections: { small: { providerID: "missing", id: "model" } } })
    expect(await commands().models("show")).toContain("Model unavailable")
    expect(await commands().route("easy inspect")).toContain("Model unavailable")
    saved.set(key, { version: 2, selections: {} })
    expect(await commands().models("show")).toContain("Unsupported saved routing settings")
    expect(saved.get(key)).toEqual({ version: 2, selections: {} })
    await commands().models("reset")
    expect(await commands().models("show")).toContain("small: not selected")
    expect(() => restoreConfig(null)).toThrow()
  })
  test("simultaneous updates preserve slots and invalid syntax makes no changes", async () => {
    const { commands, saved } = fixture()
    const command = commands()
    await Promise.all([command.models("set small local/mid"), command.models("set big local/big")])
    const output = await command.models("show")
    expect(output).toContain("small: local/mid")
    expect(output).toContain("big: local/big")
    const before = structuredClone([...saved])
    expect(await command.models("reset small extra")).toStartWith("Routing error")
    expect(await command.route("easy --model local/big")).toStartWith("Routing error")
    expect([...saved]).toEqual(before)
  })
})

test("RPC and TUI commands display output without dispatching or switching models", async () => {
  type Layer = ReturnType<Parameters<TuiPlugin.Context["keymap"]["layer"]>[0]>
  let layer: Layer = {}
  let handlers:
    | {
        models: (input: unknown, call: { signal: AbortSignal }) => Promise<unknown>
        route: (input: unknown, call: { signal: AbortSignal }) => Promise<unknown>
      }
    | undefined
  const output: { title: string; message: string }[] = []
  const locations: unknown[] = []
  const saved = new Map<string, unknown>()
  let disposed = false
  let hookDisposed = false
  // This deliberately narrow integration fake fails if production touches a generation API.
  const context = {
    location: { directory: "/integration" },
    options: {},
    session: {
      hook: async () => ({
        dispose: async () => {
          hookDisposed = true
        },
      }),
    },
    storage: {
      get: async (key: string) => saved.get(key),
      set: async (key: string, value: unknown) => {
        saved.set(key, value)
      },
      remove: async (key: string) => {
        saved.delete(key)
      },
    },
    model: {
      list: async () => ({
        data: models.map((model) => ({
          ...model,
          capabilities: { tools: true, input: ["text"], output: ["text"] },
        })),
      }),
    },
    rpc: {
      register: async (_definition: unknown, value: NonNullable<typeof handlers>) => {
        handlers = value
        return {
          dispose: async () => {
            disposed = true
          },
        }
      },
    },
  } as unknown as Plugin.Context
  const cleanup = await server.setup(context)
  await tui.setup({
    options: { notifyOnLoad: false },
    location: { directory: "/other-project" },
    keymap: {
      layer: (get: () => Layer) => {
        layer = get()
      },
    },
    data: { session: { get: () => ({ location: { directory: "/integration" } }) } },
    client: {
      rpc: () =>
        Object.fromEntries(
          (["models", "route"] as const).map((method) => [
            method,
            (input: unknown, options: { location: unknown; signal: AbortSignal }) => {
              locations.push(options.location)
              return handlers?.[method](input, options)
            },
          ]),
        ),
    },
    ui: {
      router: { current: () => ({ type: "session", sessionID: "session-test" }) },
      dialog: {
        alert: async (value: { title: string; message: string }) => {
          output.push(value)
        },
      },
    },
  } as unknown as TuiPlugin.Context)
  expect(layer.commands?.map((item) => item.slash?.name)).toEqual([
    "orchestration-models",
    "orchestration-route",
    "orchestration-run",
    "orchestration-policy",
  ])
  await layer.commands?.[0]?.run("/orchestration-models set small openrouter/vendor/small")
  await layer.commands?.[1]?.run("/orchestration-route easy explain bun test --coverage")
  expect(output).toHaveLength(2)
  expect(locations).toEqual([{ directory: "/integration" }, { directory: "/integration" }])
  expect(output[1]).toMatchObject({
    title: "AI Orchestration",
    message: expect.stringContaining("Routing preview only"),
  })
  await cleanup?.()
  expect(disposed).toBe(true)
  expect(hookDisposed).toBe(true)
})

test("cancelled configuration never changes saved selections", async () => {
  const { commands, saved } = fixture()
  const signal = AbortSignal.abort(new Error("Cancelled"))
  expect(await commands().models("set small local/mid", signal)).toContain("Cancelled")
  expect(saved.size).toBe(0)
})

test("TUI arguments normalize slash input without changing task text", () => {
  expect(commandArguments("orchestration-models", "/orchestration-models")).toBe("")
  expect(
    commandArguments("orchestration-route", "/orchestration-route easy inspect --coverage"),
  ).toBe("easy inspect --coverage")
  expect(commandArguments("orchestration-route", "easy inspect")).toBe("easy inspect")
})
