# OpenCode Orchestrator

An early OpenCode V2 plugin foundation for a user-controlled, multi-agent workspace. It will coordinate specialized agents, route work to user-selected models, verify results, and produce terminal-friendly visual explanations.

## Current status

Phase 1 is intentionally small. It provides:

- a V2 server plugin entry at `src/index.ts`;
- a V2 terminal plugin entry at `src/tui.ts`;
- shared routing and agent contracts;
- Automatic, Guided, and Manual option parsing (Guided is the default);
- eight starter agent profiles under `.opencode/agents`;
- a development configuration and a package-install example;
- a non-destructive installer for the bundled agent profiles;
- formatting, strict type checking, tests, and build scripts.
- project-scoped model selections for small, mid, big and orchestrator;
- local slash commands for connected-model inventory, selections and task routing previews.

It can now run one approved task in a separate agent session, with rules-based difficulty and capability checks. Full multi-step orchestration, context handoffs and independent verification remain future work.

See [project decisions](DECISIONS.md) for user-controlled model assignments, planned context handoffs, and verification results.

The [optional workflow controls plan](PLAN.md) describes task-based model routing and nine separately selectable enhancements for future implementation.

## Requirements

- Bun 1.2 or newer
- OpenCode V2 compatible with `@opencode/plugin` 2.0.22
- At least one provider connected through OpenCode

This plugin never asks for or stores provider API keys. Connect providers with OpenCode itself.

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

The terminal commands call the server's `ai-orchestration.routing` RPC methods and display responses directly. The desktop browser workspace is not implemented yet; these slash controls are terminal features. The exported `./rpc` contract is reusable by future interfaces.

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

Automatic/Guided/Manual options still describe the future workflow modes; none bypasses the explicit single-task approval here. There is no graph scheduler, full context-transfer system or automatic verifier in this slice.

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

Phase 1 parses these options and records a non-secret diagnostic snapshot in OpenCode's plugin-scoped storage. Model-tier selections are stored separately by project. Workflows, session progress and user memory are not persisted yet. Mode-specific execution arrives with the orchestration engine.

## Project structure

```text
.opencode/agents/   OpenCode V2 Markdown agent profiles
examples/           consumer configuration examples
scripts/            safe preset installer
server.ts            local server-plugin entry
src/index.ts        server plugin entry
src/tui.ts          terminal plugin entry
src/shared/         shared contracts and option parsing
test/               Bun tests
tui.ts               local terminal-plugin entry
```

## Scripts

- `bun run format` formats the repository.
- `bun run typecheck` performs strict TypeScript checks.
- `bun test` runs the unit tests.
- `bun run build` validates both plugin entry points with Bun.
- `bun run check` runs every validation step.

## Security and publishing

- Never commit `.env` files, API keys, access tokens, or provider credentials.
- Keep credentials in OpenCode's provider connection system.
- The package is private during foundation work to prevent accidental publication.
- Choose and add an explicit open-source license before the first public release.

## Official V2 references

- [Plugin overview](https://opencode.ai/v2/docs/build/plugins) — `Plugin.define`, stable plugin IDs, lifecycle, options, package loading, and storage.
- [CLI plugin guide](https://opencode.ai/v2/docs/build/plugins/cli/) — `@opencode/plugin/tui`, terminal setup, notifications, and the `./tui` package export.
- [Agents](https://opencode.ai/v2/docs/agents) — plural `agents`, Markdown profiles, modes, permissions, steps, colors, and `provider/model` IDs.

This code targets V2 only. It intentionally does not import the legacy `@opencode-ai/plugin` package or use legacy singular configuration keys.
