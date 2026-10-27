# Project decisions

## Context-handoffs final acceptance (2026-10-28)

- Result retrieval and permission enforcement are verified on the installed OpenCode **2.2.0** host with an isolated synthetic localhost HTTP model fixture. Run `339e189d-d43c-4818-8d15-06f7a0021f33` completed; the real result RPC returned `HANDOFF_CHECK_OK`, provenance and `evidenceVerified:false`. Re-reading the result generated no extra model request.
- The tool's `options.permission` label alone did not request approval. The fix explicitly awaits native `ctx.permission.assert` before report lookup, with the actual tool-call source and exact captured run ID. A real pending `orchestration_result` request appeared; rejection withheld the report, separate one-time approval returned it, and Explorer was blocked. Missing native support fails closed; pre/post-await aborts cannot retrieve a report, and caller mutation cannot switch the approved run ID while permission is pending.
- All seven fixture model requests were local and synthetic, with no paid-provider generation or use/change of user credentials/global settings. The owned fixture/server were stopped. This acceptance exercised native permission requests/replies through the API, not visual TUI permission clicks or a fresh real-model answer. Evidence: `/private/tmp/handoff-final.tVS373/evidence.json` and redacted `server-output.txt`.
- Final checks: **89 tests / 655 assertions**, formatting, types, build, working-tree and staged whitespace checks passed; independent review found no blocker. The API dependency remains `@opencode/plugin@2.0.22`; native permission assertion is capability-checked at runtime. No minimum assertion-capable host version or universal version compatibility is claimed, and no app upgrade was performed.
- This completes the bounded `context-handoffs` implementation/acceptance slice, not automatic coordination, desktop chat controls, independent verification or durable history. Persistent run/result storage remains Phase 8 work for a separate future branch. Changes remain for the user's review and commit; no commit, merge or staging action was authorized.

## Explicit context handoffs (2026-10-22)

- `/orchestration-handoff preview|run JSON` accepts an explicit version-1 context package: objective, relative file references/optional excerpts, findings, constraints, previous run summaries and unique acceptance checks. Unknown fields, traversal paths and oversized payloads reject before dispatch. No files, active chat or history are automatically read/copied.
- The full package/model/policy is cloned before asynchronous preparation and shown for explicit approval; edits after preparation cannot mutate the ticket. Existing specialist permissions apply. Paths/constraints are not a filesystem sandbox or authorization to expand access. All findings/prior summaries are labelled untrusted and may be stale.
- Specialists return bounded final-message JSON reports with summary/findings/evidence/check results/limitations. Interim narration is excluded. Malformed or incomplete reports fail without replay; valid reports remain self-reported, with `evidenceVerified:false`, even when checks claim passed. Completion is not independent verification.
- The caller retrieves run/session/model provenance and reports via `/orchestration-run result RUN_ID`; the orchestrator's read-only `orchestration_handoff_result` tool can retrieve existing current-project runs, guarded by role and a narrow `orchestration_result` ask permission. It cannot start or approve tasks. Result retrieval does not re-run work.
- Prior output is reused only when the caller explicitly places selected summary/ID into a new package and approves the next task. Automatic task graph/scheduling, stale-context refresh, independent verification, specialist-chat takeover synchronization and durable resume remain planned. No claude-mem hook is required or enabled by this implementation.
- Historical verification: 78 tests/349 assertions, formatting, types, build and Git whitespace checks passed. An independent isolated localhost server using installed OpenCode CLI 2.1.2 (`/private/tmp/handoff-runtime-NHDBdk`) loaded the plugin, awaiting its tool transform. Actual `/api/rpc/ai-orchestration.routing/handoff` calls returned HANDOFF_ERROR for invalid data and an actionable missing-small-tier error for a valid package preview; unknown result lookup returned Unknown task run. Sessions stayed empty before/after; no provider credentials or generation were used, and the server was stopped. This earlier check covered loading/local validation only; the final acceptance above supersedes its pending result/permission checks. It did not establish a fresh real-provider response or latest-release compatibility.

## Task routing execution slice

