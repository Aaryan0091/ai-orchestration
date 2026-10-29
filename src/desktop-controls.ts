import type { createExecutionEngine } from "./execution.ts"
import { formatRun, type createExecutionCommands } from "./execution-commands.ts"
import {
  customAgentIneligible,
  formatSelection,
  MODEL_SLOTS,
  parseSelection,
  validateSelection,
  type createRoutingCommands,
  type ModelCandidate,
  type ModelSlot,
} from "./routing.ts"
import {
  routingReply,
  RoutingApplicationError,
  unwrapRoutingReply,
  type RoutingFailure,
} from "./rpc.ts"
import type {
  DesktopActionResult,
  DesktopModels,
  DesktopRun,
  DesktopState,
  RunSummary,
  TicketPreview,
  TicketSummary,
} from "./desktop-rpc.ts"

export class DesktopControlError extends Error {}
const invalid = () =>
  new DesktopControlError("Invalid desktop request. Review the fields and retry.")
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw invalid()
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || /\s|\0/.test(value))
    throw invalid()
  return value
}
export async function desktopReply<T>(operation: () => Promise<T>): Promise<T | RoutingFailure> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof DesktopControlError || error instanceof RoutingApplicationError)
      return { ok: false, error: { code: "routing.application", message: error.message } }
    return routingReply(async () => {
      throw error
    })
  }
}

type Engine = ReturnType<typeof createExecutionEngine>
type Commands = ReturnType<typeof createExecutionCommands>
type Routing = ReturnType<typeof createRoutingCommands>
export interface DesktopHost {
  directory: string
  session(sessionID: string): Promise<{ location: { directory: string } }>
  routing: Pick<Routing, "config" | "models">
  execution: Pick<Commands, "prepareHandoff" | "start" | "discard">
  engine: Pick<Engine, "status" | "cancel" | "handoffResult">
  listModels(): Promise<readonly ModelCandidate[]>
  changed(sessionID: string): Promise<void>
  now?: () => number
  id?: () => string
}
type Ticket = TicketPreview &
  (
    | { kind: "handoff"; planID: string }
    | { kind: "model-change"; slot: ModelSlot; selection: string | null }
    | { kind: "cancel"; runID: string }
  )

/** One bounded, in-memory bridge; no model-callable approval/start methods.
 * Native GUI calls the separate desktop RPC only after a user clicks Approve.
 * Sessions/RPC APIs: https://opencode.ai/v2/docs/build/plugins/{server,rpc}
 */
