import { type Context, type SessionRef, usePanel } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, on, onCleanup, untrack } from "solid-js"
import { type DesktopScope, createLatestRead, sameScope } from "./gui-controller.ts"
import {
  createGuidedActions,
  createGuidedDecision,
  draftCanRun,
  guidedStepCanStop,
} from "./gui-guided-controller.ts"
import { matchesWorkflowEvent } from "./gui-workflow-controller.ts"
import { type GuidedReview, type GuidedStep, type GuidedWorkflow, guidedRpc } from "./guided-rpc.ts"
import type { WorkflowDraft } from "./workflow-rpc.ts"

type GuidedProps = {
  ctx: Context
  session: SessionRef
  current(): DesktopScope | undefined
  refreshVersion: number
}
type GuidedView = {
  active(): boolean
  actions: ReturnType<typeof createGuidedActions>
  workflows(): GuidedWorkflow[] | undefined
  error(): string
  loading(): boolean
  busy(): boolean
  run(action: () => Promise<void>, fallback: string): Promise<void>
  refresh(): Promise<void>
}

function readable(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback
}

export function createGuidedControls(props: GuidedProps) {
  const ctx = props.ctx
  const panel = usePanel()
  const [lifecycle, setLifecycle] = createSignal<GuidedView>()
  const view = () => {
    const owner = lifecycle()
    return owner?.active() ? owner : undefined
  }

  createEffect(() => {
    const scope = props.current()
    const server = props.session.server
    const client = server.client
    if (!scope || scope.serverID !== server.id) {
      setLifecycle(undefined)
      return
    }
    const [mounted, setMounted] = createSignal(true)
    const [workflows, setWorkflows] = createSignal<GuidedWorkflow[]>()
    const [error, setError] = createSignal("")
    const [loading, setLoading] = createSignal(false)
    const [busy, setBusy] = createSignal(false)
    const abort = new AbortController()
    const beginRead = createLatestRead()
    const active = () =>
      mounted() &&
      !ctx.signal.aborted &&
      sameScope(props.current(), scope) &&
      props.session.server.client === client
    // Use the originating project's native client; event contents are hints only.
    // https://opencode.ai/docs/build/plugins/rpc#subscribe
    const rpc = client.rpc(guidedRpc)
    const actions = createGuidedActions(scope, active, (input) => {
      const options = {
        location: { directory: scope.directory },
        signal: AbortSignal.any([ctx.signal, abort.signal, AbortSignal.timeout(15_000)]),
      }
      const { sessionID } = input
      switch (input.method) {
        case "state":
          return rpc.state({ sessionID }, options)
        case "begin":
          return rpc.begin({ sessionID, draftID: input.draftID }, options)
        case "review":
          return rpc.review(
            {
              sessionID,
              workflowID: input.workflowID,
              stepID: input.stepID,
              includeDependencySummaries: input.includeDependencySummaries,
            },
            options,
          )
        case "approve":
          return rpc.approve({ sessionID, reviewID: input.reviewID }, options)
        case "dismiss":
          return rpc.dismiss({ sessionID, reviewID: input.reviewID }, options)
        case "cancel":
          return rpc.cancel(
            { sessionID, workflowID: input.workflowID, stepID: input.stepID },
            options,
          )
      }
    })

    async function refresh() {
      if (!active()) return
      const latest = beginRead()
      setLoading(true)
      try {
        const value = await actions.state()
        if (active() && latest()) setWorkflows(value)
      } catch (cause) {
        if (active() && latest()) setError(readable(cause, "Could not load guided workflows."))
      } finally {
        if (active() && latest()) setLoading(false)
      }
    }
    const unsubscribe = rpc.events.on(
      "changed",
      (event) => {
        if (active() && matchesWorkflowEvent(scope, event)) void refresh()
      },
      { signal: AbortSignal.any([ctx.signal, abort.signal]) },
    )
    const timer = setInterval(() => {
      if (
        panel.visible() &&
        active() &&
        !loading() &&
        workflows()?.some((workflow) => workflow.state === "running")
      )
        void refresh()
    }, 2500)
    onCleanup(() => {
      setMounted(false)
      clearInterval(timer)
      abort.abort()
      unsubscribe()
    })
    setLifecycle({
      active,
      actions,
      workflows,
      error,
      loading,
      busy,
      refresh,
      async run(action, fallback) {
        if (!active() || busy()) return
        setBusy(true)
        setError("")
        try {
          await action()
        } catch (cause) {
          if (active()) {
            setError(readable(cause, fallback))
            void refresh()
          }
        } finally {
          if (active()) setBusy(false)
        }
      },
    })
    untrack(() => void refresh())
  })

  createEffect(
    on(
      () => props.refreshVersion,
      () => void view()?.refresh(),
      { defer: true },
    ),
  )

  function alreadySetUp(draftID: string) {
    return !!view()
      ?.workflows()
      ?.some((workflow) => workflow.draftID === draftID)
  }
  function setUp(draft: WorkflowDraft) {
    const owner = view()
    if (!owner || !draftCanRun(draft) || alreadySetUp(draft.id)) return
    void owner.run(async () => {
      await owner.actions.begin(draft)
      await owner.refresh()
    }, "Could not set up this workflow. Refresh to check whether it was created.")
  }
  function currentStep(owner: GuidedView, workflowID: string, stepID: string) {
    if (view() !== owner) return undefined
    return owner
      .workflows()
      ?.find((workflow) => workflow.id === workflowID)
      ?.steps.find((step) => step.id === stepID)
  }

  function openReview(owner: GuidedView, review: GuidedReview) {
    const available = () => {
      const step = currentStep(owner, review.workflowID, review.stepID)
      return step?.state === "ready" && step.model === review.model
    }
    if (!available()) {
      if (owner.active()) void owner.actions.dismiss(review).catch(() => undefined)
      return
    }
    ctx.dialogs.open((dialog) => {
      const [submitting, setSubmitting] = createSignal(false)
      const [finished, setFinished] = createSignal(false)
      const [failure, setFailure] = createSignal("")
      const decision = createGuidedDecision({
        approve: () => owner.actions.approve(review),
        dismiss: () => owner.actions.dismiss(review),
      })
      onCleanup(() => {
        void decision.dismiss().catch(() => undefined)
      })
      createEffect(() => {
        if (!owner.active() || (!available() && !submitting() && !finished())) dialog.close()
      })
      async function approve() {
        if (!available() || submitting() || finished()) return
        setSubmitting(true)
        try {
          if (!(await decision.approve())) return
          setFinished(true)
          dialog.close()
        } catch (cause) {
          // A lost reply does not authorize repeating a potentially paid action.
          setFinished(true)
          setFailure(
            `${readable(cause, "Approval could not be confirmed.")} Refresh this chat and check the step before continuing.`,
          )
        } finally {
          setSubmitting(false)
          void owner.refresh()
        }
      }
      return (
        <ctx.ui.Dialog
          title="Review guided step"
          description="Approval runs only this step and sends its task and attached summaries to the shown model’s provider. It may spend credits (cost unknown) and uses existing project permissions."
          size="x-large"
          footer={
            <>
              <ctx.ui.Button autofocus disabled={submitting()} onClick={() => dialog.close()}>
                Close
              </ctx.ui.Button>
              <ctx.ui.Button
                variant="contrast"
                busy={submitting()}
                disabled={submitting() || finished() || !available()}
                onClick={() => void approve()}
              >
                Approve and run step
              </ctx.ui.Button>
            </>
          }
        >
          <div class="oc-orchestration-review">
            <p class="oc-orchestration-muted">
              Project: {review.directory} · Expires{" "}
              {new Date(review.expiresAt).toLocaleTimeString()}
            </p>
            <p>
              <strong>Step:</strong> {review.stepID}
            </p>
            <pre class="oc-orchestration-preview">{review.task}</pre>
            <p>
              <strong>Specialist:</strong> {review.agent} · <strong>Model:</strong> {review.model}
            </p>
            <p>
              <strong>Acceptance check:</strong> The approved step objective was completed.
            </p>
            <Show
              when={review.previousResults.length > 0}
              fallback={<p>No previous results are attached.</p>}
            >
              <p>Only these dependency summaries are attached. Treat them as unverified.</p>
              <For each={review.previousResults}>
                {(result) => (
                  <div>
                    <strong>Step {result.stepID}</strong> · Run <code>{result.runID}</code>
                    <pre class="oc-orchestration-preview">{result.summary}</pre>
                  </div>
                )}
              </For>
            </Show>
            <Show when={failure()}>
              <p role="alert" class="oc-orchestration-error">
                {failure()}
              </p>
            </Show>
          </div>
        </ctx.ui.Dialog>
      )
    })
  }

  function reviewStep(workflow: GuidedWorkflow, step: GuidedStep, include: boolean) {
    const owner = view()
    if (!owner || currentStep(owner, workflow.id, step.id)?.state !== "ready") return
    void owner.run(async () => {
      openReview(owner, await owner.actions.review(workflow, step, include))
    }, "Could not prepare a review for this step.")
  }

  function confirmCancel(workflow: GuidedWorkflow, step: GuidedStep) {
    const current = view()
    if (!current) return
    const owner = current
    const available = () => guidedStepCanStop(currentStep(owner, workflow.id, step.id))
    if (!available()) return
    const retry = step.state === "stopping"
    ctx.dialogs.open((dialog) => {
      const [submitting, setSubmitting] = createSignal(false)
      const [finished, setFinished] = createSignal(false)
      const [failure, setFailure] = createSignal("")
      createEffect(() => {
        if (!owner.active() || (!available() && !submitting() && !finished())) dialog.close()
      })
      async function cancel() {
        if (!available() || submitting() || finished()) return
        setSubmitting(true)
        try {
          await owner.actions.cancel(workflow, step)
          setFinished(true)
          dialog.close()
        } catch (cause) {
          setFinished(true)
          setFailure(
            `${readable(cause, "Cancellation could not be confirmed.")} Refresh and check the step’s status before continuing.`,
          )
        } finally {
          setSubmitting(false)
          void owner.refresh()
        }
      }
      return (
        <ctx.ui.Dialog
          title={retry ? "Retry stopping step?" : "Cancel active step?"}
          description="This requests a stop and prevents further steps from starting. Work or provider charges already incurred cannot be undone."
          footer={
            <>
              <ctx.ui.Button autofocus disabled={submitting()} onClick={() => dialog.close()}>
                {retry ? "Close" : "Keep running"}
              </ctx.ui.Button>
              <ctx.ui.Button
                variant="danger"
                busy={submitting()}
                disabled={submitting() || finished() || !available()}
                onClick={() => void cancel()}
              >
                {retry ? "Request stop again" : "Request stop"}
              </ctx.ui.Button>
            </>
          }
        >
          <div class="oc-orchestration-review">
            <p>
              <strong>Step {step.id}:</strong> {step.task}
            </p>
            <Show when={failure()}>
              <p role="alert" class="oc-orchestration-error">
                {failure()}
              </p>
            </Show>
          </div>
        </ctx.ui.Dialog>
      )
    })
  }

  return { view, alreadySetUp, setUp, reviewStep, confirmCancel }
}