- Automatic difficulty is conservative local rules-based assessment, with explicit difficulty/model/agent overrides; no paid classifier call.
- Inventory capabilities and named variants are validated. A required unavailable capability blocks dispatch rather than silently choosing an unapproved model.
- `/orchestration-run` prepares a single-use ten-minute approval ticket. Its exact task, agent, candidate models and optional policy are frozen; confirmation starts an isolated agent session, never changes the current chat model.
- Reasoning variants, same-tier fallback, higher-tier failed-step escalation and retry count are independently configurable, project-scoped and disabled by default. Only confirmed pre-generation provider failures can safely retry without another approval; edits/tool-bearing, credentials, permissions and uncertain failures do not automatically replay.
- Completion proves a normal session outcome, not independent verification. Full task graphs, automatic context collection, workflow modes and verifier-driven retry await Phase 4; explicit context handoffs are now covered by the slice above.
- Cancellation explicitly interrupts the child and checks idle outcome. Uncertain stop is reported honestly. Runtime state is bounded and in-memory, not crash-recoverable; a timed-out creation may leave an empty unprompted session.
- Branch-finish fixes (2026-10-20): validation errors cross RPC as safe structured results, preserving actionable messages rather than generic Request failed. An invalid preparation starts no approval/session. OpenCode's built-in `session.retry` is disabled only for active plugin-owned child sessions, so the approved candidate/attempt count controls retries; ordinary chats retain their existing behaviour. Provider errors require sufficient terminal/stop evidence before final failure; an uncertain stop retains its active slot.
- Plugin type dependency remains tested API 2.0.22; installed desktop and latest official standalone live validation are recorded separately, without changing global credentials/configuration.
- 2026-10-13 latest official standalone CLI 2.0.28: configuration, auto preview, TUI approval cancellation and isolated dispatch checked. The enabled zero-cost `opencode/big-pickle` model rejected custom agents at execution, so selection/list now explicitly reject/flag it. The older inventory-only check did not prove execution eligibility. No successful paid-provider answer was run; an eligible connected provider with user spending approval is still needed for that live check.

Updated: 2026-10-28

## Platform

- Target OpenCode V2 only, pinned to 2.0.22 (`@opencode/plugin` 2.0.22). Do not run `/update` until a dedicated upgrade branch re-tests and re-pins.
- The server plugin works in both the OpenCode desktop app and the terminal app because both use the same engine.
- The primary product goal is normal chat in the OpenCode desktop app, not terminal-only use. The original browser-workspace plan followed the desktop API limitations checked with 2.0.22. Current official docs now describe a [GUI-experimental plugin part](https://opencode.ai/v2/docs/build/plugins) for Desktop; evaluate it on a separate future branch before choosing native GUI versus the existing browser-workspace plan. No GUI implementation or architecture migration is included in `context-handoffs`. The terminal plugin keeps small extras such as the startup notification.
- No LangGraph or other workflow engine unless OpenCode's session system proves insufficient.

## Model control

- Users choose the models for small, mid, and big tiers, plus the orchestrator's model; each task can override its selected model.
- First slice (2026-10-11): local `/orchestration-models` configuration and `/orchestration-route` preview commands. Tier choices are stored as versioned project-directory settings and revalidated on use. Variants must be listed by the connected enabled model; OpenCode free models are rejected. Explicit difficulty maps easy → small, medium → mid, hard → big. Preview and configuration do not switch the active session, call a model, or start agents. At that check automatic classification and dispatch remained planned; the execution slice above supersedes that status.
- No role has a specific model assigned yet. Current specialist profiles omit `model` and inherit the parent session's model.
- Routing is by each task's difficulty and capability needs, not a fixed model per role. Roles may suggest a default tier when difficulty is unclear.
- Automatic mode chooses tasks and agents and routes them within the user's selected tiers. Guided and Manual retain user overrides.
- Guided mode proposes a plan for user adjustment and approval, retaining user model choices.
- Manual mode lets users choose agents, models, and task order.
- Switching providers, models, or using a fallback must respect the user's explicit settings.
- OpenCode's free models (`opencode/*-free`) reject custom agents ("OpenCode's free tier can only be used from within OpenCode"); verified 2026-10-08. Tiers use the user's connected providers (e.g. Google, OpenAI) or local models, and the tier picker excludes or flags OpenCode's free models for our agents.

## Optional workflow enhancements

- The user requested all nine enhancements as separate opt-in options: failed-step escalation, risk-based verification, focused context, task budgets, Fast/Balanced/Thorough presets, reused findings, a direct path for simple tasks, routing previews, and performance-based suggestions.
- The user also requested seven cost-saving options, all opt-in: reasoning effort by difficulty, diff-only review, free checks first, prompt-cache-friendly prompts, step limits by difficulty, same-tier fallback, and local models for trivial tasks. Goal: never spend a big model or high reasoning effort on easy work.
- These extras are independent of Automatic/Guided/Manual mode; presets can be customized.
- See [the project plan](PLAN.md) for behaviour, controls, defaults, and verification criteria. These options are planned, not implemented.

## Context handoff roadmap

- The orchestrator gives each specialist a bounded task and relevant context.
- Explorer can gather repository evidence for the handoff.
- Handoffs include the objective, relevant files/findings, constraints, previous results, and acceptance checks.
- Specialists return results to the orchestrator for coordination and verification.
- When the user messages a specialist directly, the change is reported back to the orchestrator so later handoffs stay current.
- Copying agent instruction files with the installer does not transfer active sessions or conversation context.
- Explicit package delivery/report retrieval is implemented as described above. Automatic coordinated execution, context collection and manual-takeover synchronization remain planned.

## Orchestration decisions (2026-10-08)

- The plugin creates and drives each specialist's session itself (start, track, stop, retry, choose the model per agent).
- The user can take over any agent's session manually at any time (e.g. send it prompts, pause the plugin's control, change its model or task) and hand control back to the orchestrator. Manual takeover must be available in every mode, not only Manual mode.
- Build the MVP first. Optional workflow enhancements and cost-saving options wait until the MVP works end to end.

