import { type DesktopScope, scopeError } from "./gui-controller.ts"
import { unwrapRoutingReply } from "./rpc.ts"
import type { WorkflowDraft, WorkflowDraftState } from "./workflow-rpc.ts"

type WorkflowRequest = (
  request:
    | { method: "state"; sessionID: string }
    | { method: "discard"; sessionID: string; draftID: string },
) => Promise<unknown>

export function matchesWorkflowEvent(
  scope: DesktopScope,
  event: { data: Readonly<Record<string, unknown>>; location?: { directory: string } },
) {
  return event.data.sessionID === scope.sessionID && event.location?.directory === scope.directory
}

/** A controller is tied to a single connected client and project chat. */
export function createWorkflowActions(
  scope: DesktopScope,
  active: () => boolean,
  call: WorkflowRequest,
) {
  const { sessionID, directory } = scope
  const owns = (draft: WorkflowDraft) =>
    draft.sessionID === sessionID && draft.directory === directory

  async function request(input: Parameters<WorkflowRequest>[0]) {
    if (!active()) throw scopeError()
    const result = await call(input)
    if (!active()) throw scopeError()
    return unwrapRoutingReply(result)
  }

  return {
    async state() {
      const value = (await request({ method: "state", sessionID })) as
        | WorkflowDraftState
        | undefined
      if (
        !value ||
        value.sessionID !== sessionID ||
        value.directory !== directory ||
        !Array.isArray(value.drafts) ||
        value.drafts.some(
          (draft) =>
            !draft || !owns(draft) || typeof draft.id !== "string" || !Array.isArray(draft.steps),
        )
      )
        throw new Error(
          "The workflow drafts do not belong to this chat/project. Refresh the panel.",
        )
      return value.drafts
    },
    async discard(draft: WorkflowDraft) {
      if (!owns(draft)) throw scopeError()
      const result = (await request({ method: "discard", sessionID, draftID: draft.id })) as
        | { id?: string }
        | undefined
      if (result?.id !== draft.id)
        throw new Error("The discard response was unclear. Refresh the panel before trying again.")
    },
  }
}
