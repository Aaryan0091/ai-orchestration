import { describe, expect, test } from "bun:test"
import type { TicketPreview } from "../src/desktop-rpc.ts"
import {
  createDesktopActions,
  createLatestRead,
  createReviewDecision,
  sameScope,
} from "../src/gui-controller.ts"

const scope = { serverID: "remote", sessionID: "chat", directory: "/project" }
const ticket: TicketPreview = {
  id: "ticket",
  sessionID: "chat",
  directory: "/project",
  kind: "handoff",
  title: "Review",
  createdAt: 1,
  expiresAt: 100,
  message: "Full context <script>text only</script>",
}
const result = { ticketID: "ticket", kind: "handoff" as const, message: "Started", runID: "run" }

describe("latest native reads win within the same chat", () => {
  test("newer pending/running state survives an older empty response", async () => {
    const responses: ((value: unknown) => void)[] = []
    const actions = createDesktopActions(
      () => scope,
      () => new Promise((resolve) => responses.push(resolve)),
    )
    const begin = createLatestRead()
    let displayed: unknown
    let loading = false
    async function refresh() {
      const latest = begin()
      loading = true
      try {
        const next = await actions.state(scope)
        if (latest()) displayed = next
      } finally {
        if (latest()) loading = false
      }
    }
    const older = refresh()
    const newer = refresh()
    const fresh = {
      sessionID: scope.sessionID,
      directory: scope.directory,
      pending: [ticket],
      runs: [{ id: "run", state: "running" }],
    }
    responses[1]!(fresh)
    await newer
    expect(displayed).toEqual(fresh)
    expect(loading).toBe(false)
    responses[0]!({ ...fresh, pending: [], runs: [] })
    await older
    expect(displayed).toEqual(fresh)
    expect(loading).toBe(false)
  })
  test("stale failures/finally cannot alter newer loading or errors; read channels are independent", () => {
    const states = createLatestRead()
    const models = createLatestRead()
    const results = createLatestRead()
    const stateA = states()
    const modelA = models()
    const resultA = results()
    const stateB = states()
    expect(stateA()).toBe(false)
    expect(stateB()).toBe(true)
    expect(modelA()).toBe(true)
    expect(resultA()).toBe(true)
    const modelB = models()
    const resultB = results()
    expect(modelA()).toBe(false)
    expect(resultA()).toBe(false)
    expect(modelB()).toBe(true)
    expect(resultB()).toBe(true)
  })
})

describe("native controls identity and response guards", () => {
  test("server, chat and project each form the captured identity", async () => {
    expect(sameScope(scope, { ...scope })).toBe(true)
    expect(sameScope(undefined, undefined)).toBe(false)
    for (const changed of [
      { ...scope, serverID: "other" },
      { ...scope, sessionID: "other" },
      { ...scope, directory: "/other" },
    ]) {
      let calls = 0
      const actions = createDesktopActions(
        () => changed,
        async () => {
          calls++
          return ticket
        },
      )
      await expect(actions.review(scope, ticket.id)).rejects.toThrow(
        "active chat or server changed",
      )
      expect(calls).toBe(0)
    }
  })
  test("reads use the captured server/location and cannot approve", async () => {
    const calls: unknown[] = []
    const actions = createDesktopActions(
      () => scope,
      async (...args) => {
        calls.push(args)
        return ticket
      },
    )
    const reviewed = await actions.review(scope, "ticket")
    expect(calls).toEqual([["review", { ticketID: "ticket", sessionID: "chat" }, scope]])
    expect(reviewed).toEqual(ticket)
    expect(reviewed).not.toBe(ticket)
  })
  test("a chat switch while awaiting a response rejects stale content", async () => {
    let active = scope
    const actions = createDesktopActions(
      () => active,
      async () => {
        active = { ...scope, sessionID: "next" }
        return ticket
      },
    )
    await expect(actions.review(scope, "ticket")).rejects.toThrow("active chat or server changed")
  })
  test("wrong owner, project, ticket ID and malformed payload are refused", async () => {
    for (const reply of [
      { ...ticket, sessionID: "other" },
      { ...ticket, directory: "/other" },
      { ...ticket, id: "other" },
      [],
      null,
      "invalid",
    ]) {
      const actions = createDesktopActions(
        () => scope,
        async () => reply,
      )
      await expect(actions.review(scope, "ticket")).rejects.toThrow()
    }
  })
  test("cleanup discards only the old ticket through its captured identity", async () => {
    const calls: unknown[] = []
    const actions = createDesktopActions(
      () => ({ ...scope, serverID: "next" }),
      async (...args) => {
        calls.push(args)
        return result
      },
    )
    await actions.discard(scope, "ticket")
    expect(calls).toEqual([["discard", { ticketID: "ticket", sessionID: "chat" }, scope]])
    await expect(actions.approve(scope, ticket)).rejects.toThrow("active chat or server changed")
    expect(calls).toHaveLength(1)
  })
  test("state and result must match their requested identity", async () => {
    const actions = createDesktopActions(
      () => scope,
      async () => ({
        sessionID: "other",
        directory: "/project",
        pending: [],
        runs: [],
        id: "wrong",
      }),
    )
    await expect(actions.state(scope)).rejects.toThrow("Invalid project state")
    await expect(actions.run(scope, "run")).rejects.toThrow("does not match")
  })
  test("provider/application errors remain visible without retry", async () => {
    let calls = 0
    const actions = createDesktopActions(
      () => scope,
      async () => {
        calls++
        return { ok: false, error: { code: "routing.application", message: "Quota exhausted" } }
      },
    )
    await expect(actions.review(scope, "ticket")).rejects.toThrow("Quota exhausted")
    expect(calls).toBe(1)
  })
  test("approval responses cannot silently identify another ticket", async () => {
    const actions = createDesktopActions(
      () => scope,
      async () => ({ ...result, ticketID: "wrong" }),
    )
    await expect(actions.approve(scope, ticket)).rejects.toThrow("unclear")
  })
})

describe("trusted native review decisions", () => {
  test("opening and repeated dismissal never approve", async () => {
    let approved = 0
    let discarded = 0
    const decision = createReviewDecision({
      approve: async () => {
        approved++
        return result
      },
      discard: async () => {
        discarded++
      },
    })
    expect(approved).toBe(0)
    await decision.dismiss()
    await decision.dismiss()
    await decision.approve()
    expect(approved).toBe(0)
    expect(discarded).toBe(1)
  })
  test("double-click, dismissal during flight and cleanup cannot duplicate a decision", async () => {
    let approved = 0
    let discarded = 0
    let resolve!: (value: typeof result) => void
    const decision = createReviewDecision({
      approve: () => {
        approved++
        return new Promise((done) => {
          resolve = done
        })
      },
      discard: async () => {
        discarded++
      },
    })
    const running = decision.approve()
    await decision.approve()
    await decision.dismiss()
    resolve(result)
    expect(await running).toEqual(result)
    await decision.approve()
    await decision.dismiss()
    expect(approved).toBe(1)
    expect(discarded).toBe(0)
  })
  test("ambiguous approval failure never retries or becomes discard", async () => {
    let approved = 0
    let discarded = 0
    const decision = createReviewDecision({
      approve: async () => {
        approved++
        throw new Error("Lost response")
      },
      discard: async () => {
        discarded++
      },
    })
    await expect(decision.approve()).rejects.toThrow("Lost response")
    await decision.approve()
    await decision.dismiss()
    expect(approved).toBe(1)
    expect(discarded).toBe(0)
  })
})
