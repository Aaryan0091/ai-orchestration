import { DesktopControlError } from "./desktop-controls.ts"
import type { CommandStatus, CommandTicket } from "./command-verification-rpc.ts"
import type { CommandVerificationTarget } from "./guided-workflows.ts"
import type { CommandVerificationResult } from "./verification.ts"

export type NativeShellEvent =
  | {
      type: "shell.created"
      location?: { directory?: string }
      data: {
        info: { id: string; command: string; cwd: string; metadata: Record<string, unknown> }
      }
    }
  | {
      type: "shell.exited"
      location?: { directory?: string }
      data: { id: string; status: string; exit?: number }
    }
  | { type: "shell.deleted"; location?: { directory?: string }; data: { id: string } }

interface Host {
  directory: string
  target(input: unknown, signal?: AbortSignal): Promise<CommandVerificationTarget>
  record(target: CommandVerificationTarget, result: CommandVerificationResult): Promise<void>
  assertPermission(sessionID: string, command: string): Promise<void>
  subscribe(signal: AbortSignal): AsyncIterable<NativeShellEvent>
  session(sessionID: string): Promise<{ location: { directory: string } }>
  now?: () => number
  id?: () => string
}
interface RecordState {
  target: CommandVerificationTarget
  ticket: CommandTicket
  result: CommandVerificationResult
  cancelRequested: boolean
  ready: boolean
  poisoned: boolean
  shellID?: string
}
const failure = (message: string) => new DesktopControlError(message)
const terminal = (status: CommandVerificationResult["status"]) =>
  status === "passed" || status === "failed" || status === "cancelled"

/** Native shell lifecycle evidence, never a verdict supplied by a model or GUI.
 * Host APIs: @opencode/plugin event.subscribe; @opencode/client shell.create/remove.
 * shell.create carries its own timeout, including if this plugin restarts before dispatch.
 */
