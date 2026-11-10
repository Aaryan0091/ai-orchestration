# OpenCode Orchestrator

An OpenCode V2 plugin for a user-controlled, multi-agent workspace. The main experience is normal OpenCode Desktop chat with native review controls; the terminal remains supported. Full automatic coordination, independent verification and visual explanations are later work.

## Current status

The current `desktop-chat-controls` slice adds a native Orchestration panel around the existing approved, single-task runner. It provides:

- a V2 server plugin entry at `src/index.ts`;
- a V2 terminal plugin entry at `src/tui.ts`;
- a native Solid Desktop GUI entry at `src/gui.tsx`, exported as the prebuilt `dist/gui-experimental.cjs` bundle;
- Orchestrator chat tools that prepare task/model/cancellation requests, but cannot approve or start them;
- current-chat pending approvals, project model preferences, run status and result inspection through native controls;
- shared routing and agent contracts;
- Automatic, Guided, and Manual option parsing (Guided is the default);
- eight starter agent profiles under `.opencode/agents`;
- a development configuration and a package-install example;
- a non-destructive installer for the bundled agent profiles;
- formatting, strict type checking, tests, and build scripts.
- project-scoped model selections for small, mid, big and orchestrator;
- local slash commands for connected-model inventory, selections and task routing previews.

It can run one approved task in a separate agent session, with rules-based difficulty and capability checks, explicit context handoffs and structured specialist reports. The Desktop controls reuse that runner and the same project settings; they do not introduce a second execution engine. Full multi-step orchestration, automatic context collection, durable run history and independent verification remain future work.

See [project decisions](DECISIONS.md) for user-controlled model assignments, explicit handoff boundaries, and verification results.

The [optional workflow controls plan](PLAN.md) describes task-based model routing and nine separately selectable enhancements for future implementation.

## Requirements

- Bun 1.2 or newer
- OpenCode V2 with the native GUI-experimental plugin API; this project's SDK dependency is pinned to exact **`@opencode/plugin` 2.2.0**
- The native GUI bundle built with `bun run build` before loading it in Desktop
- At least one provider connected through OpenCode

This plugin never asks for or stores provider API keys. Connect providers with OpenCode itself.

## Use normal Desktop chat

### Build and enable the native part

From the repository, install the declared dependencies and build all parts:

```sh
bun install
bun run build
```

The GUI uses the official `@opencode/plugin/gui/vite` preset and must be a prebuilt CommonJS bundle at `dist/gui-experimental.cjs`. Desktop does not load `src/gui.tsx` as the GUI entry. The package exports `./gui-experimental`; server, TUI and RPC exports remain separate. A checkout or published package missing the bundle cannot provide the native controls.

The project's `opencode.jsonc` loads the server/TUI. Under the documented 2.2.0 loading contract, Desktop loads GUI parts from its **global** `opencode.json(c)` plugin entries, not merely from a project's entry. If you choose to enable this development checkout, add or reuse its entry in your existing global plugin list (normally `~/.config/opencode/opencode.jsonc`). Preserve existing settings and plugins; do not create a duplicate entry. We do not edit your global configuration automatically.

```jsonc
{
  "plugins": [
    { "package": "/Users/aaryangupta/Desktop/AI Orchestration " }
  ]
}
```

The checkout path is pasted inside the JSON quotes; keep its trailing space for this checkout. For another checkout, replace it with that folder's absolute path. Reload/restart Desktop after building/enabling the GUI, open this project, and select the **Orchestrator** agent in a project chat. In another project, install the bundled agent profiles first as described below. Connecting a provider and enabling a global plugin are user choices, not actions performed by this repository's build.

### Prepare, review and inspect

1. Open the command **Open Orchestration controls**, use the session panel's **Orchestration** entry, or select the Desktop `/orchestration` command. The panel belongs to the active project chat and server.
2. Under **Project models**, choose a Tier, search/select an exact connected model/variant, then select **Review change**. Review the frozen request and select **Apply model change** to save it, or Cancel to change nothing. **Reset tier** also prepares a change for approval. These preferences affect future plugin tasks, not the current chat's model.
3. Ask Orchestrator normally, for example:

```text
Prepare an easy Explorer task that returns DESKTOP_CHECK_OK using only that supplied marker, without reading or changing files. Let me review it before it runs.
```

