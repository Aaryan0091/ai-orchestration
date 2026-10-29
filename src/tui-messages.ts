import type { Plugin } from "@opencode/plugin/tui"

type MessageContext = Pick<Plugin.Context, "renderer" | "ui">

/** Conservative cell widths: wide/combined Unicode may overestimate, never hide text. */
function cells(character: string): number {
  return /^[\x20-\x7e]$/.test(character) ? 1 : 2
}

export function messagePages(message: string, columns = 80, rows = 24): string[] {
  // Built-in medium dialogs have their own padding, title and button rows.
  // Leave space for those plus our navigation hint; don't rely on host scrolling.
  const width = Math.max(1, Math.min(48, Math.floor(columns) - 12))
  const height = Math.max(1, Math.min(20, Math.floor(rows) - 18))
  const lines: string[] = []
  for (const line of message.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let segment = ""
    let length = 0
    for (const token of line.match(/\s+|\S+/gu) ?? []) {
      const tokenWidth = Array.from(token).reduce((sum, character) => sum + cells(character), 0)
      // Keep ordinary words whole, especially at page boundaries. Preserve all
      // whitespace; only oversized tokens (e.g. URLs/JSON values) need hard wraps.
      if (tokenWidth <= width && length + tokenWidth > width && segment) {
        lines.push(segment)
        segment = ""
        length = 0
      }
      for (const character of token) {
        const size = cells(character)
        if (length + size > width && segment) {
          lines.push(segment)
          segment = ""
          length = 0
        }
        segment += character
        length += size
      }
    }
    lines.push(segment)
  }
  const pages: string[] = []
  for (let start = 0; start < lines.length; start += height)
    pages.push(lines.slice(start, start + height).join("\n"))
  return pages
}

function dimensions(context: MessageContext) {
  const width = context.renderer?.width
  const height = context.renderer?.height
  return {
    width: Number.isFinite(width) && width > 0 ? width : 80,
    height: Number.isFinite(height) && height > 0 ? height : 24,
  }
}

/** SDK dialogs have no scroll option; paginate using documented confirm/alert APIs. */
async function present(
  context: MessageContext,
  title: string,
  message: string,
  approval: boolean,
): Promise<boolean> {
  let page = 0
  let viewport = dimensions(context)
  let pages = messagePages(message, viewport.width, viewport.height)
  async function tooSmall() {
    if (viewport.width >= 48 && viewport.height >= 20) return false
    await context.ui.dialog.alert({
      title: "Resize terminal",
      message: "Use at least 48 columns × 20 rows, then retry.",
    })
    return true
  }
  if (await tooSmall()) return false
  if (pages.length === 1) {
    if (approval)
      return (
        (await context.ui.dialog.confirm({
          title,
          message,
          label: { confirm: "Run task", cancel: "Cancel" },
        })) === true
      )
    await context.ui.dialog.alert({ title, message })
    return false
  }
  while (true) {
    if (await tooSmall()) return false
    let resized = false
    const onResize = () => {
      resized = true
      context.ui.dialog.clear()
    }
    context.renderer?.on?.("resize", onResize)
    let choice: boolean | undefined
    const last = page === pages.length - 1
    try {
      choice = await context.ui.dialog.confirm({
        title: `${title} (${page + 1}/${pages.length})`,
        message: `${pages[page]}\n\nEsc: ${approval ? "cancel" : "close"} | ${last ? "Last page" : "More below"}`,
        label: {
          confirm: last ? (approval ? "Run task" : "Close") : "Next",
          cancel: page > 0 ? "Previous" : approval ? "Cancel" : "Close",
        },
      })
    } finally {
      context.renderer?.off?.("resize", onResize)
    }
    const current = dimensions(context)
    if (resized || current.width !== viewport.width || current.height !== viewport.height) {
      // Reflow from the start so resizing cannot skip unseen approval content.
      viewport = current
      pages = messagePages(message, viewport.width, viewport.height)
      page = 0
      continue
    }
    if (choice === undefined) return false
    if (choice === true) {
      if (last) return approval
      page++
    } else if (page === 0) return false
    else page--
  }
}

export function showMessage(context: MessageContext, title: string, message: string) {
  return present(context, title, message, false).then(() => undefined)
}

export function approveMessage(context: MessageContext, message: string) {
  return present(context, "Approve routed task?", message, true)
}