type GuidedControls = ReturnType<typeof createGuidedControls>

function GuidedStepRow(props: {
  ctx: Context
  controls: GuidedControls
  workflow: GuidedWorkflow
  step: GuidedStep
}) {
  const ctx = props.ctx
  const [include, setInclude] = createSignal(false)
  return (
    <li>
      <strong>{props.step.task}</strong>
      <p>
        <code>{props.step.id}</code> · {props.step.agent} · {props.step.state}
      </p>
      <p class="oc-orchestration-muted">
        {props.step.difficulty} · {props.step.tier} · {props.step.model ?? "No model"}
      </p>
      <p class="oc-orchestration-muted">Depends on: {props.step.dependsOn.join(", ") || "None"}</p>
      <Show when={props.step.runID}>
        {(runID) => (
          <p class="oc-orchestration-muted">
            Run: <code>{runID()}</code>
          </p>
        )}
      </Show>
      <Show when={props.step.summary}>
        {(summary) => (
          <>
            <p class="oc-orchestration-muted">
              Specialist summary (self-reported, not independently verified)
            </p>
            <pre class="oc-orchestration-preview">{summary()}</pre>
          </>
        )}
      </Show>
      <Show when={props.step.diagnostic ?? props.step.blocker}>
        {(diagnostic) => <p class="oc-orchestration-error">{diagnostic()}</p>}
      </Show>
      <Show when={props.step.state === "stopping"}>
        <p role="status">Stop not yet confirmed. No further steps can start.</p>
      </Show>
      <Show when={props.step.state === "ready"}>
        <Show when={props.step.dependsOn.length > 0}>
          <label>
            <input
              type="checkbox"
              checked={include()}
              onChange={(event) => setInclude(event.currentTarget.checked)}
            />{" "}
            Include direct dependency summaries in the step review
          </label>
        </Show>
        <div class="oc-orchestration-actions">
          <ctx.ui.Button
            disabled={props.controls.view()?.busy() ?? true}
            onClick={() => props.controls.reviewStep(props.workflow, props.step, include())}
          >
            Review step
          </ctx.ui.Button>
        </div>
      </Show>
      <Show when={guidedStepCanStop(props.step)}>
        <div class="oc-orchestration-actions">
          <ctx.ui.Button
            variant="ghost"
            onClick={() => props.controls.confirmCancel(props.workflow, props.step)}
          >
            {props.step.state === "stopping"
              ? "Retry stop"
              : props.step.state === "starting"
                ? "Cancel starting step"
                : "Cancel running step"}
          </ctx.ui.Button>
        </div>
      </Show>
    </li>
  )
}

