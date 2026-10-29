import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  Style,
  type Context,
  type SessionRef,
  usePanel,
} from "@opencode/plugin/gui"
import { For, Show, createEffect, createSignal, onCleanup, untrack } from "solid-js"
import {
  desktopRpc,
  type DesktopModels,
  type DesktopRun,
  type DesktopState,
  type TicketPreview,
} from "./desktop-rpc.ts"
import {
  createDesktopActions,
  createReviewDecision,
  sameScope,
  type DesktopScope,
} from "./gui-controller.ts"
import { unwrapRoutingReply } from "./rpc.ts"

const TAB = { id: "controls", title: "Orchestration", icon: "task" as const }
const slots = ["small", "mid", "big", "orchestrator"] as const

function scopeOf(session: SessionRef | undefined): DesktopScope | undefined {
  if (
    !session?.location?.directory ||
    session.pending ||
    !session.server.connected ||
    !session.server.compatible
  )
    return undefined
  return {
    serverID: session.server.id,
    sessionID: session.id,
    directory: session.location.directory,
  }
}
function readable(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not load Orchestration. Refresh and check that the server plugin is enabled."
}

function Controls(props: { ctx: Context; session: SessionRef }) {
  const ctx = props.ctx
  const panel = usePanel()
  const [state, setState] = createSignal<DesktopState>()
  const [models, setModels] = createSignal<DesktopModels>()
  const [run, setRun] = createSignal<DesktopRun>()
  const [loading, setLoading] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [notice, setNotice] = createSignal("")
  const [query, setQuery] = createSignal("")
  const [slot, setSlot] = createSignal<(typeof slots)[number]>("small")
  const [selection, setSelection] = createSignal("")
  let generation = 0
  let disposed = false
  const current = () => {
    const mounted = ctx.sessions.current()
    return mounted?.key === props.session.key ? scopeOf(mounted) : undefined
  }
  const servers = new Map<string, SessionRef["server"]>()
  const actions = createDesktopActions(current, async (method, input, scope) => {
    const server = servers.get(scope.serverID)
    if (!server?.connected || !server.compatible)
      throw new Error("The server is disconnected. Reconnect, then refresh this chat’s controls.")
    return server.client.rpc(desktopRpc)[method](input as never, {
      location: { directory: scope.directory },
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(15_000)]),
    })
  })
  async function refresh(scope = current()) {
    if (!scope) return
    const version = generation
    setLoading(true)
    try {
      const next = await actions.state(scope)
      if (!disposed && version === generation) {
        setState(next)
        setError("")
      }
    } catch (cause) {
      if (!disposed && version === generation) setError(readable(cause))
    } finally {
      if (!disposed && version === generation) setLoading(false)
    }
  }
  async function loadModels(page = 1) {
    const scope = current()
    if (!scope) return
    const version = generation
    setBusy(true)
    try {
      const value = await actions.models(scope, query(), page)
      if (!disposed && version === generation) setModels(value)
    } catch (cause) {
      if (!disposed && version === generation) setError(readable(cause))
    } finally {
      if (!disposed && version === generation) setBusy(false)
    }
  }
  function review(scope: DesktopScope, ticket: TicketPreview) {
    if (!sameScope(current(), scope)) return
    ctx.dialogs.open((dialog) => {
      const [submitting, setSubmitting] = createSignal(false)
      const [failure, setFailure] = createSignal("")
      let finished = false
      const decision = createReviewDecision({
        approve: () => actions.approve(scope, ticket),
        discard: () => actions.discard(scope, ticket.id),
      })
      onCleanup(() => {
        void decision.dismiss().catch(() => undefined)
      })
      createEffect(() => {
        if (!sameScope(current(), scope)) dialog.close()
      })
      async function approve() {
        if (submitting() || finished) return
        setSubmitting(true)
        try {
          const response = await decision.approve()
          if (!response) return
          finished = true
          dialog.close()
          if (!disposed && sameScope(current(), scope)) {
            setNotice(response.message)
            await refresh(scope)
            await loadModels()
          }
        } catch (cause) {
          // A response can be lost after the server consumes the ticket. Do not
          // offer an automatic retry of a potentially billable action.
          finished = true
          setFailure(
            `${readable(cause)} Refresh the original chat’s runs before preparing another request.`,
          )
        } finally {
          setSubmitting(false)
        }
      }
      return (
        <ctx.ui.Dialog
          title="Review orchestration request"
          description="Only your explicit approval applies this exact request. Context and reported evidence may be unverified."
          size="x-large"
          footer={
            <>
              <ctx.ui.Button autofocus disabled={submitting()} onClick={() => dialog.close()}>
                Cancel
              </ctx.ui.Button>
              <ctx.ui.Button
                variant={ticket.kind === "cancel" ? "danger" : "contrast"}
                busy={submitting()}
                disabled={finished || !sameScope(current(), scope)}
                onClick={() => void approve()}
              >
                {ticket.kind === "handoff"
                  ? "Run task"
                  : ticket.kind === "model-change"
                    ? "Apply model change"
                    : "Cancel running task"}
              </ctx.ui.Button>
            </>
          }
        >
          <div class="oc-orchestration-review">
            <p class="oc-orchestration-muted">{ticket.title}</p>
            <p class="oc-orchestration-muted">
              Project: {scope.directory} · Expires {new Date(ticket.expiresAt).toLocaleTimeString()}
            </p>
            <pre class="oc-orchestration-preview">{ticket.message}</pre>
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
  async function openReview(id: string) {
    const scope = current()
    if (!scope || busy()) return
    setBusy(true)
    try {
      review(scope, await actions.review(scope, id))
    } catch (cause) {
      setError(readable(cause))
    } finally {
      if (!disposed) setBusy(false)
    }
  }
  async function proposeModel(reset = false) {
    const scope = current()
    if (!scope || busy() || (!reset && !selection().trim())) return
    setBusy(true)
    try {
      review(scope, await actions.proposeModel(scope, slot(), reset ? null : selection().trim()))
    } catch (cause) {
      setError(readable(cause))
    } finally {
      if (!disposed) setBusy(false)
    }
  }
  async function inspect(runID: string) {
    const scope = current()
    if (!scope) return
    try {
      const result = await actions.run(scope, runID)
      if (!disposed) setRun(result)
    } catch (cause) {
      if (!disposed) setError(readable(cause))
    }
  }
  async function cancel(runID: string) {
    const scope = current()
    if (!scope || busy()) return
    setBusy(true)
    try {
      review(scope, await actions.proposeCancel(scope, runID))
    } catch (cause) {
      setError(readable(cause))
    } finally {
      if (!disposed) setBusy(false)
    }
  }
  createEffect(() => {
    const session = props.session
    const server = session.server
    const scope = current()
    // Reading the live client also reconciles after server re-authentication.
    const client = server.client
    generation++
    setState(undefined)
    setModels(undefined)
    setRun(undefined)
    setError("")
    setNotice("")
    setSelection("")
    setQuery("")
    if (!scope) return
    servers.set(server.id, server)
    untrack(() => {
      void refresh(scope)
      void loadModels()
    })
    const unsubscribe = client.rpc(desktopRpc).events.on(
      "changed",
      (event) => {
        if (
          event.data.sessionID !== scope.sessionID ||
          event.location?.directory !== scope.directory ||
          !sameScope(current(), scope)
        )
          return
        void refresh(scope)
      },
      { signal: ctx.signal },
    )
    // Visible panel only; idle views don't continuously poll the host.
    const poll = setInterval(() => {
      if (
        panel.visible() &&
        state()?.runs.some((item) => item.state === "running" || item.state === "stopping") &&
        sameScope(current(), scope)
      )
        void refresh(scope)
    }, 2500)
    onCleanup(() => {
      unsubscribe()
      clearInterval(poll)
    })
  })
  onCleanup(() => {
    disposed = true
    generation++
  })
  return (
    <section class="oc-orchestration" aria-label="Orchestration controls">
      <header class="oc-orchestration-heading">
        <div>
          <h2>Orchestration</h2>
          <p class="oc-orchestration-muted">
            Ask Orchestrator in chat to prepare a task. Review it here before it runs.
          </p>
        </div>
        <ctx.ui.Button variant="ghost" busy={loading()} onClick={() => void refresh()}>
          Refresh
        </ctx.ui.Button>
      </header>
      <Show when={!current()}>
        <p role="status">Open a connected project chat to use these controls.</p>
      </Show>
      <Show when={error()}>
        <p role="alert" class="oc-orchestration-error">
          {error()}
        </p>
      </Show>
      <Show when={notice()}>
        <p role="status" class="oc-orchestration-notice">
          {notice()}
        </p>
      </Show>
      <Show when={current()}>
        <section aria-labelledby="oc-pending">
          <h3 id="oc-pending">Pending approval</h3>
          <Show when={loading() && !state()}>
            <p role="status">Loading requests…</p>
          </Show>
          <Show when={state() && state()!.pending.length === 0}>
            <p class="oc-orchestration-muted">No pending requests. Nothing starts automatically.</p>
          </Show>
          <For each={state()?.pending}>
            {(ticket) => (
              <div class="oc-orchestration-row">
                <div>
                  <strong>{ticket.title}</strong>
                  <p class="oc-orchestration-muted">{ticket.kind} · Awaiting your decision</p>
                </div>
                <ctx.ui.Button disabled={busy()} onClick={() => void openReview(ticket.id)}>
                  Review
                </ctx.ui.Button>
              </div>
            )}
          </For>
        </section>
        <section aria-labelledby="oc-models">
          <h3 id="oc-models">Project models</h3>
          <p class="oc-orchestration-muted">
            These choices affect future plugin tasks, not your current chat model.
          </p>
          <dl class="oc-orchestration-models">
            <For each={slots}>
              {(name) => (
                <div>
                  <dt>{name}</dt>
                  <dd>{models()?.selections[name] ?? "Not selected"}</dd>
                </div>
              )}
            </For>
          </dl>
          <label class="oc-orchestration-field">
            Tier
            <select
              value={slot()}
              onChange={(event) => setSlot(event.currentTarget.value as (typeof slots)[number])}
            >
              <For each={slots}>{(name) => <option value={name}>{name}</option>}</For>
            </select>
          </label>
          <label class="oc-orchestration-field">
            Model or variant
            <ctx.ui.TextInput
              value={selection()}
              onInput={setSelection}
              label="Model or variant"
              placeholder="provider/model#variant"
              disabled={busy()}
            />
          </label>
          <div class="oc-orchestration-actions">
            <ctx.ui.Button
              disabled={busy() || !selection().trim()}
              onClick={() => void proposeModel()}
            >
              Review change
            </ctx.ui.Button>
            <ctx.ui.Button
              variant="ghost"
              disabled={busy()}
              onClick={() => void proposeModel(true)}
            >
              Reset tier
            </ctx.ui.Button>
          </div>
          <form
            class="oc-orchestration-search"
            onSubmit={(event) => {
              event.preventDefault()
              void loadModels()
            }}
          >
            <label class="oc-orchestration-field">
              Find a connected model
              <ctx.ui.TextInput
                type="search"
                value={query()}
                onInput={setQuery}
                label="Find a connected model"
                placeholder="Provider or model name"
                disabled={busy()}
              />
            </label>
            <ctx.ui.Button type="submit" busy={busy()}>
              Search
            </ctx.ui.Button>
          </form>
          <ul class="oc-orchestration-inventory">
            <For each={models()?.models}>
              {(model) => (
                <li>
                  <button
                    type="button"
                    disabled={!model.eligible || busy()}
                    onClick={() => setSelection(model.id)}
                  >
                    {model.id}
                  </button>
                  <Show when={!model.eligible}>
                    <span>Not eligible for custom agents</span>
                  </Show>
                  <Show when={model.variants.length > 0}>
                    <div class="oc-orchestration-variants">
                      <For each={model.variants}>
                        {(variant) => (
                          <button
                            type="button"
                            disabled={!model.eligible || busy()}
                            onClick={() => setSelection(`${model.id}#${variant}`)}
                          >
                            {variant}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={models()}>
            <div class="oc-orchestration-actions">
              <ctx.ui.Button
                disabled={busy() || (models()?.page ?? 1) <= 1}
                onClick={() => void loadModels((models()?.page ?? 1) - 1)}
              >
                Previous
              </ctx.ui.Button>
              <span>
                Page {models()?.page} of {models()?.pages}
              </span>
              <ctx.ui.Button
                disabled={busy() || (models()?.page ?? 1) >= (models()?.pages ?? 1)}
                onClick={() => void loadModels((models()?.page ?? 1) + 1)}
              >
                Next
              </ctx.ui.Button>
            </div>
          </Show>
        </section>
        <section aria-labelledby="oc-runs">
          <h3 id="oc-runs">This chat’s runs</h3>
          <Show when={state() && state()!.runs.length === 0}>
            <p class="oc-orchestration-muted">
              No runs yet. Approved tasks appear here; history clears on plugin restart.
            </p>
          </Show>
          <For each={state()?.runs}>
            {(item) => (
              <div class="oc-orchestration-run">
                <strong>{item.task}</strong>
                <p class="oc-orchestration-muted">
                  {item.agent} · {item.state}
                </p>
                <div class="oc-orchestration-actions">
                  <ctx.ui.Button disabled={busy()} onClick={() => void inspect(item.id)}>
                    View result
                  </ctx.ui.Button>
                  <Show when={item.state === "running" || item.state === "stopping"}>
                    <ctx.ui.Button
                      variant="ghost"
                      disabled={busy()}
                      onClick={() => void cancel(item.id)}
                    >
                      Review cancellation
                    </ctx.ui.Button>
                  </Show>
                </div>
              </div>
            )}
          </For>
          <Show when={run()}>
            {(value) => (
              <div class="oc-orchestration-result">
                <h4>Run details · {value().state}</h4>
                <p>Specialist evidence is self-reported, not independent verification.</p>
                <pre class="oc-orchestration-preview">
                  {value().summary}
                  {"\n\n"}
                  {value().result}
                </pre>
              </div>
            )}
          </Show>
        </section>
      </Show>
    </section>
  )
}

// Native GUI lifecycle/registration patterns:
// https://opencode.ai/v2/docs/build/plugins/gui
export default Plugin.define({
  setup(ctx) {
    ctx.add(
      Style,
      `.oc-orchestration{height:100%;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:24px;font-size:13px;line-height:1.5;color:inherit}.oc-orchestration h2,.oc-orchestration h3,.oc-orchestration h4{font-weight:600;margin:0 0 8px}.oc-orchestration h2{font-size:18px}.oc-orchestration-heading,.oc-orchestration-row{display:flex;align-items:start;justify-content:space-between;gap:12px}.oc-orchestration-muted{opacity:.75;margin:4px 0 10px;overflow-wrap:anywhere}.oc-orchestration-row,.oc-orchestration-run{padding:12px 0;border-bottom:1px solid color-mix(in srgb,currentColor 15%,transparent)}.oc-orchestration-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:10px 0}.oc-orchestration-field{display:flex;flex-direction:column;gap:6px;margin:12px 0}.oc-orchestration-field select{padding:8px;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:6px;background:transparent;color:inherit}.oc-orchestration-models{display:grid;gap:8px}.oc-orchestration-models>div{display:grid;grid-template-columns:100px minmax(0,1fr);gap:12px}.oc-orchestration-models dd{margin:0;overflow-wrap:anywhere}.oc-orchestration-models dt{font-weight:600}.oc-orchestration-inventory{list-style:none;padding:0;margin:12px 0;display:grid;gap:8px}.oc-orchestration-inventory li{overflow-wrap:anywhere}.oc-orchestration-inventory button,.oc-orchestration-variants button{cursor:pointer;text-align:left;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}.oc-orchestration-inventory button:disabled{cursor:not-allowed;opacity:.5}.oc-orchestration-inventory span{display:block;opacity:.65}.oc-orchestration-variants{display:flex;gap:10px;flex-wrap:wrap;font-size:12px}.oc-orchestration-error{padding:10px;border:1px solid currentColor;border-radius:6px;overflow-wrap:anywhere}.oc-orchestration-notice{padding:10px;border-left:3px solid #a8f5e9;white-space:pre-wrap;overflow-wrap:anywhere}.oc-orchestration-preview{font-family:inherit;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}.oc-orchestration-review{min-height:0;max-width:100%}.oc-orchestration :focus-visible{outline:2px solid currentColor;outline-offset:3px}.oc-orchestration-search{display:flex;align-items:end;gap:8px}.oc-orchestration-search>label{flex:1;min-width:0}`,
    )
    ctx.add(Panel, {
      id: "controls",
      region: "side",
      wide: true,
      mobile: { title: "Orchestration", icon: "task", order: 40, kind: "menu" },
      list: () => [TAB],
      render: (props) => <Controls ctx={ctx} session={props.session} />,
    })
    const open = () => {
      const session = ctx.sessions.current()
      if (session) ctx.layout.open(`${ctx.id}:controls`, session)
      else
        ctx.toast.show({
          title: "Open a project chat first",
          description: "Orchestration controls are scoped to the active chat.",
        })
    }
    ctx.add(Command, () => ({
      id: "controls",
      title: "Open Orchestration controls",
      description: "Model preferences, pending approvals and task results",
      group: "Orchestration",
      section: "session" as const,
      slash: { name: "orchestration" },
      run: open,
    }))
    ctx.add(MenuItem, {
      id: "controls",
      menu: "session.panel",
      title: "Orchestration",
      icon: "task",
      run: open,
    })
    // An event only announces an ID. Reconcile from the captured server/project,
    // including after reconnect, without broadcasting the task/context itself.
    createEffect(() => {
      const session = ctx.sessions.current()
      const scope = scopeOf(session)
      if (!session || !scope) return
      const client = session.server.client
      const known = new Set<string>()
      let active = true
      async function reconcile() {
        try {
          const value = unwrapRoutingReply(
            await client
              .rpc(desktopRpc)
              .state(
                { sessionID: scope!.sessionID },
                {
                  location: { directory: scope!.directory },
                  signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]),
                },
              ),
          ) as DesktopState
          if (
            !active ||
            ctx.signal.aborted ||
            !sameScope(scopeOf(ctx.sessions.current()), scope) ||
            value.sessionID !== scope!.sessionID ||
            value.directory !== scope!.directory ||
            !Array.isArray(value.pending)
          )
            return
          const fresh = value.pending.some((ticket) => !known.has(ticket.id))
          known.clear()
          for (const ticket of value.pending) known.add(ticket.id)
          if (fresh) {
            ctx.layout.open(`${ctx.id}:controls`, session!)
            ctx.toast.show({
              title: "Orchestration request ready",
              description:
                "Review the exact request in Orchestration. Nothing runs without your approval.",
              actions: [{ label: "Review", run: open }],
            })
          }
        } catch {
          // The panel provides actionable errors when explicitly opened. A
          // disconnected/missing remote plugin must not spam global dialogs.
        }
      }
      const unsubscribe = client.rpc(desktopRpc).events.on(
        "changed",
        (event) => {
          if (
            event.data.sessionID === scope.sessionID &&
            event.location?.directory === scope.directory
          )
            void reconcile()
        },
        { signal: ctx.signal },
      )
      void reconcile()
      onCleanup(() => {
        active = false
        unsubscribe()
      })
    })
  },
})
