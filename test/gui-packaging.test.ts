import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { runInNewContext } from "node:vm"

const root = join(import.meta.dir, "..")

test("GUI ships one host-shared CJS entry without removing server/TUI builds", async () => {
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: root })
  expect(build.exitCode).toBe(0)
  const pkg = await Bun.file(join(root, "package.json")).json()
  expect(pkg.exports["./gui-experimental"]).toBe("./dist/gui-experimental.cjs")
  expect(pkg.dependencies["@opencode/plugin"]).toBe("2.2.0")
  for (const name of ["index.js", "tui.js", "gui-experimental.cjs"])
    expect(await Bun.file(join(root, "dist", name)).exists()).toBe(true)

  const code = await readFile(join(root, "dist/gui-experimental.cjs"), "utf8")
  const required = [...code.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
  expect([...new Set(required)].sort()).toEqual([
    "@opencode/plugin/gui",
    "@opencode/plugin/rpc",
    "solid-js",
    "solid-js/web",
  ])
  // Exercise the actual prebuilt entry's native registration with host stubs.
  // This is a packaging/registration test, not a DOM or visual acceptance test.
  const shared = {
    "@opencode/plugin/gui": {
      Plugin: { define: (value: unknown) => value },
      Style: "style",
      Panel: "panel",
      Command: "command",
      MenuItem: "menu",
    },
    "@opencode/plugin/rpc": { Rpc: { define: (value: unknown) => value } },
    "solid-js": { createEffect: () => undefined },
    "solid-js/web": { template: () => () => undefined, delegateEvents: () => undefined },
  }
  const output: { default?: { setup(ctx: unknown): void } } = {}
  runInNewContext(code, { exports: output, require: (name: keyof typeof shared) => shared[name] })
  const registered = new Map<string, unknown>()
  const opened: unknown[] = []
  const toasts: unknown[] = []
  let session: unknown
  output.default!.setup({
    id: "ai-orchestration.server",
    add: (kind: string, value: unknown) => registered.set(kind, value),
    sessions: { current: () => session },
    layout: { open: (...args: unknown[]) => opened.push(args) },
    toast: { show: (value: unknown) => toasts.push(value) },
  })
  const command = (
    registered.get("command") as () => { title: string; slash: { name: string }; run(): void }
  )()
  expect(command.title).toBe("Open Orchestration controls")
  expect(command.slash.name).toBe("orchestration")
  command.run()
  expect(opened).toHaveLength(0)
  expect(toasts).toHaveLength(1)
  session = { id: "chat", server: { id: "remote" } }
  command.run()
  expect(opened).toEqual([["ai-orchestration.server:controls", session]])
  expect(registered.has("panel")).toBe(true)
  expect(registered.has("menu")).toBe(true)
})
