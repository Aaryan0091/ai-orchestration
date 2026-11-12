import { DesktopControlError } from "./desktop-controls.ts"
import type { createExecutionEngine, TaskRun } from "./execution.ts"
import type { GuidedReview, GuidedState, GuidedStep, GuidedWorkflow } from "./guided-rpc.ts"
import type { HandoffPackage } from "./handoffs.ts"
import { formatSelection, parseSelection } from "./routing.ts"
import type { WorkflowDraft } from "./workflow-rpc.ts"

const reviewTTL = 10 * 60 * 1000
const maxWorkflows = 50
const maxPerChat = 5
const completionCheck = "The approved step objective was completed."
const closedMessage = "Guided workflows were cleared on restart."
const stopUnconfirmed = "Stop not confirmed. Inspect the specialist session in OpenCode."
const missingResult = "The specialist result is unavailable. This workflow cannot continue."

interface GuidedHost {
  directory: string
  session(sessionID: string): Promise<{ location: { directory: string } }>
  draft(sessionID: string, draftID: string, signal?: AbortSignal): Promise<WorkflowDraft>
  engine: Pick<
    ReturnType<typeof createExecutionEngine>,
    "preview" | "start" | "discard" | "status" | "cancel"
  >
  changed(sessionID: string): Promise<void>
  now?: () => number
  id?: () => string
}

interface WorkflowRecord {
  view: GuidedWorkflow
  engineRuns: Map<string, string>
  stopRequested: boolean
  cancelPending: boolean
}

const error = (message: string) => new DesktopControlError(message)
const invalid = () => error("Invalid guided workflow request. Review the fields and retry.")

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
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

function isActive(step: GuidedStep) {
  return step.state === "starting" || step.state === "running" || step.state === "stopping"
}

function isPending(step: GuidedStep) {
  return step.state === "waiting" || step.state === "ready" || step.state === "blocked"
}

