import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { Plugin } from "@opencode/plugin/tui"
import { approveMessage, messagePages, showMessage } from "../src/tui-messages.ts"
import tui from "../src/tui.ts"

type Confirm = Parameters<Plugin.Context["ui"]["dialog"]["confirm"]>[0]
function fixture(choose: (dialog: Confirm, index: number) => boolean | undefined) {
  const dialogs: Confirm[] = []
  const alerts: { title: string; message: string }[] = []
  const renderer = Object.assign(new EventEmitter(), { width: 80, height: 24 })
  const context = {
    renderer,
    ui: {
      dialog: {
        confirm: async (dialog: Confirm) => {
          dialogs.push(dialog)
          return choose(dialog, dialogs.length - 1)
        },
        alert: async (dialog: (typeof alerts)[number]) => {
          alerts.push(dialog)
        },
        clear: () => {},
      },
    },
  } as unknown as Plugin.Context
  return { context, renderer, dialogs, alerts }
}

const longMessage = `${Array.from({ length: 90 }, (_, i) => `Context line ${i}`).join("\n")}\nFINAL_COST_WARNING`

test("ordinary words do not split across lines or pages and no text is dropped", () => {
  const message = `Leading line\n${"x".repeat(46)} attempts may run.`
  const pages = messagePages(message, 80, 20)
  expect(pages).toHaveLength(2)
  expect(pages[1]).toBe("attempts may run.")
  expect(pages.join("\n").replace(/\n/g, "")).toBe(message.replace(/\n/g, ""))
  const sentence = "Only the approved attempts may run. "
  for (const width of [48, 60, 80, 120]) {
    const wrapped = messagePages(sentence.repeat(20), width, 24)
    const text = wrapped.join("\n")
    expect(text.replace(/\n/g, "")).toBe(sentence.repeat(20))
    expect(text.match(/attempts/g)).toHaveLength(20)
    expect(text).not.toContain("a\nttempts")
  }
})

test("terminal-sized pages retain all text including long JSON strings and Unicode", () => {
  const input = `FIRST ${"x".repeat(1500)} 漢字🙂e\u0301\nLAST`
  for (const [width, height] of [
    [80, 24],
    [60, 20],
    [40, 16],
  ]) {
    const pages = messagePages(input, width, height)
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.join("\n").replace(/\n/g, "")).toBe(input.replace(/\n/g, ""))
    for (const page of pages) {
      expect(page.split("\n").length).toBeLessThanOrEqual(Math.max(1, height! - 18))
      for (const line of page.split("\n"))
        expect(
          Array.from(line).reduce((sum, char) => sum + (/^[\x20-\x7e]$/.test(char) ? 1 : 2), 0),
        ).toBeLessThanOrEqual(Math.min(48, width! - 12))
    }
    expect(pages.at(-1)).toContain("LAST")
  }
})

test("short messages keep the existing alert and approval dialogs", async () => {
  const f = fixture(() => true)
  await showMessage(f.context, "Settings", "small: local/model")
  expect(f.alerts).toEqual([{ title: "Settings", message: "small: local/model" }])
  expect(f.dialogs).toHaveLength(0)
  expect(await approveMessage(f.context, "Short approval")).toBe(true)
  expect(f.dialogs[0]?.label).toEqual({ confirm: "Run task", cancel: "Cancel" })
})

test("long previews have previous/next navigation and expose the final warning", async () => {
  const f = fixture((_dialog, index) => index !== 1)
  await showMessage(f.context, "AI Orchestration", longMessage)
  expect(f.dialogs.slice(0, 3).map((dialog) => dialog.title)).toEqual([
    "AI Orchestration (1/16)",
    "AI Orchestration (2/16)",
    "AI Orchestration (1/16)",
  ])
  expect(f.dialogs.at(-1)?.message).toContain("FINAL_COST_WARNING")
  expect(f.dialogs.at(-1)?.label?.confirm).toBe("Close")
  expect(f.dialogs.every((dialog) => dialog.label?.confirm !== "Run task")).toBe(true)
  expect(f.renderer.listenerCount("resize")).toBe(0)
})

