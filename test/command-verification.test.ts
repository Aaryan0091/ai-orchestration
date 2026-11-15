import { describe, expect, test } from "bun:test"
import { createCommandVerification, type NativeShellEvent } from "../src/command-verification.ts"
import type { CommandVerificationResult } from "../src/verification.ts"

const directory = "/command-verification-test"
const target = {
  sessionID: "chat-a",
  workflowID: "workflow",
  stepID: "step",
  runID: "run",
  command: "bun test",
  directory,
}

function fixture() {
  let time = 100
  let serial = 0
  let scope = directory
  let permission = Promise.resolve()
  let publication = Promise.resolve()
  let ended = false
  let rejectTicket: string | undefined
  const records: CommandVerificationResult[] = []
  const asked: string[] = []
  const queue: NativeShellEvent[] = []
  let wake: (() => void) | undefined
  const api = createCommandVerification({
    directory,
    now: () => time,
    id: () => `${++serial}`,
    target: async (input) => ({ ...structuredClone(target), ...(input as typeof target) }),
    session: async () => ({ location: { directory: scope } }),
    record: async (_, result) => {
      if (result.ticketID === rejectTicket) throw new Error("Workflow evicted")
      records.push(structuredClone(result))
      await publication
    },
    assertPermission: async (session, command) => {
      asked.push(`${session}:${command}`)
      await permission
    },
    subscribe: async function* (signal) {
      signal.addEventListener("abort", () => wake?.(), { once: true })
      while (!signal.aborted && !ended) {
        if (queue.length) yield queue.shift()!
        else
          await new Promise<void>((resolve) => {
            wake = resolve
          })
      }
    },
  })
  api.initialize()
  const input = {
    sessionID: target.sessionID,
    workflowID: target.workflowID,
    stepID: target.stepID,
  }
  return {
    api,
    input,
    records,
    asked,
    time(value: number) {
      time = value
    },
    scope(value: string) {
      scope = value
    },
    permission(value: Promise<void>) {
      permission = value
    },
    publication(value: Promise<void>) {
      publication = value
    },
    rejectRecord(ticketID: string) {
      rejectTicket = ticketID
    },
    async endStream() {
      ended = true
      wake?.()
      await Bun.sleep(0)
    },
    async event(event: NativeShellEvent) {
      queue.push(event)
      wake?.()
      await Bun.sleep(0)
    },
  }
}
const created = (id: string, overrides: Record<string, unknown> = {}): NativeShellEvent => ({
  type: "shell.created",
  location: { directory },
  data: {
    info: {
      id: "native-shell",
      command: target.command,
      cwd: directory,
      metadata: { orchestrationVerification: id },
      ...overrides,
    },
  },
})
const exited = (status: string, exit?: number): NativeShellEvent => ({
  type: "shell.exited",
  location: { directory },
  data: { id: "native-shell", status, ...(exit === undefined ? {} : { exit }) },
})