4. The chat tool prepares a bounded request. In **Pending approval**, choose **Review**, read the complete scrollable task/context/models/cost warning, then select **Run task** only if you approve. Cancel or dismiss the review to discard the unapproved ticket. There is no model-callable approve/start tool. Asking the Orchestrator is still a normal model request and can use your provider quota; preparing or viewing a ticket does not itself start a specialist request. Approving a task can spend API credits.
5. Under **This chat's runs**, use **View result** or **Refresh** to inspect state and the structured report. Completion means the child returned a valid report, not that an independent verifier proved it correct. Evidence remains self-reported. For a running task, **Review cancellation** opens a separate frozen request; **Cancel running task** confirms it. Cancelling a review is not the same as cancelling an already-running task.

The Orchestrator tools are `orchestration_project_models`, `orchestration_prepare_handoff`, `orchestration_prepare_workflow`, `orchestration_prepare_model_change`, `orchestration_prepare_cancel` and `orchestration_desktop_status`. Existing report retrieval remains permission-gated. Normal informational chat need not use a specialist; the plugin does not disable OpenCode's other native capabilities.

Requests are bounded, expiring, single-use and tied to their origin chat/project. The GUI captures the server/chat identity and rejects stale replies, duplicate actions and approvals after switching context. Remote chats use their selected server, never an implicit local fallback. Reconnect or return to the original chat and refresh to reconcile pending requests. If an approval reply is lost, inspect that chat's runs before preparing another request; the first request may already have been consumed.

Current scope: the panel shows this chat's Desktop-controlled runs, not a full agent workspace or every terminal-created run. Requests/run ownership are in memory and disappear on plugin restart; no automatic replay occurs. Project model preferences persist separately. A successful bundle or mocked component test is not a native Desktop interaction pass; the current verification boundary is recorded below.

Developer checks: `bun run check` runs formatting, types, all tests and the server/TUI/native GUI builds. `bun test test/desktop-rpc-integration.test.ts test/gui-controller.test.ts test/gui-packaging.test.ts` focuses on native-control RPC integration, GUI request/decision logic and bundle packaging; those fixtures alone do not prove actual Desktop loading or visual interaction.

### Preview a multi-step workflow

Ask Orchestrator in the project chat:

```text
Draft a workflow preview only: Explorer outlines what to inspect, Planner proposes the change, and Verifier drafts checks. Make each step depend on the previous one. Do not inspect files or run anything.
```

Open **Orchestration → Workflow drafts → Review draft** in that same chat. The draft shows the dependency order, each specialist and objective, and the proposed model from your saved tier. A missing or unsuitable model appears as a blocker. After changing a saved tier, ask for a new draft to refresh the proposed models.

Drafts are preview-only: they never start specialist sessions, create executable approvals, or change model settings. **Close** keeps the draft; **Discard draft** removes it. To revise a plan, ask Orchestrator in the same chat for a new draft and discard the old one if you no longer need it. Drafts support up to 12 steps, are limited to five per chat, expire after 10 minutes, and clear on plugin restart. The normal Orchestrator chat request can still use your model quota.

### Verification and remaining native check

Latest checkpoint (2026-11-07): **115 tests / 816 assertions**, formatting, strict types and all builds pass. User screenshots now confirm native panel loading, project-scoped model review/apply and the saved selection surviving Refresh. The chat handoff initially failed with `No tool named`: OpenCode 2.2.5 defaults plugin tools to Code Mode, while our Orchestrator instructions call them directly. All six agent-facing orchestration tools now explicitly use `options.codemode: false`; the result tool retains its permission assertion. No approve/start tool was added.

An isolated real **OpenCode 2.2.5** server and localhost HTTP model fixture verified the native model tool list, actual chat tool execution into a pending handoff, discard without specialist dispatch, then approval of a separate handoff and one specialist generation returning `DESKTOP_CHECK_OK`. Run `ba86c953-8065-40cc-aa46-0ae7d3be29eb` completed with unverified report evidence. Test approvals used the Desktop RPC API, not GUI clicks. No real provider credits, user credentials or global settings were used/changed; the owned server/fixture were stopped. Temporary evidence: `/private/tmp/orchestration-tools.TBUIq5/evidence.json`. This is host/API acceptance with synthetic responses, not a fresh real-model or native GUI handoff acceptance pass.

