import type { Context, SessionRef } from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, on, onCleanup, untrack } from "solid-js"
import { type DesktopScope, createLatestRead, sameScope } from "./gui-controller.ts"
import { createGuidedControls, GuidedWorkflowRuns } from "./gui-guided-workflows.tsx"
import { draftCanRun } from "./gui-guided-controller.ts"
import { createWorkflowActions, matchesWorkflowEvent } from "./gui-workflow-controller.ts"
import { type WorkflowDraft, workflowRpc } from "./workflow-rpc.ts"

export const workflowStyles = `.oc-workflow-draft-title,.oc-workflow-steps li{overflow-wrap:anywhere}.oc-workflow-steps{margin:12px 0;padding-inline-start:26px}.oc-workflow-steps li{padding:10px 8px;margin-bottom:8px;border-inline-start:3px solid #a8f5e9}.oc-workflow-steps p{margin:3px 0}.oc-workflow-steps dt{font-weight:600}.oc-workflow-steps dd{margin:0 0 4px}`

type WorkflowView = {
  active(): boolean
  refresh(): Promise<void>
  drafts(): WorkflowDraft[] | undefined
  loading(): boolean
  error(): string
  discard(draft: WorkflowDraft): Promise<void>
}

function readable(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "Could not load workflow drafts. Refresh the panel to try again."
}