describe("native command verification", () => {
  test("preparation is inert, scoped, bounded and immutable; only authoritative native exit proves success", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      expect(f.asked).toEqual(["chat-a:bun test"])
      expect(ticket.permissionSessionID).toBe(target.sessionID)
      expect(f.records.at(-1)?.sessionID).toBe(target.sessionID)
      expect(ticket.timeoutMs).toBe(30000)
      expect(ticket.metadata.orchestrationVerification).toBe(ticket.id)
      expect(f.records.at(-1)?.status).toBe("pending")
      ticket.command = "evil"
      await f.event(created(ticket.id))
      expect((await f.api.status({ sessionID: "chat-a", id: ticket.id })).result.status).toBe(
        "running",
      )
      await f.event(exited("exited", 0))
      const result = (await f.api.status({ sessionID: "chat-a", id: ticket.id })).result
      expect(result).toMatchObject({
        status: "passed",
        source: "native-shell",
        command: "bun test",
        exitCode: 0,
        shellID: "native-shell",
        ticketID: ticket.id,
      })
      expect(result).not.toHaveProperty("output")
      await expect(f.api.prepare(f.input)).rejects.toThrow("already prepared")
    } finally {
      await f.api.dispose()
    }
  })

  test("reservation precedes originating-chat permission await; denial cannot replay", async () => {
    const f = fixture(),
      permission = Promise.withResolvers<void>()
    f.permission(permission.promise)
    try {
      const preparing = f.api.prepare(f.input)
      await Bun.sleep(0)
      expect(f.asked).toEqual(["chat-a:bun test"])
      await expect(f.api.prepare(f.input)).rejects.toThrow("already prepared")
      permission.reject(new Error("Denied"))
      await expect(preparing).rejects.toThrow("Denied")
      expect(f.records.at(-1)?.status).toBe("unverified")
      await expect(f.api.prepare(f.input)).rejects.toThrow("already prepared")
    } finally {
      await f.api.dispose()
    }
  })

  test("aborting while native permission awaits never issues a dispatch ticket or replays", async () => {
    const f = fixture(),
      permission = Promise.withResolvers<void>(),
      controller = new AbortController()
    f.permission(permission.promise)
    try {
      const preparing = f.api.prepare(f.input, controller.signal)
      await Bun.sleep(0)
      expect(f.asked).toEqual(["chat-a:bun test"])
      controller.abort(new Error("Chat changed"))
      permission.resolve()
      await expect(preparing).rejects.toThrow("Chat changed")
      expect(f.records.at(-1)?.status).toBe("unverified")
      await expect(f.api.prepare(f.input)).rejects.toThrow("already prepared")
      const ticketID = f.records.at(-1)!.ticketID!
      await f.event(created(ticketID))
      await f.event(exited("exited", 0))
      expect((await f.api.status({ sessionID: "chat-a", id: ticketID })).result.status).toBe(
        "unverified",
      )
    } finally {
      await f.api.dispose()
    }
  })

  test.each(["abort", "cancel"] as const)(
    "%s during initial publication does not leave a stale native permission request",
    async (action) => {
      const f = fixture(),
        publication = Promise.withResolvers<void>(),
        controller = new AbortController()
      f.publication(publication.promise)
      try {
        const preparing = f.api.prepare(f.input, controller.signal)
        await Bun.sleep(0)
        const ticketID = f.records.at(-1)!.ticketID!
        let cancelling: Promise<unknown> | undefined
        if (action === "abort") controller.abort(new Error("Chat changed"))
        else {
          cancelling = f.api.cancel({ sessionID: "chat-a", id: ticketID })
          await Bun.sleep(0)
        }
        publication.resolve()
        await expect(preparing).rejects.toThrow(action === "abort" ? "Chat changed" : "cancelled")
        await cancelling
        expect(f.asked).toEqual([])
        expect(f.records.at(-1)?.status).toBe("unverified")
        await expect(f.api.prepare(f.input)).rejects.toThrow("already prepared")
      } finally {
        publication.resolve()
        await f.api.dispose()
      }
    },
  )

  test("foreign chats/projects and caller verdict fields are rejected", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      await expect(f.api.status({ sessionID: "chat-b", id: ticket.id })).rejects.toThrow(
        "unavailable",
      )
      await expect(
        f.api.status({ sessionID: "chat-a", id: ticket.id, passed: true }),
      ).rejects.toThrow("Invalid")
      f.scope("/elsewhere")
      await expect(f.api.status({ sessionID: "chat-a", id: ticket.id })).rejects.toThrow(
        "another project",
      )
    } finally {
      await f.api.dispose()
    }
  })

  test("unknown, wrong-command, wrong-directory, nonce-less and foreign-location events cannot pass", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      for (const event of [
        created("foreign"),
        created(ticket.id, { command: "other" }),
        created(ticket.id, { cwd: "/elsewhere" }),
        created(ticket.id, { metadata: {} }),
        { ...created(ticket.id), location: { directory: "/elsewhere" } },
      ] as NativeShellEvent[]) {
        await f.event(event)
        await f.event(exited("exited", 0))
        expect((await f.api.status({ sessionID: "chat-a", id: ticket.id })).result.status).toBe(
          "pending",
        )
      }
      f.time(ticket.expiresAt + 35_001)
      expect((await f.api.status({ sessionID: "chat-a", id: ticket.id })).result.status).toBe(
        "unverified",
      )
    } finally {
      await f.api.dispose()
    }
  })

  test.each([
    ["exited", 1],
    ["exited", undefined],
    ["timeout", undefined],
    ["killed", undefined],
  ])("native %s / %s does not pass", async (status, exit) => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      await f.event(created(ticket.id))
      await f.event(exited(status as string, exit as number | undefined))
      expect((await f.api.status({ sessionID: "chat-a", id: ticket.id })).result.status).toBe(
        "failed",
      )
    } finally {
      await f.api.dispose()
    }
  })

  test("cancellation only confirms after native final evidence; exit zero cannot override stop request", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      await f.event(created(ticket.id))
      const stop = await f.api.cancel({ sessionID: "chat-a", id: ticket.id })
      expect(stop.shellID).toBe("native-shell")
      expect(stop.result.status).toBe("unverified")
      await f.event(exited("killed"))
      expect((await f.api.status({ sessionID: "chat-a", id: ticket.id })).result.status).toBe(
        "cancelled",
      )
      await f.event(exited("exited", 0))
      expect(f.records.at(-1)?.status).toBe("cancelled")
    } finally {
      await f.api.dispose()
    }
  })

  test("removed shells and expired tickets never establish successful completion", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      f.time(ticket.expiresAt + 1)
      await f.event(created(ticket.id))
      await f.event(exited("exited", 0))
      expect((await f.api.status({ sessionID: "chat-a", id: ticket.id })).result.status).toBe(
        "pending",
      )
    } finally {
      await f.api.dispose()
    }
  })

  test("duplicate native shells permanently poison the original zero-exit evidence", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      await f.event(created(ticket.id))
      await f.event(created(ticket.id, { id: "duplicate-shell" }))
      await f.event(exited("exited", 0))
      const status = await f.api.status({ sessionID: "chat-a", id: ticket.id })
      expect(status.result.status).toBe("unverified")
      expect(status.result.diagnostic).toContain("More than one")
    } finally {
      await f.api.dispose()
    }
  })

  test("deletion before exit permanently blocks later zero-exit acceptance", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      await f.event(created(ticket.id))
      await f.event({
        type: "shell.deleted",
        location: { directory },
        data: { id: "native-shell" },
      })
      await f.event(exited("exited", 0))
      expect((await f.api.status({ sessionID: "chat-a", id: ticket.id })).result.status).toBe(
        "unverified",
      )
    } finally {
      await f.api.dispose()
    }
  })

  test("cancel during native permission await never returns a dispatch ticket", async () => {
    const f = fixture(),
      permission = Promise.withResolvers<void>()
    f.permission(permission.promise)
    try {
      const preparing = f.api.prepare(f.input)
      await Bun.sleep(0)
      const ticketID = f.records.at(-1)!.ticketID!
      await f.api.cancel({ sessionID: "chat-a", id: ticketID })
      permission.resolve()
      await expect(preparing).rejects.toThrow("cancelled")
      await f.event(created(ticketID))
      await f.event(exited("exited", 0))
      expect((await f.api.status({ sessionID: "chat-a", id: ticketID })).result.status).toBe(
        "unverified",
      )
    } finally {
      await f.api.dispose()
    }
  })

  test("lost observation preserves status and never promises commands were not started", async () => {
    const f = fixture()
    try {
      const ticket = await f.api.prepare(f.input)
      await f.event(created(ticket.id))
      await f.endStream()
      const status = await f.api.status({ sessionID: "chat-a", id: ticket.id })
      expect(status.result.status).toBe("unverified")
      expect(status.shellID).toBe("native-shell")
      await expect(f.api.prepare({ ...f.input, stepID: "another" })).rejects.toThrow(
        "existing commands may still be running",
      )
      const stop = await f.api.cancel({ sessionID: "chat-a", id: ticket.id })
      expect(stop.result.status).toBe("unverified")
    } finally {
      await f.api.dispose()
    }
  })

  test("stale workflow publication cannot end observation of unrelated commands", async () => {
    const f = fixture()
    try {
      const first = await f.api.prepare(f.input)
      const second = await f.api.prepare({ ...f.input, stepID: "another" })
      f.rejectRecord(first.id)
      await f.event(created(first.id))
      await f.event(created(second.id, { id: "second-shell" }))
      await f.event({
        type: "shell.exited",
        location: { directory },
        data: { id: "second-shell", status: "exited", exit: 0 },
      })
      expect((await f.api.status({ sessionID: "chat-a", id: second.id })).result.status).toBe(
        "passed",
      )
      expect((await f.api.status({ sessionID: "chat-a", id: first.id })).result.status).toBe(
        "unverified",
      )
    } finally {
      await f.api.dispose()
    }
  })
})