After restarting OpenCode, repeat the bounded task prompt in a project chat with Orchestrator selected. It must create **Pending approval**, not merely describe a plan. Cancel one request and confirm no run, prepare another and review before **Run task**, then inspect **View result**. Real-provider execution can use quota and remains subject to provider/model availability. The historical native attempt below is superseded only for the interactions explicitly confirmed above; chat-switch/reconnect and post-fix GUI task acceptance remain manual checks.

#### Historical isolated native attempt

Automated checkpoint (2026-10-29): **114 tests / 814 assertions**, formatting, strict types and server/TUI/GUI builds pass. Coverage includes frozen requests, no model-accessible approval/start, current-chat/server isolation, stale replies, duplicate clicks, dismissal, reconnect reconciliation and GUI packaging. These are automated contract/controller/packaging checks, not a claim of installed Desktop interaction.

The isolated native attempt started a localhost model fixture on port 43991, an isolated service on 43992, and the Desktop executable with `OPENCODE_DESKTOP_TEST_ROOT`. The main-process log identified **OpenCode Desktop 2.2.0** and a visible main window/test-root CLI. However, the first Computer Use `getApp("OpenCode")` call hung and was aborted after about **1,019.6 seconds**, returning no inspectable GUI state or screenshot; no plugin control click or approval was observed. A visible main window does **not** establish plugin loading or a working native interaction. No native plugin loading/visual/approval acceptance pass is claimed; the older handoff acceptance later in this README does not prove the new Desktop flow.

The owned app, fixture and service were stopped, with no remaining listeners on 43991/43992. No global plugin configuration or provider keys were changed and no update/install command was issued. Launching OpenCode nevertheless triggered its own auto-updater to stage/copy an already-downloaded update in user Library caches/ShipIt. Those caches were left untouched; the bundled CLI still reported 2.2.0. The attempt therefore must not be described as having zero global cache side effects.

Still check in the installed Desktop app after manual setup: open **Orchestration** in a project chat; search/review/apply a model preference without switching the chat model; ask Orchestrator to prepare a bounded task; inspect the full scrollable review and visible actions; cancel one unapproved request with no child starting; approve a separate task only when ready for potential API spending; then inspect this chat's result. Also verify switching chat/server disables the old review and that Refresh reconciles state after reconnect. Keep the app open through the test because run ownership is not persistent. Native acceptance remains pending until these actual interactions are observed.

## Select models and preview routing

Run these **inside OpenCode's terminal chat input**, not your shell. Results appear in a local dialog; press Escape to return to chat.

```text
/orchestration-models list
/orchestration-models list 2
/orchestration-models show
```

The inventory is paginated to fit terminal dialogs. Follow the next-page instruction if more models are available. Copy actual provider/model IDs from the list. `PROVIDER/MODEL` below is a placeholder: replace it with one of those exact IDs, not the literal placeholder. Models from OpenRouter may have additional slashes: keep the full ID. A variant is optional and must appear in the model's listed variants; append `#VARIANT` with the actual variant ID. Listing a model confirms inventory eligibility, not provider-side quota, billing or successful generation.

```text
/orchestration-models set small PROVIDER/MODEL
/orchestration-models set mid PROVIDER/MODEL
/orchestration-models set big PROVIDER/MODEL
/orchestration-models set orchestrator PROVIDER/MODEL
/orchestration-route easy find the configuration files
/orchestration-route medium review a change
/orchestration-route hard investigate a complex bug
/orchestration-route easy --model PROVIDER/MODEL inspect one file
/orchestration-models reset small
/orchestration-models reset
```

The final reset clears all model selections for the current project. Saved selections survive plugin reloads, are versioned and keyed by project directory, and are revalidated against the currently enabled OpenCode inventory. Invalid settings require an explicit reset; startup never replaces saved selections. OpenCode's `opencode/*-free` models are listed but rejected for our custom agents.

The terminal commands call the server's `ai-orchestration.routing` RPC methods and display responses directly. These particular slash controls remain terminal features; native Desktop chat uses the Orchestration controls above and the separate `ai-orchestration.desktop` contract defined in `src/desktop-rpc.ts`. A full browser/agent workspace is not implemented. The exported `./rpc` retains the terminal/server routing contract.

