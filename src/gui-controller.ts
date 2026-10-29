import type {
  DesktopActionResult,
  DesktopModels,
  DesktopRun,
  DesktopState,
  TicketPreview,
} from "./desktop-rpc.ts"
import { unwrapRoutingReply } from "./rpc.ts"

export interface DesktopScope {
  serverID: string
  sessionID: string
  directory: string
}
export type DesktopMethod =
  | "state"
  | "models"
  | "review"
  | "approve"
  | "discard"
  | "proposeModel"
  | "proposeCancel"
  | "run"
export type DesktopCall = (
  method: DesktopMethod,
  input: Record<string, unknown>,
  scope: DesktopScope,
) => Promise<unknown>

export function sameScope(a: DesktopScope | undefined, b: DesktopScope | undefined): boolean {
  return (
    !!a &&
    !!b &&
    a.serverID === b.serverID &&
    a.sessionID === b.sessionID &&
    a.directory === b.directory
  )
}

export function scopeError(): Error {
  return new Error(
    "The active chat or server changed. Open Orchestration in the original chat before continuing.",
  )
}

/** Captured identity guards every response as well as every outbound action. */
export function createDesktopActions(current: () => DesktopScope | undefined, call: DesktopCall) {
  async function request<T>(
    scope: DesktopScope,
    method: DesktopMethod,
    input: Record<string, unknown>,
    inactive = false,
  ): Promise<T> {
    const captured = { ...scope }
    if (!inactive && !sameScope(current(), captured)) throw scopeError()
    const value = unwrapRoutingReply(
      await call(method, { ...input, sessionID: captured.sessionID }, captured),
    )
    if (!inactive && !sameScope(current(), captured)) throw scopeError()
    if (!value || typeof value !== "object")
      throw new Error("Invalid desktop response. Refresh this chat’s controls.")
    return value as T
  }
  function checkTicket(ticket: TicketPreview, scope: DesktopScope, id?: string) {
    if (
      ticket.sessionID !== scope.sessionID ||
      ticket.directory !== scope.directory ||
      (id && ticket.id !== id) ||
      typeof ticket.message !== "string"
    )
      throw new Error("The approval does not belong to this chat/project. Nothing was approved.")
    return structuredClone(ticket)
  }
  return {
    async state(scope: DesktopScope) {
      const value = await request<DesktopState>(scope, "state", {})
      if (
        value.sessionID !== scope.sessionID ||
        value.directory !== scope.directory ||
        !Array.isArray(value.pending) ||
        !Array.isArray(value.runs)
      )
        throw new Error("Invalid project state. Refresh this chat’s controls.")
      return value
    },
    models: (scope: DesktopScope, query = "", page = 1) =>
      request<DesktopModels>(scope, "models", { query, page }),
    async review(scope: DesktopScope, id: string) {
      return checkTicket(await request<TicketPreview>(scope, "review", { ticketID: id }), scope, id)
    },
    async proposeModel(
      scope: DesktopScope,
      slot: "small" | "mid" | "big" | "orchestrator",
      selection: string | null,
    ) {
      return checkTicket(
        await request<TicketPreview>(scope, "proposeModel", { slot, selection }),
        scope,
      )
    },
    async proposeCancel(scope: DesktopScope, runID: string) {
      return checkTicket(await request<TicketPreview>(scope, "proposeCancel", { runID }), scope)
    },
    async approve(scope: DesktopScope, ticket: TicketPreview) {
      checkTicket(ticket, scope, ticket.id)
      const value = await request<DesktopActionResult>(scope, "approve", { ticketID: ticket.id })
      if (
        value.ticketID !== ticket.id ||
        value.kind !== ticket.kind ||
        typeof value.message !== "string"
      )
        throw new Error("Approval response was unclear. Check this chat’s runs before retrying.")
      return value
    },
    // Cleanup may run after switching chats. Discard ONLY the captured old ticket,
    // through its captured server; it cannot start, cancel or mutate running work.
    discard: (scope: DesktopScope, ticketID: string) =>
      request<DesktopActionResult>(scope, "discard", { ticketID }, true),
    run: (scope: DesktopScope, runID: string) => request<DesktopRun>(scope, "run", { runID }),
  }
}

/** Exactly one explicit decision; dismissing a review is never approval. */
export function createReviewDecision(input: {
  approve(): Promise<DesktopActionResult>
  discard(): Promise<unknown>
}) {
  let decided = false
  let busy = false
  return {
    async approve() {
      if (decided || busy) return undefined
      busy = true
      // After the trusted click, a network error may be ambiguous. Never retry
      // this approval automatically or turn dismissal into a second decision.
      decided = true
      try {
        return await input.approve()
      } finally {
        busy = false
      }
    },
    async dismiss() {
      if (decided || busy) return
      decided = true
      await input.discard()
    },
  }
}