export function createDesktopControls(host: DesktopHost) {
  const tickets = new Map<string, Ticket>()
  const owners = new Map<string, string>()
  const preparing = new Map<string, number>()
  const now = host.now ?? Date.now
  const id = host.id ?? (() => crypto.randomUUID())
  const ttl = 10 * 60 * 1000
  const clone = <T>(value: T): T => structuredClone(value)

  async function notify(sessionID: string) {
    // Notifications are hints, not state. Reopening/reconnecting GUI queries state.
    try {
      await host.changed(sessionID)
    } catch {
      /* Do not replay a successful action. */
    }
  }
  function expire() {
    for (const [key, ticket] of tickets)
      if (now() >= ticket.expiresAt) {
        tickets.delete(key)
        if (ticket.kind === "handoff")
          void host.execution.discard(ticket.planID).catch(() => undefined)
      }
  }
  async function session(sessionID: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const found = await host.session(sessionID)
    signal?.throwIfAborted()
    if (found.location.directory !== host.directory)
      throw new DesktopControlError(
        "This chat belongs to another project. Open its controls in that project.",
      )
  }
  function reserve(sessionID: string) {
    expire()
    const active = [...tickets.values()].filter((ticket) => ticket.sessionID === sessionID).length
    const pending = [...preparing.values()].reduce((sum, count) => sum + count, 0)
    if (tickets.size + pending >= 100 || active + (preparing.get(sessionID) ?? 0) >= 10)
      throw new DesktopControlError(
        "Too many pending desktop requests. Approve or cancel one first.",
      )
    preparing.set(sessionID, (preparing.get(sessionID) ?? 0) + 1)
    return () => {
      const count = (preparing.get(sessionID) ?? 1) - 1
      if (count) preparing.set(sessionID, count)
      else preparing.delete(sessionID)
    }
  }
  function preview(ticket: Ticket): TicketPreview {
    return clone({
      id: ticket.id,
      sessionID: ticket.sessionID,
      directory: ticket.directory,
      kind: ticket.kind,
      title: ticket.title,
      createdAt: ticket.createdAt,
      expiresAt: ticket.expiresAt,
      message: ticket.message,
    })
  }
  function summary(ticket: Ticket): TicketSummary {
    const { message: _message, ...rest } = preview(ticket)
    return rest
  }
  function getTicket(sessionID: string, ticketID: string) {
    expire()
    const ticket = tickets.get(ticketID)
    if (!ticket)
      throw new DesktopControlError(
        "Desktop request expired, was already used, or was cleared on restart. Prepare it again.",
      )
    if (ticket.sessionID !== sessionID || ticket.directory !== host.directory)
      throw new DesktopControlError("This desktop request belongs to another chat or project.")
    return ticket
  }
  function ownedRun(sessionID: string, runID: string) {
    if (owners.get(runID) !== sessionID)
      throw new DesktopControlError(
        "This run does not belong to this desktop chat, or its record was cleared on restart.",
      )
    return host.engine.status(runID)
  }
  function runSummary(run: ReturnType<Engine["status"]>): RunSummary {
    return {
      id: run.id,
      state: run.state,
      agent: run.plan.agent,
      task: run.plan.task,
      sessionIDs: run.attempts.flatMap((attempt) => (attempt.sessionID ? [attempt.sessionID] : [])),
    }
  }
  function base(sessionID: string) {
    const createdAt = now()
    return { id: id(), sessionID, directory: host.directory, createdAt, expiresAt: createdAt + ttl }
  }

  return {
    async prepareHandoff(
      sessionID: string,
      raw: unknown,
      signal?: AbortSignal,
    ): Promise<TicketPreview> {
      sessionID = identifier(sessionID)
      // Freeze before the first await; model tools cannot supply caller/session identity.
      const input = clone(raw)
      await session(sessionID, signal)
      const release = reserve(sessionID)
      let planID: string | undefined
      try {
        const prepared = await host.execution.prepareHandoff(JSON.stringify(input))
        planID = prepared.id
        signal?.throwIfAborted()
        const ticket: Ticket = {
          ...base(sessionID),
          kind: "handoff",
          planID,
          title: "Run specialist handoff",
          message: prepared.message,
        }
        // Ticket ID intentionally differs from the engine's legacy approval ID.
        if (ticket.id === planID)
          throw new DesktopControlError(
            "Could not create a separate desktop approval ticket. Prepare again.",
          )
        tickets.set(ticket.id, ticket)
        planID = undefined
        await notify(sessionID)
        return preview(ticket)
      } finally {
        release()
        if (planID) await host.execution.discard(planID)
      }
    },
    async proposeModel(raw: unknown, signal?: AbortSignal): Promise<TicketPreview> {
      const input = clone(object(raw, ["sessionID", "slot", "selection"]))
      const sessionID = identifier(input.sessionID)
      if (
        !MODEL_SLOTS.includes(input.slot as ModelSlot) ||
        (input.selection !== null &&
          (typeof input.selection !== "string" || input.selection.length > 1000))
      )
        throw invalid()
      const slot = input.slot as ModelSlot
      const selection =
        input.selection === null ? null : formatSelection(parseSelection(input.selection as string))
      await session(sessionID, signal)
      const release = reserve(sessionID)
      try {
        if (selection) validateSelection(parseSelection(selection), await host.listModels())
        signal?.throwIfAborted()
        const ticket: Ticket = {
          ...base(sessionID),
          kind: "model-change",
          slot,
          selection,
          title: `Change ${slot} model preference`,
          message: `Project: ${host.directory}\nReplace the ${slot} tier with: ${selection ?? "not selected"}.\nOnly this saved tier changes. Other preferences and the current chat model stay unchanged. Future plugin tasks use this preference. No model request is sent by saving it.`,
        }
        tickets.set(ticket.id, ticket)
        await notify(sessionID)
        return preview(ticket)
      } finally {
        release()
      }
    },
    async proposeCancel(raw: unknown, signal?: AbortSignal): Promise<TicketPreview> {
      const input = clone(object(raw, ["sessionID", "runID"]))
      const sessionID = identifier(input.sessionID)
      const runID = identifier(input.runID)
      await session(sessionID, signal)
      const release = reserve(sessionID)
      try {
        const run = ownedRun(sessionID, runID)
        if (!["running", "stopping"].includes(run.state))
          throw new DesktopControlError("This run has already stopped. Refresh its status.")
        const ticket: Ticket = {
          ...base(sessionID),
          kind: "cancel",
          runID,
          title: "Cancel specialist run",
          message: `Cancel run ${runID}\nAgent: ${run.plan.agent}\nTask: ${run.plan.task}\nThis interrupts the child session. Work or provider charges already incurred cannot be undone. An uncertain stop remains stopping; it is never claimed as cancelled without confirmation.`,
        }
        tickets.set(ticket.id, ticket)
        await notify(sessionID)
        return preview(ticket)
      } finally {
        release()
      }
    },
    async state(raw: unknown, signal?: AbortSignal): Promise<DesktopState> {
      const input = clone(object(raw, ["sessionID"]))
      const sessionID = identifier(input.sessionID)
      await session(sessionID, signal)
      expire()
      const runs: RunSummary[] = []
      for (const [runID, owner] of owners)
        if (owner === sessionID) {
          try {
            runs.push(runSummary(host.engine.status(runID)))
          } catch {
            owners.delete(runID)
          }
        }
      return {
        sessionID,
        directory: host.directory,
        pending: [...tickets.values()]
          .filter((ticket) => ticket.sessionID === sessionID)
          .map(summary),
        runs: runs.reverse(),
      }
    },
    async review(raw: unknown, signal?: AbortSignal): Promise<TicketPreview> {
      const input = clone(object(raw, ["sessionID", "ticketID"]))
      const sessionID = identifier(input.sessionID)
      const ticketID = identifier(input.ticketID)
      await session(sessionID, signal)
      return preview(getTicket(sessionID, ticketID))
    },
    async discard(raw: unknown, signal?: AbortSignal): Promise<DesktopActionResult> {
      const input = clone(object(raw, ["sessionID", "ticketID"]))
      const sessionID = identifier(input.sessionID)
      const ticketID = identifier(input.ticketID)
      await session(sessionID, signal)
      const ticket = getTicket(sessionID, ticketID)
      tickets.delete(ticketID)
      if (ticket.kind === "handoff") await host.execution.discard(ticket.planID)
      await notify(sessionID)
      return {
        ticketID,
        kind: ticket.kind,
        message: "Cancelled desktop request; no new work or settings change started.",
      }
    },
    async approve(raw: unknown, signal?: AbortSignal): Promise<DesktopActionResult> {
      const input = clone(object(raw, ["sessionID", "ticketID"]))
      const sessionID = identifier(input.sessionID)
      const ticketID = identifier(input.ticketID)
      await session(sessionID, signal)
      const ticket = getTicket(sessionID, ticketID)
      // Consume synchronously before the first mutating await. Never replay on an ambiguous failure.
      tickets.delete(ticketID)
      let runID: string | undefined
      let message: string
      try {
        if (ticket.kind === "handoff") {
          runID = ticket.planID
          owners.set(runID, sessionID)
          try {
            message = await host.execution.start(runID)
          } catch (error) {
            try {
              host.engine.status(runID)
            } catch {
              owners.delete(runID)
            }
            throw error
          }
        } else if (ticket.kind === "model-change") {
          const command =
            ticket.selection === null
              ? `reset ${ticket.slot}`
              : `set ${ticket.slot} ${ticket.selection}`
          message = unwrapRoutingReply(
            await routingReply(() => host.routing.models(command, signal)),
          ) as string
        } else {
          message = formatRun(await host.engine.cancel(ticket.runID))
          runID = ticket.runID
        }
      } finally {
        await notify(sessionID)
      }
      // Engine history is itself bounded. Prune ownership of already-evicted runs.
      if (owners.size > 200)
        for (const key of owners.keys()) {
          try {
            host.engine.status(key)
          } catch {
            owners.delete(key)
          }
        }
      return { ticketID, kind: ticket.kind, message, ...(runID ? { runID } : {}) }
    },
    async models(raw: unknown, signal?: AbortSignal): Promise<DesktopModels> {
      const input = clone(object(raw, ["sessionID", "query", "page"]))
      const sessionID = identifier(input.sessionID)
      const query = input.query ?? ""
      const page = input.page ?? 1
      if (
        typeof query !== "string" ||
        query.length > 100 ||
        typeof page !== "number" ||
        !Number.isSafeInteger(page) ||
        page < 1
      )
        throw invalid()
      await session(sessionID, signal)
      const config = await host.routing.config()
      const inventory = (await host.listModels())
        .filter(
          (model) =>
            model.enabled && formatSelection(model).toLowerCase().includes(query.toLowerCase()),
        )
        .sort((a, b) => formatSelection(a).localeCompare(formatSelection(b)))
      signal?.throwIfAborted()
      const pages = Math.max(1, Math.ceil(inventory.length / 30))
      if (page > pages)
        throw new DesktopControlError(
          "Model page is no longer available. Search or refresh from page one.",
        )
      return {
        selections: Object.fromEntries(
          Object.entries(config.selections).map(([slot, model]) => [slot, formatSelection(model)]),
        ),
        models: inventory.slice((page - 1) * 30, page * 30).map((model) => ({
          id: formatSelection(model),
          eligible: !customAgentIneligible(model),
          variants: model.variants.map((variant) => variant.id),
        })),
        page,
        pages,
      }
    },
    async run(raw: unknown, signal?: AbortSignal): Promise<DesktopRun> {
      const input = clone(object(raw, ["sessionID", "runID"]))
      const sessionID = identifier(input.sessionID)
      const runID = identifier(input.runID)
      await session(sessionID, signal)
      const run = ownedRun(sessionID, runID)
      return {
        ...runSummary(run),
        summary: formatRun(run),
        result: JSON.stringify(host.engine.handoffResult(runID), null, 2),
      }
    },
    async dispose() {
      for (const ticket of tickets.values())
        if (ticket.kind === "handoff") await host.execution.discard(ticket.planID)
      tickets.clear()
      owners.clear()
    },
  }
}