Routing maps easy/medium/hard to small/mid/big, unless you provide a model override. `auto` uses conservative local keyword/scope rules, not an AI confidence score; ambiguous tasks default to medium. Confirmed inventory capabilities (text, tools and image input/output) are checked before approval. The orchestrator selection is reserved for the future workflow planner; single-task runs do not call it. Costs remain unknown.

## Run and check a routed task

Inside OpenCode chat:

```text
/orchestration-route auto read README and summarize it
/orchestration-run auto --agent explorer read README and summarize it without changing files
/orchestration-policy show
```

The first command is a **free local preview** (no provider generation). The second opens an approval dialog showing the agent, difficulty, exact primary/retry models and permission/cost warning. Choose Cancel to start nothing, or Run task to send the task to the provider and potentially spend credits. Explorer is the default; explicitly select builder/debugger/reviewer/verifier/planner/visualizer when appropriate. Existing agent permissions still apply. Your current chat model never changes. Every attempt has a separate session, visible in OpenCode's session list.

The result displays a run ID. Replace `RUN_ID` with that exact ID:

```text
/orchestration-run status RUN_ID
/orchestration-run cancel RUN_ID
```

Status shows running/stopping/completed/failed/cancelled and child session IDs. Open the child session for full output. Completed means the session finished normally, **not** that an independent verifier proved the result correct. Cancellation interrupts the actual session; uncertain interruption remains stopping, retains its active slot and permits another cancel attempt, never falsely reported as stopped. Runs/history are in memory only, with at most three active runs and 200 retained records; status is lost on plugin restart. The default deadline is ten minutes. An interrupted create request can leave an empty, unprompted session; no generation starts without an acknowledged session ID.

Validation failures, such as an unselected tier, appear as actionable routing errors; they do not open approval or start a session. OpenCode's built-in retry is disabled only while the plugin owns an active child session, so hidden provider retries cannot bypass the approved attempt count. Ordinary user chats are untouched. A terminal provider error is reported as failed only with sufficient session-stop evidence; an uncertain stop remains stopping and holds its active slot.

For a short manual acceptance check:

1. Run `/orchestration-models show` and confirm the selected tier matches your choice; restart OpenCode and confirm it remains saved.
2. Run `/orchestration-route easy --agent explorer read README` and confirm the small-tier model; preview must not create a session or make a generation request.
3. Run `/orchestration-run easy --agent explorer read README and summarize it in three short points without changing files`. First choose Cancel and confirm no session starts; repeat only when ready to approve a potentially billable request.
4. Use the displayed run ID with `/orchestration-run status RUN_ID`. Open its child session and check the answer, selected model and completed status. Your original chat model and project files should be unchanged.
5. If the provider rejects the request, check for a clear failed status and provider error. Status checks do not resend the task. Do not start repeated runs while a previous one is still running or stopping. Test cancellation on a separate approved run only if needed; it must stop the child, not merely close the dialog.

Connect credentials through OpenCode only. Do not paste API keys into chat, screenshots or this repository. Provider-side quota or billing errors do not prove a missing credential connection.

## Optional routing controls

These controls are separately opt-in and project-scoped; default is no reasoning override, no fallback, no escalation, zero retries. Replace `VARIANT` with a variant listed for **every approved candidate**, and `PROVIDER/MODEL` with a connected model ID:

```text
/orchestration-policy reasoning easy VARIANT
/orchestration-policy reasoning easy off
/orchestration-policy fallback small PROVIDER/MODEL
/orchestration-policy fallback small off
/orchestration-policy escalation on
/orchestration-policy escalation off
/orchestration-policy retries 1
/orchestration-policy reset
```

Reasoning uses OpenCode's actual named variants, not invented universal effort levels. A per-task `--model PROVIDER/MODEL#VARIANT` wins over the difficulty default. Fallback selects one alternative in the same tier; escalation then considers your configured higher tiers. Retries are bounded to 0–3, revalidate all candidates before approval and repeat **only this one task**. Automatic replay is limited to confirmed pre-generation provider failures without tool activity or output; permission, credentials, cancellation and ambiguous failures never retry. No unsafe side-effect replay control is exposed. Long tasks, edits and verification failures require inspection/new approval rather than automatic repetition. Policies affect newly prepared runs; previously approved tickets bind their exact task/models/policy, are single-use and expire after ten minutes.