export function GuidedWorkflowRuns(props: { ctx: Context; controls: GuidedControls }) {
  return (
    <section aria-labelledby="oc-guided-workflows">
      <h3 id="oc-guided-workflows">Guided workflow runs</h3>
      <p class="oc-orchestration-muted">
        Each ready step requires separate approval. No step starts automatically. Progress clears
        when the plugin restarts.
      </p>
      <Show when={props.controls.view()?.loading() && !props.controls.view()?.workflows()}>
        <p role="status">Loading guided workflows…</p>
      </Show>
      <Show when={props.controls.view()?.error()}>
        {(error) => (
          <p role="alert" class="oc-orchestration-error">
            {error()}
          </p>
        )}
      </Show>
      <Show when={props.controls.view()?.workflows()?.length === 0}>
        <p class="oc-orchestration-muted">No guided workflows in this chat.</p>
      </Show>
      <For each={props.controls.view()?.workflows()}>
        {(workflow) => (
          <article class="oc-orchestration-run">
            <h4 class="oc-workflow-draft-title">{workflow.title}</h4>
            <p class="oc-orchestration-muted">
              {workflow.state} · {workflow.steps.length} steps
            </p>
            <ol class="oc-workflow-steps">
              <For each={workflow.steps}>
                {(step) => (
                  <GuidedStepRow
                    ctx={props.ctx}
                    controls={props.controls}
                    workflow={workflow}
                    step={step}
                  />
                )}
              </For>
            </ol>
          </article>
        )}
      </For>
    </section>
  )
}