export function WorkflowDrafts(props: {
  ctx: Context
  session: SessionRef
  current(): DesktopScope | undefined
  refreshVersion: number
}) {
  const ctx = props.ctx
  const guided = createGuidedControls(props)
  const [lifecycle, setLifecycle] = createSignal<WorkflowView>()
  const view = () => {
    const value = lifecycle()
    return value?.active() ? value : undefined
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
    const [drafts, setDrafts] = createSignal<WorkflowDraft[]>()
    const [loading, setLoading] = createSignal(false)
    const [error, setError] = createSignal("")
    const abort = new AbortController()
    const beginRead = createLatestRead()
    const active = () =>
      mounted() &&
      !ctx.signal.aborted &&
      sameScope(props.current(), scope) &&
      props.session.server.client === client
    // Native clients and event subscriptions are scoped to the originating chat's server.
    // https://opencode.ai/docs/build/plugins/rpc#subscribe
    const rpc = client.rpc(workflowRpc)
    const actions = createWorkflowActions(scope, active, (input) => {
      const options = {
        location: { directory: scope.directory },
        signal: AbortSignal.any([ctx.signal, abort.signal, AbortSignal.timeout(15_000)]),
      }
      return input.method === "state"
        ? rpc.state({ sessionID: input.sessionID }, options)
        : rpc.discard({ sessionID: input.sessionID, draftID: input.draftID }, options)
    })

    async function refresh() {
      if (!active()) return
      const latest = beginRead()
      setLoading(true)
      try {
        const result = await actions.state()
        if (active() && latest()) {
          setDrafts(result)
          setError("")
        }
      } catch (cause) {
        if (active() && latest()) setError(readable(cause))
      } finally {
        if (active() && latest()) setLoading(false)
      }
    }

    const unsubscribe = rpc.events.on(
      "changed",
      (event) => {
        if (matchesWorkflowEvent(scope, event) && active()) void refresh()
      },
      { signal: AbortSignal.any([ctx.signal, abort.signal]) },
    )
    onCleanup(() => {
      setMounted(false)
      abort.abort()
      unsubscribe()
    })
    setLifecycle({
      active,
      refresh,
      drafts,
      loading,
      error,
      async discard(draft) {
        await actions.discard(draft)
        if (!active()) return
        // Invalidate pre-discard state reads before removing the confirmed draft.
        beginRead()
        setDrafts((value) => value?.filter((entry) => entry.id !== draft.id))
        void refresh()
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

  function review(draft: WorkflowDraft) {
    const owner = view()
    if (!owner || !owner.drafts()?.some((item) => item.id === draft.id)) return
    // Host state decides expiry; comparing it to this device's clock would
    // prematurely hide a valid draft from a remote host with clock skew.
    // Local-only review: closing a dialog never discards or starts anything.
    ctx.dialogs.open((dialog) => {
      const [discarding, setDiscarding] = createSignal(false)
      const [failure, setFailure] = createSignal("")
      const available = () =>
        view() === owner && !!owner.drafts()?.some((item) => item.id === draft.id)
      createEffect(() => {
        if (!available()) dialog.close()
      })
      const discard = async () => {
        if (discarding() || !available()) return
        setDiscarding(true)
        setFailure("")
        try {
          await owner.discard(draft)
        } catch (cause) {
          if (available()) {
            setFailure(readable(cause))
            // Expiry or an ambiguous response may have removed the draft server-side.
            void owner.refresh()
          }
        } finally {
          setDiscarding(false)
        }
      }

      return (
        <ctx.ui.Dialog
          title="Review workflow draft"
          description="Preview only. Reviewing or discarding this draft starts no specialist sessions."
          size="x-large"
          footer={
            <>
              <ctx.ui.Button autofocus onClick={() => dialog.close()}>
                Close
              </ctx.ui.Button>
              <ctx.ui.Button
                variant="danger"
                busy={discarding()}
                disabled={discarding() || !available()}
                onClick={() => void discard()}
              >
                Discard draft
              </ctx.ui.Button>
            </>
          }
        >
          <div class="oc-orchestration-review">
            <h3 class="oc-workflow-draft-title">{draft.title}</h3>
            <p class="oc-orchestration-muted">
              Expires {new Date(draft.expiresAt).toLocaleTimeString()} · Workflow draft only
            </p>
            <ol class="oc-workflow-steps">
              <For each={draft.steps}>
                {(step) => (
                  <li>
                    <strong>{step.task}</strong>
                    <dl>
                      <dt>Step ID</dt>
                      <dd>
                        <code>{step.id}</code>
                      </dd>
                      <dt>Specialist</dt>
                      <dd>{step.agent}</dd>
                      <dt>Difficulty and tier</dt>
                      <dd>
                        {step.difficulty} · {step.tier}
                      </dd>
                      <dt>Depends on</dt>
                      <dd>{step.dependsOn.length ? step.dependsOn.join(", ") : "None"}</dd>
                      <dt>Proposed model</dt>
                      <dd>{step.model ?? "Unavailable"}</dd>
                    </dl>
                    <Show when={step.blocker}>
                      {(blocker) => <p class="oc-orchestration-error">Blocked: {blocker()}</p>}
                    </Show>
                  </li>
                )}
              </For>
            </ol>
            <p class="oc-orchestration-muted">
              Ask Orchestrator in this chat if you want a revised draft.
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

  return (
    <>
      <section aria-labelledby="oc-workflows">
        <h3 id="oc-workflows">Workflow drafts</h3>
        <p class="oc-orchestration-muted">
          Ask Orchestrator for a multi-step plan in this chat. Setting up a guided run creates a
          separate workflow without starting any steps.
        </p>
        <Show when={view()?.loading() && !view()?.drafts()}>
          <p role="status">Loading workflow drafts…</p>
        </Show>
        <Show when={view()?.error()}>
          {(error) => (
            <p role="alert" class="oc-orchestration-error">
              {error()}
            </p>
          )}
        </Show>
        <Show when={view()?.drafts()?.length === 0}>
          <p class="oc-orchestration-muted">No workflow drafts in this chat.</p>
        </Show>
        <For each={view()?.drafts()}>
          {(draft) => (
            <div class="oc-orchestration-row">
              <div>
                <strong class="oc-workflow-draft-title">{draft.title}</strong>
                <p class="oc-orchestration-muted">{draft.steps.length} steps · Preview only</p>
                <Show when={!draftCanRun(draft)}>
                  <p class="oc-orchestration-muted">
                    Set compatible models for the blocked tiers and prepare a new draft to set up a
                    guided run.
                  </p>
                </Show>
              </div>
              <div class="oc-orchestration-actions">
                <ctx.ui.Button onClick={() => review(draft)}>Review draft</ctx.ui.Button>
                <ctx.ui.Button
                  disabled={
                    !guided.view()?.workflows() ||
                    guided.view()?.busy() ||
                    guided.alreadySetUp(draft.id) ||
                    !draftCanRun(draft)
                  }
                  onClick={() => guided.setUp(draft)}
                >
                  {guided.alreadySetUp(draft.id) ? "Guided run set up" : "Set up guided run"}
                </ctx.ui.Button>
              </div>
            </div>
          )}
        </For>
      </section>
      <GuidedWorkflowRuns ctx={ctx} controls={guided} />
    </>
  )
}