Automatic/Guided/Manual options still describe the future workflow modes; none bypasses the explicit single-task approval here. There is no graph scheduler, automatic context collector or automatic verifier in this slice.

## Explicit context handoffs

`/orchestration-handoff` sends a caller-selected context package to one specialist through the same isolated, model-routed, approved runner. It does not copy an active conversation or secretly read files. The package contains an objective, project-relative file references and optional excerpts, findings, constraints, prior run summaries, and acceptance checks. See the complete [example request](examples/handoff.json).

Paste this **inside OpenCode chat** for a free local preview. JSON's quotes are part of its syntax; paste the complete command including the entire object:

```text
/orchestration-handoff preview {"agent":"explorer","difficulty":"easy","handoff":{"version":1,"objective":"Summarize the supplied excerpt in one sentence without tools.","files":[{"path":"README.md","content":"This is an OpenCode orchestration plugin."}],"findings":[],"constraints":["Do not read or change files; use only the supplied excerpt."],"previousResults":[],"acceptanceChecks":["Summary identifies an OpenCode orchestration plugin"]}}
```

To run, use the same command with `run` instead of `preview`, review the **full** context/model warning, then choose Run task. Cancel/Escape starts nothing. Running may spend API credits. Model overrides use an optional top-level `"model":"provider/model#variant"`, with an exact connected inventory ID. Each package is cloned before asynchronous work and bound to a single-use, expiring approval; later edits cannot change that run.

Use the returned ID:

Long previews, reports and approvals are split into terminal-sized pages so the bottom and buttons stay visible. Use **Next** and **Previous** (arrow keys to select, Enter to activate); **Esc** closes a preview or cancels approval. **Run task** is offered only on the last approval page, after the complete context and cost warning. Resizing during a paged dialog reflows it from page one; it never approves a task. Below 48 columns × 20 rows, enlarge the terminal and retry; approval is blocked rather than hidden. Short messages retain the normal single dialog. Restart the OpenCode terminal after updating the plugin to use the new dialogs.

Dialog overflow regression (2026-10-22): all 86 tests / 617 assertions, types, formatting, build and whitespace checks passed. An isolated OpenCode 2.1.2 TUI fixture at 80×24 displayed Next/Previous, reached the final content/cost warning, showed Run task only on the final approval page, and returned cancellation after Escape there. The fixture used local synthetic text only; no provider generation or user settings were used. This checks pagination, not a fresh real-model handoff response.

```text
/orchestration-run status RUN_ID
/orchestration-run result RUN_ID
/orchestration-run cancel RUN_ID
```

`result` returns JSON with run state, objective, specialist, attempt models/session IDs and a parsed report: summary, findings, evidence, acceptance-check statuses and limitations. `evidenceVerified` is always false: these are **untrusted specialist claims**, not independent verification. Completed means the child finished and returned a valid report, not that all checks passed. Running/failed/cancelled results have no fabricated report. Invalid or incomplete report JSON fails the run without automatic replay; inspect the child session for original output. Earlier assistant/tool narration is excluded when parsing the final report.

The orchestrator can read a supplied existing run ID through the read-only `orchestration_handoff_result` tool, subject to the narrow `orchestration_result` ask permission. The tool explicitly awaits the host's native `permission.assert` for that exact run ID before looking up a report: its permission label alone does not request approval. Rejection, cancellation or an aborted call returns no report. Hosts without this capability fail closed for the tool; the explicit `/orchestration-run result RUN_ID` command remains available. Other agents are rejected. The tool sees only this project's in-memory runs; it cannot prepare, approve, start, or resume work. To pass findings onwards, explicitly select a previous report's summary and run ID into a new package's `previousResults`, then preview/approve that new handoff. This is not an automatic orchestrator loop or dependency scheduler.

Safety/limits: unknown JSON fields are rejected; no custom permission/settings fields are accepted. The package is limited to 48,000 serialized characters, 20 entries per list, 20,000 characters for the objective, 8,000 per excerpt, 4,000 per finding/constraint/check/previous summary, and 500 per relative path. Each acceptance check must be unique. The command request is limited to 60,000 characters. The plugin adds no context database; run lookup remains in memory, but prompts/packages/reports are part of normal OpenCode child sessions and follow the host's storage/retention. File references and natural-language constraints **do not create a filesystem sandbox**: the chosen agent retains its existing OpenCode permissions. Verify freshness yourself and review all supplied context for secrets before sending it to a provider. Independent checking, automatic stale-context detection and recovery after restart are not implemented.