## Verification status

- Branch-finish automated checks (2026-10-20): all 69 tests (289 assertions), strict TypeScript, formatting, build and Git whitespace checks passed after the error/retry safety fixes. Changes remain for the user's review; no commit was authorized.
- Branch-finish latest-version checks (2026-10-20): the latest official CLI verified for this run is isolated OpenCode 2.0.32. A deterministic local HTTP model fixture passed completed 1/1 dispatch and 429 failed 1/1 with exactly one HTTP request and no hidden retry. The interactive terminal rendered an actionable missing-small-tier error and exact setup command rather than generic Request failed. This checks real host/plugin transport, terminal rendering and state transitions, not actual LLM generation. Credentials and global settings were not changed by isolated checks.
- Real-provider acceptance passed (2026-10-20) on installed OpenCode 2.0.28, using the user's saved small-tier `google/gemini-3.8-flash` and explorer. Run `95113aad-64cf-4057-a368-cb901759cc69` completed 1/1 and returned `ROUTING_LIVE_OK` with succeeded/stop evidence, zero tools, no fallback/retry/variant override and no change to the original chat model. Observed cost: $0.0035865. This proves routed real text generation; it does not establish README/tool-use verification or real-provider generation on isolated 2.0.32. An earlier bounded live request was cancelled without an answer; no cause is inferred for that earlier delay. The final acceptance run succeeded.
- Routing slice (2026-10-11): typechecked and tested against installed `@opencode/plugin@2.0.22` declarations. The bundled desktop CLI was 2.0.26; isolated live checks on that host confirmed routing RPC registration, terminal dialogs, unavailable-model rejection and missing-tier errors with no model generation. Selecting the eligible `opencode/big-pickle` model succeeded, an easy-task preview used that saved small-tier choice, and the selection survived a terminal restart. Inventory pages 1 and 2 fit an 80×24 terminal. This did not establish live compatibility on an exact 2.0.22 host. Actual model dispatch was unimplemented at that historical check; coordinated workflows still remain planned.

- Both plugins load in OpenCode 2.0.22: `/plugins` lists `ai-orchestration.tui` and `ai-orchestration.server` as loaded (2026-10-08).
- The startup notification never showed because OpenCode 2.0.22 passes project options only to the server plugin; the TUI plugin saw no `notifyOnLoad` and defaulted to off. Fixed: the TUI plugin now notifies by default. Verified in an interactive OpenCode 2.0.22 terminal on 2026-10-11: the startup toast renders, and global `cli.json` with the checkout's absolute package path and `notifyOnLoad: false` suppresses it while `/plugins` still lists both local plugins as loaded. Verification used isolated XDG config/data/cache/state directories, preserving the user's global configuration and credentials.
- The orchestrator replies inside OpenCode on a connected provider (Gemini 3.8 Flash).
