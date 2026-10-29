# Desktop chat controls — branch plan

Branch: `desktop-chat-controls`. Base: committed context handoffs (`4d99728`).

## Outcome and boundaries

Use the existing plugin through normal OpenCode Desktop chat, with native desktop controls for explicit approval, model preferences, status and result inspection. No separate web app, new agent framework, model training, automatic workflow scheduler, durable run history, worktrees or visualizer in this slice. Preserve terminal behaviour. Never commit, stage, push, merge or change global settings as part of implementation.

## Phase 0 — documented API discovery (complete)

- Server tool pattern: `src/handoff-tool.ts`, with role/input validation and native permission assertions for result reads. `options.permission` alone does not request approval.
- Reuse `createRoutingCommands` (`src/routing.ts`), `createExecutionCommands` (`src/execution-commands.ts`) and the existing isolated engine (`src/execution.ts`). Do not create a second runner or settings store.
- Native GUI: https://opencode.ai/v2/docs/build/plugins/gui — package/build/shared modules, commands, panels, sessions, dialogs and UI components. `./gui-experimental` is one prebuilt CommonJS bundle using the official `@opencode/plugin/gui/vite` preset. Verify selected SDK declarations and installed host before implementation; do not invent unsupported GUI types.
- GUI `ctx.sessions.current()` provides the current session/project/server. Capture and recheck that identity at approval time; never mix a remote session with the local server.
- GUI `ctx.dialogs.open(render)` and `ctx.ui.Dialog` provide a native dialog; there is no documented `onClose` prop. Use component cleanup for dismissal and a scrollable body with visible actions.
- RPC: https://opencode.ai/v2/docs/build/plugins/rpc — typed registrations/events; events include location and are live-only. Use an event as a notification, then fetch/reconcile pending tickets. Do not send full context in broadcast events.
- Shared GUI contracts must import from `@opencode/plugin/rpc`, not the server-only root.

## Phase 1 — server controls and native GUI

### Server responsibilities

- Register Orchestrator-only structured chat tools that propose an explicit handoff or a model-tier change and read owned run status. User prompts remain ordinary text; users do not paste JSON or terminal commands.
- Keep mutations behind native GUI approval. Do **not** expose generic `execution.start(id)` or an approve/start tool to the model. Missing/stale agent rules must never turn a model proposal into spending approval.
- Store bounded, expiring in-memory tickets bound to the actual origin session and plugin project. Handoff tickets reuse the existing immutable plan; model-change tickets freeze the exact slot/selection. Cancellation uses the same explicit user gate.
- Add a separate typed desktop RPC contract for pending/review/approve/discard, current settings/inventory and owned run inspection. The trusted GUI approves exactly the fetched ticket, not an editable replacement.
- Validate ownership, payload shape, expiry, duplicate approval and aborts. Consume/lock tickets before asynchronous mutations. No automatic side-effect retries, approval on disconnect or file/history collection.
- Update Orchestrator instructions with proposal/review/status behaviour and honest completion language.

### GUI responsibilities

- Align the project SDK/build dependencies to the exact verified GUI-capable version; no global OpenCode upgrade or global plugin installation without separate user approval.
- Copy the official Solid GUI/CommonJS build pattern; keep server-only imports out of the GUI bundle. Extend format/type/build/packaging checks to include the new entry.
- Add a native command/panel for model preferences, pending approvals and current-session runs. React to scoped proposal events and reconcile after reconnect/open.
- Show the complete task/context, model candidates, permissions/cost warning and action type in a scrollable review area with fixed Approve/Cancel actions. Never hide approval details or auto-approve.
- Use host components/theme where possible, visible labels/focus, keyboard dismissal, accessible loading/errors and the existing mint accent where appropriate. Avoid marketing-page styling and external assets/fonts.
- Guard session/server changes, stale replies, duplicate clicks, dismissal and cleanup. No raw HTML rendering of model/context strings.

## Phase 2 — verification

- Automated: no model-accessible start/approve; proposing is generation/mutation-free; ownership/expiry/replay/mutation rejection; GUI cancellation/dismissal starts nothing; settings validation and serialization; status/results read without generation; no active-chat model switch.
- GUI build/interaction tests: panel opens, scoped pending requests appear, full content/actions are reachable, loading/error/empty states, wrong-session/server blocking, cleanup and reconnect reconciliation.
- Isolated real-host/local HTTP model fixture: natural-chat tool proposal → frozen pending ticket → explicit trusted UI approval → isolated specialist → owned status/result. Confirm no work before approval, denied tickets do nothing, model changes target only approved tiers, and terminal regressions remain green.
- Native Desktop loading and visual interaction where safely available with isolated settings; otherwise document that exact limit, not a claimed live pass. Do not spend real provider credits for acceptance.

## Phase 3 — independent review and handoff

- Run the complete format/types/tests/server+TUI+GUI build and both working-tree/staged whitespace checks.
- Review approval boundaries, permissions, lifecycle, data isolation, packaging and undocumented/deprecated API usage independently.
- Record exact versions, commands, evidence and remaining limits in README/PLAN/DECISIONS. Keep persistent history and the full multi-agent workspace as later work.
- Leave all changes for the user's review and commit.