Developer checks: `bun run check` covers the complete suite. `bun test test/handoffs.test.ts test/execution-integration.test.ts test/rpc-errors.test.ts` focuses on handoff validation, immutable context, report/provenance retrieval, read-tool restrictions, actual adapter-shaped delivery, RPC errors, cancellation and approval. These deterministic fixtures do not prove a fresh real-provider response or interactive dialog layout; perform the preview/cancel/run/status/result sequence above when ready to approve a provider request.

Historical context-handoffs branch acceptance (2026-10-28): **89 tests / 655 assertions**, types, formatting, build, working-tree and staged Git whitespace checks passed. An isolated real OpenCode **2.2.0** host using a synthetic localhost HTTP model fixture completed handoff run `339e189d-d43c-4818-8d15-06f7a0021f33`. Its actual result RPC returned `completed`, `HANDOFF_CHECK_OK` and `evidenceVerified:false`; reading it again made no extra generation request. A fixture-driven Orchestrator tool call produced a real pending native `orchestration_result` permission for that exact run ID. Rejection withheld the report; a separate one-time approval returned it, and an Explorer call was blocked. All seven model requests went to the local fixture, not a paid provider. Native permission replies were tested through the API, not by clicking the interactive TUI prompt. The owned server and fixture were stopped; no user credentials/global settings were used or changed and no app upgrade was performed. Evidence remains under `/private/tmp/handoff-final.tVS373/` (`evidence.json`, redacted `server-output.txt`). This verifies host/plugin transport and permission enforcement, not a fresh real-provider answer, an independent verifier, or the full future workflow.

Historical loading check (2026-10-22): all **78 tests (349 assertions)**, formatting, types, build and Git whitespace checks passed. Independently, the installed OpenCode CLI **2.1.2** loaded the plugin (including its awaited tool transform) in an isolated localhost server under `/private/tmp/handoff-runtime-NHDBdk`. Actual handoff RPC requests rejected an invalid payload with the handoff validation error and returned the actionable missing-small-tier error for a valid preview; an unknown result lookup returned Unknown task run. The session list remained empty before and after. No provider credentials or generation were used, and the server was stopped. That check covered loading/local validation only; the later final acceptance above covers result retrieval and native permission enforcement. Neither check establishes a new real-provider handoff response or compatibility with every OpenCode release.

This runner transports text tasks only, not attached images/files or generated media. Image-generation requests are rejected locally; ASCII/Mermaid text explanations remain supported. Use OpenCode's media tools directly for images.

Historical live checks on 2026-10-13 used official standalone OpenCode 2.0.28 in isolated temporary directories; the installed desktop at that check was 2.0.26 and dependency types remain 2.0.22. Model configuration, auto preview, approval cancellation and isolated dispatch were checked. The zero-cost `opencode/big-pickle` provider rejected our custom agent; it is now marked ineligible, just like `opencode/*-free`.

Branch-finish checks on 2026-10-20 use the latest official isolated CLI verified for that run, OpenCode 2.0.32. A controlled local HTTP model fixture completed a routed task (1/1 attempt) and returned a 429 failure (1/1 attempt, exactly one HTTP request, no hidden retry). The interactive TUI rendered the missing-small-tier error and its exact setup command instead of a generic Request failed. These latest-version checks verify the real OpenCode/plugin transport, terminal error rendering and state handling against deterministic responses, **not a real model's answer**. No provider credential or global setting was changed for the isolated checks.

The separate real-provider acceptance check also passed on 2026-10-20 using the installed OpenCode 2.0.28 and the user's existing Google connection: explorer on the saved small-tier `google/gemini-3.8-flash` returned `ROUTING_LIVE_OK`, completed 1/1 attempt, and ended with session outcome succeeded/finish stop. No tools, fallback, retry or variant override were used; the original chat model stayed unchanged. Observed API cost was $0.0035865. This establishes a real routed text response, not a README-reading/tool-use or independent-verification acceptance test. Real-provider generation on latest isolated 2.0.32 was not tested. Earlier model/quota failures remain historical, not the outcome of this successful run. All 69 tests (289 assertions), types, formatting, build and Git whitespace checks passed; changes remain uncommitted for the user's review.

