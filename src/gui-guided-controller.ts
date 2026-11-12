import { type DesktopScope, scopeError } from "./gui-controller.ts"
import type { GuidedReview, GuidedState, GuidedStep, GuidedWorkflow } from "./guided-rpc.ts"
import { unwrapRoutingReply } from "./rpc.ts"
import type { WorkflowDraft } from "./workflow-rpc.ts"

export type GuidedRequest =
  | { method: "state"; sessionID: string }
  | { method: "begin"; sessionID: string; draftID: string }
  | {
      method: "review"
      sessionID: string
      workflowID: string
      stepID: string
      includeDependencySummaries: boolean
    }
  | { method: "approve" | "dismiss"; sessionID: string; reviewID: string }
  | { method: "cancel"; sessionID: string; workflowID: string; stepID: string }

function validID(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 200
}

export function draftCanRun(draft: WorkflowDraft) {
  return draft.steps.length > 0 && draft.steps.every((step) => !!step.model && !step.blocker)
}

export function guidedStepCanStop(step: GuidedStep | undefined) {
  return step?.state === "starting" || step?.state === "running" || step?.state === "stopping"
}

/** All calls and replies are bound to the originating connected client and chat. */
export function createGuidedActions(
  scope: DesktopScope,
  active: () => boolean,
  call: (input: GuidedRequest) => Promise<unknown>,
) {
  const { sessionID, directory } = scope
  function owns(value: { sessionID: string; directory: string }) {
    return value.sessionID === sessionID && value.directory === directory
  }
  function checkScope() {
    if (!active()) throw scopeError()
  }
  async function request(input: GuidedRequest) {
    checkScope()
    const response = await call(input)
    checkScope()
    return unwrapRoutingReply(response)
  }
  function responseID(response: unknown, expected?: string) {
    const id = (response as { id?: unknown } | null)?.id
    if (!validID(id) || (expected !== undefined && id !== expected))
      throw new Error("The response was unclear. Refresh this chat’s controls before continuing.")
    return id
  }
  function checkStep(workflow: GuidedWorkflow, step: GuidedStep) {
    if (!owns(workflow) || !workflow.steps.some((candidate) => candidate.id === step.id))
      throw scopeError()
  }
  function checkReview(review: GuidedReview) {
    if (!owns(review) || !validID(review.id)) throw scopeError()
  }
  return {
    async state() {
      const result = (await request({ method: "state", sessionID })) as GuidedState | undefined
      if (
        !result ||
        !owns(result) ||
        !Array.isArray(result.workflows) ||
        result.workflows.some(
          (workflow) =>
            !workflow || !owns(workflow) || !validID(workflow.id) || !Array.isArray(workflow.steps),
        )
      )
        throw new Error(
          "The guided workflows do not belong to this chat/project. Refresh the panel.",
        )
      return result.workflows
    },
    async begin(draft: WorkflowDraft) {
      if (!owns(draft) || !validID(draft.id)) throw scopeError()
      if (!draftCanRun(draft))
        throw new Error("Set compatible model tiers and prepare a new draft.")
      return responseID(await request({ method: "begin", sessionID, draftID: draft.id }))
    },
    async review(workflow: GuidedWorkflow, step: GuidedStep, includeDependencySummaries: boolean) {
      checkStep(workflow, step)
      if (step.state !== "ready" || !step.model) throw new Error("This step is not ready.")
      const result = (await request({
        method: "review",
        sessionID,
        workflowID: workflow.id,
        stepID: step.id,
        includeDependencySummaries,
      })) as GuidedReview | undefined
      if (
        !result ||
        !owns(result) ||
        !validID(result.id) ||
        result.workflowID !== workflow.id ||
        result.stepID !== step.id ||
        result.task !== step.task ||
        result.agent !== step.agent ||
        result.model !== step.model ||
        !Number.isFinite(result.expiresAt) ||
        !Array.isArray(result.previousResults) ||
        (!includeDependencySummaries && result.previousResults.length > 0) ||
        result.previousResults.some(
          (entry) =>
            !entry ||
            !step.dependsOn.includes(entry.stepID) ||
            !validID(entry.runID) ||
            typeof entry.summary !== "string",
        )
      )
        throw new Error("This review did not match the selected step. Nothing was approved.")
      return structuredClone(result)
    },
    async approve(review: GuidedReview) {
      checkReview(review)
      return responseID(
        await request({ method: "approve", sessionID, reviewID: review.id }),
        review.workflowID,
      )
    },
    async dismiss(review: GuidedReview) {
      checkReview(review)
      return responseID(
        await request({ method: "dismiss", sessionID, reviewID: review.id }),
        review.id,
      )
    },
    async cancel(workflow: GuidedWorkflow, step: GuidedStep) {
      checkStep(workflow, step)
      if (!guidedStepCanStop(step)) throw new Error("This step is no longer active.")
      return responseID(
        await request({ method: "cancel", sessionID, workflowID: workflow.id, stepID: step.id }),
        workflow.id,
      )
    },
  }
}

/** Mark the decision before the RPC. A transport failure must not replay approval. */
export function createGuidedDecision(input: {
  approve: () => Promise<string>
  dismiss: () => Promise<unknown>
}) {
  let decided = false
  return {
    async approve() {
      if (decided) return undefined
      decided = true
      return input.approve()
    },
    async dismiss() {
      if (decided) return
      decided = true
      await input.dismiss()
    },
  }
}