export function createCommandVerification(host: Host) {
  const records = new Map<string, RecordState>()
  const reservations = new Set<string>()
  const shellOwners = new Map<string, string>()
  const controller = new AbortController()
  const now = host.now ?? Date.now
  const makeID = host.id ?? (() => crypto.randomUUID())
  let disposed = false
  let available = false
  let listener: Promise<void> | undefined
  const key = (target: CommandVerificationTarget) =>
    JSON.stringify([target.sessionID, target.workflowID, target.stepID, target.runID])

  async function publish(record: RecordState) {
    if (disposed) return
    await host.record(record.target, structuredClone(record.result))
  }
  async function publishObserved(record: RecordState) {
    try {
      await publish(record)
    } catch {
      // A stale/evicted workflow must not break observation of unrelated commands.
      record.poisoned = true
      record.result.status = "unverified"
      record.result.diagnostic =
        "The originating workflow no longer accepts this evidence. Inspect the native shell; no command is replayed."
    }
  }
  function checkOpen(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (disposed)
      throw failure(
        "Command verification was cleared. Inspect native shells before preparing anything else; do not replay an ambiguous command.",
      )
  }
  function checkAvailable(signal?: AbortSignal) {
    checkOpen(signal)
    if (!available)
      throw failure(
        "Native command observation is unavailable. Inspect native shells; existing commands may still be running. Do not replay them.",
      )
  }
  async function scope(sessionID: unknown, signal?: AbortSignal) {
    checkOpen(signal)
    if (typeof sessionID !== "string" || !sessionID || sessionID.length > 200)
      throw failure("Invalid command verification chat.")
    const session = await host.session(sessionID)
    checkOpen(signal)
    if (session.location.directory !== host.directory)
      throw failure("Command verification belongs to another project.")
    return sessionID
  }
  function object(raw: unknown, fields: string[]) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).some((field) => !fields.includes(field))
    )
      throw failure("Invalid command verification request.")
    return raw as Record<string, unknown>
  }
  async function lookup(raw: unknown, signal?: AbortSignal) {
    const input = object(raw, ["sessionID", "id"])
    const sessionID = await scope(input.sessionID, signal)
    const record = typeof input.id === "string" ? records.get(input.id) : undefined
    if (!record || record.target.sessionID !== sessionID)
      throw failure("Command check is unavailable in this chat or cleared after restart.")
    if (!terminal(record.result.status) && now() > record.ticket.expiresAt + 35_000) {
      record.result.status = "unverified"
      record.result.diagnostic =
        "No final native shell evidence was observed. Dependent steps remain blocked; do not replay this command."
      record.poisoned = true
      await publishObserved(record)
    }
    return record
  }
  function view(record: RecordState): CommandStatus {
    return structuredClone({
      id: record.ticket.id,
      sessionID: record.target.sessionID,
      workflowID: record.target.workflowID,
      stepID: record.target.stepID,
      directory: host.directory,
      result: record.result,
      ...(record.shellID ? { shellID: record.shellID } : {}),
    })
  }
  async function observe(event: NativeShellEvent) {
    if (disposed || event.location?.directory !== host.directory) return
    if (event.type === "shell.created") {
      const { info } = event.data
      const token = info.metadata.orchestrationVerification
      const record = typeof token === "string" ? records.get(token) : undefined
      if (
        !record ||
        !record.ready ||
        now() > record.ticket.expiresAt ||
        terminal(record.result.status)
      )
        return
      if (info.command !== record.ticket.executionCommand || info.cwd !== host.directory) return
      if (record.shellID && record.shellID !== info.id) {
        record.poisoned = true
        record.result.status = "unverified"
        record.result.diagnostic =
          "More than one native shell matched this single-use check. Inspect the native shells; no result is trusted."
        await publishObserved(record)
        return
      }
      if (record.poisoned) return
      record.shellID = info.id
      shellOwners.set(info.id, record.ticket.id)
      record.result.shellID = info.id
      record.result.status = record.cancelRequested ? "unverified" : "running"
      record.result.diagnostic = record.cancelRequested
        ? "The command appeared after a stop request. Remove this observed native shell; stop is not confirmed."
        : "The approved command is running in a native shell. Exit status is pending; stdout is not collected."
      await publishObserved(record)
      return
    }
    const record = records.get(shellOwners.get(event.data.id) ?? "")
    if (!record || record.poisoned || terminal(record.result.status)) return
    if (event.type === "shell.deleted") {
      record.poisoned = true
      record.result.status = "unverified"
      record.result.diagnostic =
        "The native shell was removed before final exit evidence. Stop is unconfirmed; dependent steps remain blocked."
    } else if (event.data.status === "exited" && event.data.exit === 0) {
      record.result.status = record.cancelRequested ? "cancelled" : "passed"
      record.result.exitCode = 0
      record.result.diagnostic = record.cancelRequested
        ? "Cancellation was requested. Even though the native command exited zero, this check will not advance the workflow."
        : "The exact approved command exited zero according to the native shell event. This proves only that command's exit status; stdout was not collected."
    } else if (event.data.status === "running") return
    else {
      record.result.status =
        event.data.status === "killed" && record.cancelRequested ? "cancelled" : "failed"
      if (typeof event.data.exit === "number" && Number.isFinite(event.data.exit))
        record.result.exitCode = event.data.exit
      record.result.diagnostic =
        event.data.status === "timeout"
          ? "The native command timed out. Dependent steps remain blocked."
          : event.data.status === "killed"
            ? "The native shell was killed. Dependent steps remain blocked."
            : "The native command did not exit successfully. Dependent steps remain blocked."
    }
    await publishObserved(record)
  }
  return {
    initialize() {
      if (listener) return
      available = true
      listener = (async () => {
        try {
          for await (const event of host.subscribe(controller.signal)) await observe(event)
        } catch {
          // A lost event stream cannot establish command success or cancellation.
        } finally {
          available = false
          if (!disposed)
            for (const record of records.values()) {
              if (terminal(record.result.status)) continue
              record.poisoned = true
              record.result.status = "unverified"
              record.result.diagnostic =
                "The native shell event stream ended. Inspect the native shell; no command will be replayed."
              await publishObserved(record)
            }
        }
      })()
    },
    async prepare(raw: unknown, signal?: AbortSignal): Promise<CommandTicket> {
      const input = object(raw, ["sessionID", "workflowID", "stepID"])
      checkAvailable(signal)
      await scope(input.sessionID, signal)
      const target = await host.target(input, signal)
      checkAvailable(signal)
      if (target.directory !== host.directory)
        throw failure("Command check belongs to another project.")
      const reservation = key(target)
      if (reservations.has(reservation))
        throw failure(
          "A command check was already prepared for this run. Refresh; never replay an ambiguous command.",
        )
      if (records.size >= 100)
        throw failure("Command check capacity reached. No command was started.")
      reservations.add(reservation)
      const ticketID = `command-check-${makeID()}`
      const record: RecordState = {
        target: structuredClone(target),
        ticket: {
          id: ticketID,
          sessionID: target.sessionID,
          workflowID: target.workflowID,
          stepID: target.stepID,
          directory: host.directory,
          command: target.command,
          executionCommand: target.command,
          permissionSessionID: target.sessionID,
          expiresAt: now() + 60_000,
          timeoutMs: 30000,
          metadata: { orchestrationVerification: ticketID },
        },
        result: {
          status: "pending",
          source: "native-shell",
          command: target.command,
          ticketID,
          sessionID: target.sessionID,
          diagnostic: "Awaiting explicit native shell permission. No command was dispatched.",
        },
        cancelRequested: false,
        ready: false,
        poisoned: false,
      }
      records.set(ticketID, record)
      try {
        await publish(record)
        checkAvailable(signal)
        if (record.cancelRequested)
          throw failure("Command preparation was cancelled. No permission will be requested.")
        // @opencode/plugin PermissionDomain.assert displays approval in its sessionID.
        // Keep it in the originating chat: a separate permission-only child hides the
        // native prompt from the controls that are waiting for the user's decision.
        await host.assertPermission(target.sessionID, target.command)
        checkAvailable(signal)
        if (record.cancelRequested)
          throw failure("Command preparation was cancelled. No dispatch ticket will be issued.")
        // Recheck frozen originating run after the permission await; never start stale work.
        const current = await host.target(input, signal)
        if (key(current) !== reservation || current.command !== target.command)
          throw failure("The originating workflow changed. No command was dispatched.")
        checkAvailable(signal)
        if (record.cancelRequested)
          throw failure("Command preparation was cancelled. No dispatch ticket will be issued.")
        record.ticket.expiresAt = now() + 60_000
        record.ready = true
        record.result.diagnostic =
          "Permission granted. Awaiting one native shell dispatch from the originating Desktop controls. No result is verified yet."
        await publish(record)
        return structuredClone(record.ticket)
      } catch (error) {
        record.result.status = "unverified"
        record.result.diagnostic =
          "Native permission or preparation was not confirmed. No command was dispatched by this plugin; the check cannot be replayed."
        try {
          await publish(record)
        } catch {
          /* Preserve the consumed reservation on failure. */
        }
        throw error
      }
    },
    async status(raw: unknown, signal?: AbortSignal) {
      return view(await lookup(raw, signal))
    },
    async cancel(raw: unknown, signal?: AbortSignal) {
      const record = await lookup(raw, signal)
      if (terminal(record.result.status)) throw failure("This command check has already ended.")
      record.cancelRequested = true
      record.result.status = "unverified"
      record.result.diagnostic =
        "Stop requested, not yet confirmed. The Desktop controls must remove the observed native shell; later steps remain blocked."
      await publish(record)
      return view(record)
    },
    async dispose() {
      if (disposed) return
      disposed = true
      available = false
      controller.abort()
      await listener
      records.clear()
      shellOwners.clear()
      reservations.clear()
    },
  }
}