## Develop locally

```sh
bun install
bun run check
opencode
```

The root `opencode.jsonc` loads this repository through its local `server.ts` and `tui.ts` entrypoints and selects the bundled `orchestrator` agent. The terminal plugin shows an "AI Orchestration ready" notification on startup. OpenCode passes project options only to the server plugin. To disable the notification during local development, add an entry to the `plugins` list in the global `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/your/checkout",
      "options": { "notifyOnLoad": false }
    }
  ]
}
```

Replace the path with your checkout's absolute path; paste it inside the quotes. Preserve any other settings and plugin entries already in that file. Use the local checkout path while developing: the npm package name would attempt to resolve a published package instead. Startup visibility and disabling with the absolute local path were verified in an interactive OpenCode 2.0.22 terminal on 2026-10-11, with isolated configuration and data directories.

## Use the sample configuration

`examples/opencode.jsonc` shows the package form expected after publication. OpenCode does not automatically discover agent Markdown files inside an installed npm package, so install the bundled profiles in the consuming project first:

```sh
bunx opencode-orchestrator --target .
```

The installer creates `.opencode/agents`, never overwrites an existing profile by default, and reports installed and skipped counts. Add `--force` only when you intentionally want to replace profiles. After installing them, add `"default_agent": "orchestrator"` to the consuming project's `opencode.jsonc` if you want the orchestrator selected for new sessions.

OpenCode discovers the model connections the user already configured. The starter profiles deliberately omit `model`, so subagents inherit the parent session model. To assign a model to one agent, add a model field to that agent's frontmatter:

```yaml
model: provider/model-id
```

Use `opencode models` to list valid IDs. Users can select a different model for a session in OpenCode without changing this repository.

## Plugin options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-orchestrator",
      "options": {
        "mode": "guided",
      },
    },
  ],
}
```

Supported modes:

- `automatic`: the orchestrator chooses the workflow with minimal interruption;
- `guided`: the orchestrator proposes important choices for user review;
- `manual`: the user chooses assignments and execution order.

These options are parsed and recorded in a non-secret diagnostic snapshot in OpenCode's plugin-scoped storage. Model-tier selections are stored separately by project. Workflows, session progress and user memory are not persisted yet. Full mode-specific execution remains future orchestration-engine work.

## Project structure

```text
.opencode/agents/   OpenCode V2 Markdown agent profiles
examples/           consumer configuration examples
scripts/            safe preset installer
server.ts            local server-plugin entry
src/index.ts        server plugin entry
src/tui.ts          terminal plugin entry
src/gui.tsx         native Desktop controls
src/gui-controller.ts  scoped GUI request/approval coordination
src/desktop-*.ts    Desktop RPC, tickets and chat tools
src/shared/         shared contracts and option parsing
dist/gui-experimental.cjs  prebuilt native GUI entry
vite.config.ts      official GUI CommonJS build preset
test/               Bun tests
tui.ts               local terminal-plugin entry
```

## Scripts

- `bun run format` formats the repository.
- `bun run typecheck` performs strict TypeScript checks.
- `bun test` runs the unit tests.
- `bun run build:server` builds the server and TUI entries with Bun.
- `bun run build:gui` builds the native GUI-experimental CommonJS bundle with Vite.
- `bun run build` builds all three plugin parts.
- `bun run check` runs every validation step.

## Security and publishing

- Never commit `.env` files, API keys, access tokens, or provider credentials.
- Keep credentials in OpenCode's provider connection system.
- The package is private during foundation work to prevent accidental publication.
- Choose and add an explicit open-source license before the first public release.

## Official V2 references

- [Plugin overview](https://opencode.ai/v2/docs/build/plugins) — `Plugin.define`, stable plugin IDs, lifecycle, options, package loading, and storage.
- [CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli/) — `@opencode/plugin/tui`, terminal setup, notifications, and the `./tui` package export.
- [GUI plugin guide](https://opencode.ai/v2/docs/build/plugins/gui) — native Desktop parts, global loading, host components and the prebuilt CommonJS bundle.
- [Agents](https://opencode.ai/v2/docs/agents) — plural `agents`, Markdown profiles, modes, permissions, steps, colors, and `provider/model` IDs.

This code targets V2 only. It intentionally does not import the legacy `@opencode-ai/plugin` package or use legacy singular configuration keys.
