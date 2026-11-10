import { DesktopControlError } from "./desktop-controls.ts"
import { previewWorkflow, validateWorkflowInput, WorkflowPlanError } from "./workflow-plan.ts"
import {
  WORKFLOW_DRAFTS_PER_CHAT,
  type WorkflowDraft,
  type WorkflowDraftState,
} from "./workflow-rpc.ts"

const draftTTL = 10 * 60 * 1000
const maxDrafts = 100
type Resolver = Parameters<typeof previewWorkflow>[1]

interface WorkflowDraftHost {
  directory: string
  session(sessionID: string): Promise<{ location: { directory: string } }>
  createResolver(): Resolver
  changed(sessionID: string): Promise<void>
  now?: () => number
  id?: () => string
}

const invalid = () =>
  new DesktopControlError("Invalid workflow request. Review the fields and retry.")

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

/** Workflow drafts are owned display data. No execution or persistence service is injected. */
export function createWorkflowDrafts(host: WorkflowDraftHost) {
  const directory = host.directory
  const drafts = new Map<string, WorkflowDraft>()
  const preparing = new Map<string, number>()
  const now = host.now ?? Date.now
  const id = host.id ?? (() => crypto.randomUUID())
  let disposed = false

  function checkOpen(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (disposed) throw new DesktopControlError("Workflow drafts were cleared on restart.")
  }

  async function checkSession(sessionID: string, signal?: AbortSignal) {
    checkOpen(signal)
    const session = await host.session(sessionID)
    checkOpen(signal)
    if (session.location.directory !== directory)
      throw new DesktopControlError("This chat belongs to another project.")
  }

  function expire() {
    const timestamp = now()
    for (const [draftID, draft] of drafts) if (timestamp >= draft.expiresAt) drafts.delete(draftID)
  }

  function reserve(sessionID: string) {
    expire()
    const active = [...drafts.values()].filter((draft) => draft.sessionID === sessionID).length
    const pending = [...preparing.values()].reduce((total, count) => total + count, 0)
    if (
      drafts.size + pending >= maxDrafts ||
      active + (preparing.get(sessionID) ?? 0) >= WORKFLOW_DRAFTS_PER_CHAT
    )
      throw new DesktopControlError(
        "Too many workflow drafts. Discard a draft before preparing another.",
      )
    preparing.set(sessionID, (preparing.get(sessionID) ?? 0) + 1)
    return () => {
      const count = (preparing.get(sessionID) ?? 1) - 1
      if (count) preparing.set(sessionID, count)
      else preparing.delete(sessionID)
    }
  }

  async function notify(sessionID: string) {
    try {
      await host.changed(sessionID)
    } catch {
      // A lost UI hint never replays a successful draft mutation.
    }
  }

  return {
    async prepare(sessionID: string, raw: unknown, signal?: AbortSignal): Promise<WorkflowDraft> {
      sessionID = identifier(sessionID)
      checkOpen(signal)
      // Validate and detach model input before handing control to any async host call.
      let input: ReturnType<typeof validateWorkflowInput>
      try {
        input = validateWorkflowInput(raw)
      } catch (error) {
        if (error instanceof WorkflowPlanError) throw new DesktopControlError(error.message)
        throw error
      }
      await checkSession(sessionID, signal)
      const release = reserve(sessionID)
      let draft: WorkflowDraft
      try {
        const preview = await previewWorkflow(input, host.createResolver())
        // Revalidate in case the native chat moved during inventory reads.
        await checkSession(sessionID, signal)
        checkOpen(signal)
        const createdAt = now()
        const draftID = `workflow-${id()}`
        if (drafts.has(draftID))
          throw new DesktopControlError(
            "Could not create a unique workflow draft. Prepare it again.",
          )
        draft = {
          ...preview,
          id: draftID,
          sessionID,
          directory,
          createdAt,
          expiresAt: createdAt + draftTTL,
        }
        drafts.set(draftID, structuredClone(draft))
      } finally {
        release()
      }
      await notify(sessionID)
      return draft
    },

    async state(raw: unknown, signal?: AbortSignal): Promise<WorkflowDraftState> {
      const sessionID = identifier(object(raw, ["sessionID"]).sessionID)
      await checkSession(sessionID, signal)
      checkOpen(signal)
      expire()
      return {
        sessionID,
        directory,
        drafts: [...drafts.values()]
          .filter((draft) => draft.sessionID === sessionID)
          .reverse()
          .map((draft) => structuredClone(draft)),
      }
    },

    async discard(raw: unknown, signal?: AbortSignal): Promise<{ id: string }> {
      const input = object(raw, ["sessionID", "draftID"])
      const sessionID = identifier(input.sessionID)
      const draftID = identifier(input.draftID)
      await checkSession(sessionID, signal)
      checkOpen(signal)
      expire()
      const draft = drafts.get(draftID)
      if (!draft || draft.sessionID !== sessionID)
        throw new DesktopControlError("Workflow draft is not available in this chat.")
      drafts.delete(draftID)
      await notify(sessionID)
      return { id: draftID }
    },

    dispose() {
      disposed = true
      drafts.clear()
      preparing.clear()
    },
  }
}