function summarize(value: string, limit: number) {
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/, "")}…`
}

/** Only fixed local diagnostics cross this boundary; arbitrary provider errors may contain secrets. */
function applyRun(step: GuidedStep, run: TaskRun) {
  step.state = run.state
  delete step.diagnostic
  if (run.state === "completed") {
    const report = run.specialistReport
    if (report) step.summary = summarize(report.summary, 8000)
    if (!report) {
      step.state = "failed"
      step.diagnostic = missingResult
    } else if (
      !report.checks.some((item) => item.check === completionCheck && item.status === "passed") ||
      report.checks.some((item) => item.status !== "passed")
    ) {
      step.state = "failed"
      step.diagnostic =
        "The specialist did not report the completion check as passed. Dependent steps remain blocked."
    }
  } else if (run.state === "failed") {
    step.diagnostic = "The specialist step failed. Inspect its session in OpenCode for details."
  } else if (run.state === "cancelled") {
    step.diagnostic = "The specialist step was cancelled."
  } else if (run.state === "stopping") {
    step.diagnostic = stopUnconfirmed
  }
}

/** Separate, chat-owned workflow and approval IDs. Nothing dispatches except explicit approval. */
export function createGuidedWorkflows(host: GuidedHost) {
  const directory = host.directory
  const now = host.now ?? Date.now
  const id = host.id ?? (() => crypto.randomUUID())
  const workflows = new Map<string, WorkflowRecord>()
  const reviews = new Map<string, GuidedReview>()
  const pendingStops = new Map<string, Promise<TaskRun>>()
  let disposed = false

  function checkOpen(signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (disposed) throw error(closedMessage)
  }

  async function checkSession(sessionID: string, signal?: AbortSignal) {
    checkOpen(signal)
    let session: Awaited<ReturnType<GuidedHost["session"]>>
    try {
      session = await host.session(sessionID)
    } catch {
      throw error("Could not confirm the workflow chat. Refresh and try again.")
    }
    checkOpen(signal)
    if (session.location.directory !== directory)
      throw error("This chat belongs to another project.")
  }

  async function notify(sessionID: string) {
    if (disposed) return
    try {
      await host.changed(sessionID)
    } catch {
      // An event is a UI hint, not part of the approval; it must never replay a mutation.
    }
  }

  function expire() {
    for (const [reviewID, review] of reviews)
      if (now() >= review.expiresAt) reviews.delete(reviewID)
  }

  function owned(sessionID: string, workflowID: string) {
    const record = workflows.get(workflowID)
    if (!record || record.view.sessionID !== sessionID)
      throw error("Guided workflow is not available in this chat.")
    return record
  }

  function ownedReview(sessionID: string, reviewID: string) {
    expire()
    const review = reviews.get(reviewID)
    if (!review || review.sessionID !== sessionID)
      throw error("Step review is not available in this chat, expired, or was already used.")
    return review
  }

  function stepFor(record: WorkflowRecord, stepID: string) {
    const step = record.view.steps.find((step) => step.id === stepID)
    if (!step) throw error("That step is not part of this guided workflow.")
    return step
  }

  function refreshStep(record: WorkflowRecord, step: GuidedStep) {
    const engineID = record.engineRuns.get(step.id)
    if (!engineID || record.cancelPending || !isActive(step)) return
    try {
      applyRun(step, host.engine.status(engineID))
      if (record.stopRequested && step.state === "running") {
        step.state = "stopping"
        step.diagnostic = stopUnconfirmed
      }
    } catch {
      step.state = "stopping"
      step.diagnostic = stopUnconfirmed
    }
  }

  function confirmDependency(record: WorkflowRecord, dependency: GuidedStep) {
    const engineID = record.engineRuns.get(dependency.id)
    try {
      if (!engineID) throw error(missingResult)
      const run = host.engine.status(engineID)
      if (run.state !== "completed" || !run.specialistReport) throw error(missingResult)
      applyRun(dependency, run)
      return dependency.state === "completed"
    } catch {
      dependency.state = "failed"
      dependency.diagnostic = missingResult
      return false
    }
  }

  function refresh(record: WorkflowRecord) {
    const { view } = record
    for (const step of view.steps) refreshStep(record, step)
    const active = view.steps.some(isActive)
    const stopped =
      record.stopRequested ||
      view.steps.some((step) => step.state === "failed" || step.state === "cancelled")
    const next = view.steps.find(isPending)
    if (!stopped && !active && next) {
      // If the engine lost a prerequisite result (e.g. eviction), refuse to advance.
      for (const dependencyID of next.dependsOn) {
        const dependency = stepFor(record, dependencyID)
        if (dependency.state === "completed") confirmDependency(record, dependency)
      }
    }
    const halted = stopped || view.steps.some((step) => step.state === "failed")
    for (const step of view.steps.filter(isPending)) {
      if (halted) {
        step.state = "blocked"
        step.diagnostic = "The workflow stopped before this step."
      } else {
        delete step.diagnostic
        step.state =
          !active &&
          step === next &&
          step.dependsOn.every((dependency) => stepFor(record, dependency).state === "completed")
            ? "ready"
            : "waiting"
      }
    }
    view.state = active
      ? "running"
      : halted
        ? "stopped"
        : view.steps.every((step) => step.state === "completed")
          ? "completed"
          : "ready"
  }

  function nextStep(record: WorkflowRecord, stepID: string) {
    refresh(record)
    const step = stepFor(record, stepID)
    if (step.state !== "ready" || !step.model)
      throw error("This step is not ready. Refresh the workflow and check its dependencies.")
    return step as GuidedStep & { model: string }
  }

  function makeRoom(sessionID: string) {
    const owned = [...workflows.values()].filter(({ view }) => view.sessionID === sessionID)
    if (workflows.size < maxWorkflows && owned.length < maxPerChat) return
    const oldestTerminal = owned.find((record) => {
      refresh(record)
      return record.view.state === "completed" || record.view.state === "stopped"
    })
    if (!oldestTerminal)
      throw error("The guided workflow limit was reached. No specialist was started.")
    workflows.delete(oldestTerminal.view.id)
    for (const [reviewID, review] of reviews)
      if (review.workflowID === oldestTerminal.view.id) reviews.delete(reviewID)
  }

  function requestStop(engineID: string) {
    const current = pendingStops.get(engineID)
    if (current) return current
    const stopping = Promise.resolve().then(() => host.engine.cancel(engineID))
    pendingStops.set(engineID, stopping)
    const release = () => pendingStops.delete(engineID)
    void stopping.then(release, release)
    return stopping
  }

  return {
    async state(raw: unknown, signal?: AbortSignal): Promise<GuidedState> {
      const sessionID = identifier(object(raw, ["sessionID"]).sessionID)
      await checkSession(sessionID, signal)
      expire()
      const visible = [...workflows.values()]
        .filter(({ view }) => view.sessionID === sessionID)
        .reverse()
      for (const record of visible) refresh(record)
      return { sessionID, directory, workflows: visible.map(({ view }) => structuredClone(view)) }
    },

    async begin(raw: unknown, signal?: AbortSignal): Promise<{ id: string }> {
      const input = object(raw, ["sessionID", "draftID"])
      const sessionID = identifier(input.sessionID)
      const draftID = identifier(input.draftID)
      await checkSession(sessionID, signal)
      const draft = await host.draft(sessionID, draftID, signal)
      await checkSession(sessionID, signal)
      if (
        draft.id !== draftID ||
        draft.sessionID !== sessionID ||
        draft.directory !== directory ||
        now() >= draft.expiresAt
      )
        throw error("Workflow draft is not available in this chat or has expired.")
      if (!draft.steps.length || draft.steps.some((step) => !step.model || step.blocker))
        throw error(
          "This workflow has blocked model selections. Set compatible saved tiers and prepare a new draft.",
        )
      const existing = [...workflows.values()].find(
        ({ view }) => view.sessionID === sessionID && view.draftID === draftID,
      )
      if (existing) return { id: existing.view.id }
      const workflowID = `guided-${id()}`
      if (workflows.has(workflowID))
        throw error("Could not create a unique guided workflow. Try again.")
      makeRoom(sessionID)
      const record: WorkflowRecord = {
        view: {
          id: workflowID,
          draftID,
          title: draft.title,
          sessionID,
          directory,
          state: "ready",
          steps: draft.steps.map((step) => ({ ...structuredClone(step), state: "waiting" })),
        },
        engineRuns: new Map(),
        stopRequested: false,
        cancelPending: false,
      }
      refresh(record)
      workflows.set(workflowID, record)
      await notify(sessionID)
      return { id: workflowID }
    },

    async review(raw: unknown, signal?: AbortSignal): Promise<GuidedReview> {
      const input = object(raw, ["sessionID", "workflowID", "stepID", "includeDependencySummaries"])
      const sessionID = identifier(input.sessionID)
      const workflowID = identifier(input.workflowID)
      const stepID = identifier(input.stepID)
      const include = input.includeDependencySummaries
      if (include !== undefined && typeof include !== "boolean") throw invalid()
      await checkSession(sessionID, signal)
      const record = owned(sessionID, workflowID)
      const step = nextStep(record, stepID)
      const previousResults = include
        ? step.dependsOn.map((dependencyID) => {
            const dependency = stepFor(record, dependencyID)
            if (!dependency.runID || !dependency.summary) throw error(missingResult)
            return {
              stepID: dependencyID,
              runID: dependency.runID,
              summary: summarize(dependency.summary, 2000),
            }
          })
        : []
      expire()
      const reviewID = `guided-review-${id()}`
      if (reviews.has(reviewID)) throw error("Could not create a unique step review. Try again.")
      for (const [oldID, review] of reviews)
        if (review.workflowID === workflowID) reviews.delete(oldID)
      const review = {
        id: reviewID,
        workflowID,
        stepID,
        sessionID,
        directory,
        expiresAt: now() + reviewTTL,
        task: step.task,
        agent: step.agent,
        model: step.model,
        previousResults,
      }
      reviews.set(reviewID, review)
      return structuredClone(review)
    },

    async approve(raw: unknown, signal?: AbortSignal): Promise<{ id: string }> {
      const input = object(raw, ["sessionID", "reviewID"])
      const sessionID = identifier(input.sessionID)
      const reviewID = identifier(input.reviewID)
      await checkSession(sessionID, signal)
      const review = ownedReview(sessionID, reviewID)
      const record = owned(sessionID, review.workflowID)
      const step = nextStep(record, review.stepID)
      reviews.delete(reviewID)
      step.state = "starting"
      record.view.state = "running"
      let planID: string | undefined
      try {
        const model = parseSelection(review.model)
        const handoff: HandoffPackage = {
          version: 1,
          objective: review.task,
          files: [],
          findings: [],
          constraints: ["Perform only the approved workflow step. Do not dispatch other tasks."],
          previousResults: review.previousResults.map(({ runID, summary }) => ({ runID, summary })),
          acceptanceChecks: [completionCheck],
        }
        const plan = await host.engine.preview({
          task: review.task,
          agent: step.agent,
          difficulty: step.difficulty,
          model,
          handoff,
          options: { maxRetries: 0, escalateFailedStep: false },
        })
        planID = plan.id
        await checkSession(sessionID, signal)
        if (step.state !== "starting" || record.stopRequested)
          throw error("This workflow step was cancelled before it started.")
        if (now() >= review.expiresAt)
          throw error("Step review expired before execution. Review it again.")
        if (
          plan.models.length !== 1 ||
          !plan.models[0] ||
          formatSelection(plan.models[0]) !== review.model
        )
          throw error("The approved model could not be preserved. No specialist was started.")
        // Recheck dependencies after async planning, without authorizing any change to the reviewed context.
        for (const dependencyID of step.dependsOn) {
          const dependency = stepFor(record, dependencyID)
          if (!confirmDependency(record, dependency)) throw error(missingResult)
        }
        const run = host.engine.start(planID, { approved: true })
        planID = undefined
        record.engineRuns.set(step.id, run.id)
        // Do not disclose a legacy terminal engine identifier in a guided DTO or handoff.
        step.runID = `guided-run-${review.id}`
        applyRun(step, run)
      } catch (cause) {
        if (planID) host.engine.discard(planID)
        if (step.state === "starting") {
          if (signal?.aborted || now() >= review.expiresAt || disposed) step.state = "waiting"
          else {
            step.state = "failed"
            step.diagnostic =
              "The approved step could not start. Check the model connection and prepare a fresh draft."
          }
        }
        refresh(record)
        await notify(sessionID)
        if (cause instanceof DesktopControlError) throw cause
        checkOpen(signal)
        throw error(
          "The approved step could not start. Check the model connection and prepare a fresh draft.",
        )
      }
      refresh(record)
      await notify(sessionID)
      return { id: record.view.id }
    },

    async dismiss(raw: unknown, signal?: AbortSignal): Promise<{ id: string }> {
      const input = object(raw, ["sessionID", "reviewID"])
      const sessionID = identifier(input.sessionID)
      const reviewID = identifier(input.reviewID)
      await checkSession(sessionID, signal)
      ownedReview(sessionID, reviewID)
      reviews.delete(reviewID)
      return { id: reviewID }
    },

    async cancel(raw: unknown, signal?: AbortSignal): Promise<{ id: string }> {
      const input = object(raw, ["sessionID", "workflowID", "stepID"])
      const sessionID = identifier(input.sessionID)
      const workflowID = identifier(input.workflowID)
      const stepID = identifier(input.stepID)
      await checkSession(sessionID, signal)
      const record = owned(sessionID, workflowID)
      refresh(record)
      const step = stepFor(record, stepID)
      if (!isActive(step) || record.cancelPending)
        throw error("There is no available active step to cancel. Refresh the workflow.")
      record.stopRequested = true
      const engineID = record.engineRuns.get(step.id)
      if (!engineID) {
        step.state = "cancelled"
        step.diagnostic = "The step was cancelled before it started."
      } else {
        record.cancelPending = true
        step.state = "stopping"
        step.diagnostic = stopUnconfirmed
        try {
          const result = await requestStop(engineID)
          applyRun(step, result)
          if (result.state === "running") {
            step.state = "stopping"
            step.diagnostic = stopUnconfirmed
          }
        } catch {
          step.state = "stopping"
          step.diagnostic = stopUnconfirmed
        } finally {
          record.cancelPending = false
        }
      }
      refresh(record)
      await notify(sessionID)
      return { id: workflowID }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      const ownedRuns = [...workflows.values()].flatMap(({ view, engineRuns }) =>
        view.steps.filter(isActive).flatMap((step) => engineRuns.get(step.id) ?? []),
      )
      reviews.clear()
      workflows.clear()
      await Promise.allSettled(ownedRuns.map(requestStop))
    },
  }
}