test("approval is offered only after every page; Escape cancels on any page", async () => {
  for (const escapeAt of [0, 2, 15]) {
    const f = fixture((_dialog, index) => (index === escapeAt ? undefined : true))
    expect(await approveMessage(f.context, longMessage)).toBe(false)
    expect(f.dialogs).toHaveLength(escapeAt + 1)
    expect(f.renderer.listenerCount("resize")).toBe(0)
  }
  const f = fixture(() => true)
  expect(await approveMessage(f.context, longMessage)).toBe(true)
  expect(f.dialogs).toHaveLength(16)
  expect(f.dialogs.slice(0, -1).every((dialog) => dialog.label?.confirm === "Next")).toBe(true)
  expect(f.dialogs.at(-1)?.label).toEqual({ confirm: "Run task", cancel: "Previous" })
  expect(f.dialogs.at(-1)?.message).toContain("FINAL_COST_WARNING")
})

test("resize reflows from the beginning and cannot turn dismissal into approval", async () => {
  let resized = false
  const f = fixture((_dialog, index) => {
    if (index === 1) {
      f.renderer.width = 60
      f.renderer.height = 20
      resized = true
      f.renderer.emit("resize", 60, 20)
      return undefined
    }
    return true
  })
  expect(await approveMessage(f.context, longMessage)).toBe(true)
  expect(resized).toBe(true)
  expect(f.dialogs[2]?.title).toContain("(1/")
  expect(f.dialogs[2]?.message).toContain("Context line 0")
  expect(f.dialogs.at(-1)?.message).toContain("FINAL_COST_WARNING")
  expect(f.renderer.listenerCount("resize")).toBe(0)
})

test("dialog failures release the resize listener", async () => {
  const f = fixture(() => {
    throw new Error("dialog failed")
  })
  await expect(showMessage(f.context, "Preview", longMessage)).rejects.toThrow("dialog failed")
  expect(f.renderer.listenerCount("resize")).toBe(0)
})

test("an undersized terminal cannot hide approval controls and start work", async () => {
  const f = fixture(() => true)
  f.renderer.width = 40
  f.renderer.height = 16
  expect(await approveMessage(f.context, longMessage)).toBe(false)
  expect(f.dialogs).toHaveLength(0)
  expect(f.alerts[0]?.title).toBe("Resize terminal")
  expect(f.renderer.listenerCount("resize")).toBe(0)
})

test("long TUI approvals cannot dispatch before the last page or after Escape", async () => {
  type Layer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>
  for (const cancel of [true, false]) {
    let layer: Layer = {}
    const calls: string[] = []
    const f = fixture((dialog, index) => {
      expect(calls).not.toContain("start")
      if (cancel && index === 1) return undefined
      if (dialog.label?.confirm === "Run task")
        expect(dialog.message).toContain("FINAL_COST_WARNING")
      return true
    })
    await tui.setup({
      ...f.context,
      options: { notifyOnLoad: false },
      location: { directory: "/project" },
      keymap: {
        layer: (get: () => Layer) => {
          layer = get()
        },
      },
      client: {
        rpc: () => ({
          handoff: async () => {
            calls.push("prepare")
            return { id: "ticket", message: longMessage }
          },
          start: async () => {
            calls.push("start")
            return "running"
          },
          discard: async () => {
            calls.push("discard")
            return "cancelled"
          },
        }),
      },
      ui: { ...f.context.ui, router: { current: () => ({ type: "home" }) } },
    } as unknown as Plugin.Context)
    await layer.commands
      ?.find((command) => command.slash?.name === "orchestration-handoff")
      ?.run("/orchestration-handoff run {}")
    expect(calls).toEqual(["prepare", cancel ? "discard" : "start"])
  }
})
