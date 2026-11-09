# Desktop chat controls — branch plan

Branch: `desktop-chat-controls`. Base: committed context handoffs (`4d99728`).

Status (2026-11-07): **115 tests / 816 assertions**, formatting, types and server/TUI/GUI builds pass. SDK remains pinned to **2.2.0**; isolated installed host **2.2.5** acceptance now confirms native chat tool exposure, actual pending handoff, discard without dispatch and approved synthetic specialist completion. Fixed the direct-call/Code Mode mismatch with explicit `codemode: false` on all six agent-facing tools. User screenshots confirm native panel loading, correct-project model review/apply and retention after Refresh. Post-fix native GUI task approval/result, chat-switch and reconnect interaction still need manual acceptance; do not infer these from RPC approvals or synthetic generation. See the latest README checkpoint; the October attempt below is historical.

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

## Phase 1 — server controls and native GUI (implemented)

### Server responsibilities

- Register Orchestrator-only structured chat tools that propose an explicit handoff or a model-tier change and read owned run status. User prompts remain ordinary text; users do not paste JSON or terminal commands.
- Keep mutations behind native GUI approval. Do **not** expose generic `execution.start(id)` or an approve/start tool to the model. Missing/stale agent rules must never turn a model proposal into spending approval.
- Store bounded, expiring in-memory tickets bound to the actual origin session and plugin project. Handoff tickets reuse the existing immutable plan; model-change tickets freeze the exact slot/selection. Cancellation uses the same explicit user gate.
- Add a separate typed desktop RPC contract for pending/review/approve/discard, current settings/inventory and owned run inspection. The trusted GUI approves exactly the fetched ticket, not an editable replacement.
- Validate ownership, payload shape, expiry, duplicate approval and aborts. Consume/lock tickets before asynchronous mutations. No automatic side-effect retries, approval on disconnect or file/history collection.
- Update Orchestrator instructions with proposal/review/status behaviour and honest completion language.

### GUI responsibilities

- Project dependency is exact `@opencode/plugin` **2.2.0**, with the declared matching GUI/TUI build dependencies. No global OpenCode upgrade or global plugin installation without separate user approval.
- Copy the official Solid GUI/CommonJS build pattern; keep server-only imports out of the GUI bundle. Extend format/type/build/packaging checks to include the new entry.
- Add a native command/panel for model preferences, pending approvals and current-session runs. React to scoped proposal events and reconcile after reconnect/open.
- Show the complete task/context, model candidates, permissions/cost warning and action type in a scrollable review area with fixed Approve/Cancel actions. Never hide approval details or auto-approve.
- Use host components/theme where possible, visible labels/focus, keyboard dismissal, accessible loading/errors and the existing mint accent where appropriate. Avoid marketing-page styling and external assets/fonts.
- Guard session/server changes, stale replies, duplicate clicks, dismissal and cleanup. No raw HTML rendering of model/context strings.

### User setup and workflow

- Build with `bun install` then `bun run build`; `./gui-experimental` exports `dist/gui-experimental.cjs`, not raw TSX. The official Vite GUI preset builds that one CommonJS bundle.
- The documented 2.2.0 Desktop contract loads GUI parts from global `opencode.json(c)` plugin entries. Enabling the checkout there is a manual user choice that preserves existing entries; project-only server/TUI loading is not a GUI installation. This branch does not mutate the user's global setup.
- Open a project chat as Orchestrator and use **Open Orchestration controls**, the session's **Orchestration** panel entry or Desktop `/orchestration`. Set a tier through **Project models → Review change → Apply model change**. Saved preferences affect future plugin tasks, not the active chat model.
- Ask normally in chat. The proposal tools prepare handoff/model/cancellation requests but cannot approve/start. **Pending approval → Review** shows the complete scrollable immutable request with persistent actions. **Run task** dispatches; Cancel/dismiss discards the unapproved ticket. Normal chat still uses model quota; merely preparing/reading a ticket starts no specialist generation.
- **This chat's runs → View result** reads owned state/report; **Review cancellation → Cancel running task** gates cancellation separately. Switch/disconnect/reconnect requires returning to the right chat/server and refreshing; never blindly retry after a lost approval response.
- Keep terminal regression coverage. In-memory requests/ownership disappear at restart; persistence, automatic task graphs, independent verification, full agent workspace and visualizer remain outside this branch.

## Phase 2 — verification

- Automated Phase 3 checkpoint (2026-10-29): **114 tests / 814 assertions**, formatting, strict types and server/TUI/GUI build pass. This is an automated checkpoint, not a claim that the installed Desktop GUI has loaded or been clicked successfully.
- Automated: no model-accessible start/approve; proposing is generation/mutation-free; ownership/expiry/replay/mutation rejection; GUI cancellation/dismissal starts nothing; settings validation and serialization; status/results read without generation; no active-chat model switch.
- GUI build/interaction tests: panel opens, scoped pending requests appear, full content/actions are reachable, loading/error/empty states, wrong-session/server blocking, cleanup and reconnect reconciliation.
- Isolated real-host/local HTTP model fixture: natural-chat tool proposal → frozen pending ticket → explicit trusted UI approval → isolated specialist → owned status/result. Confirm no work before approval, denied tickets do nothing, model changes target only approved tiers, and terminal regressions remain green.
- Native Desktop loading and visual interaction where safely available with isolated settings; otherwise document that exact limit, not a claimed live pass. Do not spend real provider credits for acceptance.

## Phase 3 — independent review and handoff

- Run the complete format/types/tests/server+TUI+GUI build and both working-tree/staged whitespace checks.
- Review approval boundaries, permissions, lifecycle, data isolation, packaging and undocumented/deprecated API usage independently.
- Record exact versions, commands, evidence and remaining limits in README/PLAN/DECISIONS. Keep persistent history and the full multi-agent workspace as later work.
- Leave all changes for the user's review and commit.

### Native acceptance attempt and remaining boundary (2026-10-29)

- The isolated verifier launched a localhost model fixture on 43991, an isolated service on 43992 and the Desktop executable with `OPENCODE_DESKTOP_TEST_ROOT`. Main-process logs identified **Desktop 2.2.0**, a visible main window and the test-root CLI. The first Computer Use `getApp("OpenCode")` call hung and was aborted after approximately **1,019.6 seconds**. No inspectable GUI state/screenshot or plugin control click/approval was returned. A visible main window is not evidence that this native plugin loaded or its controls worked.
- The owned app/fixture/service were stopped and no listeners remained on 43991/43992. No global plugin configuration or provider keys were changed; no update/install command was issued. OpenCode's own auto-updater staged/copied an already-downloaded update into user Library caches/ShipIt on launch. The caches were left untouched and the bundled CLI remained 2.2.0; zero global cache side effects are not claimed.
- Native loading, full-review layout and the ordinary-chat → pending request → user approval → child → result flow remain unverified in the installed Desktop app. The previous context-handoffs real-host acceptance does not cover this new GUI/RPC workflow.
- After manual build/global registration, observe the native command/panel and model search/review/apply; confirm the current chat model is unchanged; inspect full task/context and reachable actions; dismiss/cancel an unapproved request with no child starting; separately approve only an intended test and inspect the owned result; check wrong-chat/server blocking and reconnect Refresh. A real provider request can spend credits and is a user-approved test, not an automatic follow-up.
- Keep persistent run history, full scheduling, independent verification, the agent workspace and visualizer outside this branch. No global installation/configuration changes or commits are performed by this documentation/update workflow.
