# Optional workflow controls — implementation plan

Status: planned, not implemented. Updated: 2026-10-03.

## Core routing decision

Route by task difficulty, not a fixed model per agent. Users choose which connected models fill the small, mid, and big tiers and can override a task's model. Roles describe responsibilities and may suggest a default tier when difficulty is unclear. Capability requirements also matter. Planning can assess difficulty without a separate classification call.

Automatic, Guided, and Manual describe workflow control. The options below are independent of those modes and are individually opt-in. Merely choosing Automatic does not enable these extras.

## Optional settings

All nine settings start disabled unless the user explicitly applies a preset or enables them. They can be saved as project preferences and overridden for a run. Show effective settings before dispatch; changes to active tasks apply at a safe boundary, not halfway through a model request.

| User option | Enabled behaviour | Disabled behaviour / controls |
| --- | --- | --- |
| Retry only failed steps | Preserve valid completed work and retry the failed task on an approved stronger tier. | No automatic escalation; user can retry manually. Choose eligible fallback tiers and retry count. Invalidate dependent work if the corrected result changes its inputs. |
| Risk-based verification | Assign deeper verification and a stronger approved reviewer model to risky changes. | Use baseline acceptance checks with the chosen verifier model. Choose reviewer tier and review depth. Disabling this does not disable ordinary verification. |
| Focused context | Send relevant files, evidence and summaries rather than the entire available conversation. | Use normal explicitly selected project/task context. Offer a context preview and let users add missing material. Always preserve instructions and constraints. |
| Task budget | Enforce configured spend estimate, token allowance, retry count and concurrency limits. | No extra user budget; normal platform/provider limits still apply. Show observed cost separately from estimates. Stop scheduling and ask for a revised budget when necessary. |
| Workflow preset | Apply an explicit Fast, Balanced or Thorough configuration. | Use individually configured settings. Display preset changes before applying; later overrides label it Custom. |
| Reuse findings | Share Explorer evidence between relevant tasks instead of repeating reads. | Tasks gather their own evidence. Track source file/version; refresh stale findings and isolate unrelated projects. |
| Direct path for simple tasks | Send suitable simple requests directly to one capable agent. | Use the standard planning path. Permissions and acceptance checks still apply. |
| Routing preview | Show tasks, dependencies, difficulty, model, routing reason and estimated cost before dispatch; allow edits. | No extra preview screen; required Guided-mode approvals and permissions still apply. Estimates can be unavailable and are never presented as guaranteed costs. |
| Performance-based routing suggestions | Use observed verification results, retries, cost and latency to suggest better tier assignments. | No additional performance history or recommendations. Suggestions require acceptance before changing chosen models. Provide clear/delete controls. |

### Preset proposals

- Fast: shallow planning, direct path and focused/reused context; baseline verification for ordinary work.
- Balanced: standard planning, focused/reused context and risk-based verification; optionally one approved stronger-tier retry.
- Thorough: deeper planning and broader verification; optionally more retries within user limits.

Presets must preview their changes. They cannot choose new providers, invent spend limits, enable performance history collection, or bypass approvals. Model tiers, budgets and telemetry remain explicit user choices. Presets are conveniences, not locked modes.

## Additional cost-saving options

Goal: never spend a big model, or high reasoning effort, on easy work. The user requested these alongside the nine options above. They follow the same rules: opt-in, disabled by default, user-overridable, and presets may only enable them with a preview.

Already covered by the table above: focused context (Focused context), shortcut for easy requests (Direct path), remembering explorer findings (Reuse findings), budgets and pre-run cost estimates (Task budget, Routing preview), and learning from history (Performance-based routing suggestions).

| User option | Enabled behaviour | Disabled behaviour / controls | Phase |
| --- | --- | --- | --- |
| Reasoning effort by difficulty | Use model variants (e.g. `#low` / `#high`) as a second dial: an easy task may run on a capable model at low effort instead of switching models. | Use each model's default variant. User chooses allowed variants per tier. Only use variants the model actually lists (`ui.model.variant.list`, `ModelRef.variant`). | 1–2 |
| Diff-only review | Reviewers receive the change diff plus minimal surrounding context instead of re-reading whole files. | Reviewer gathers context normally. Reviewer can request more context when the diff is insufficient. | 3 |
| Free checks first | Run deterministic checks (tests, lint, typecheck) before any model review; skip paid review when they fail and route the failure back instead. | Model review runs regardless. User chooses which commands count as checks; shell permissions still apply. | 3 |
| Prompt-cache-friendly prompts | Keep each agent's instruction prefix stable across calls so providers can reuse cached input; report cache hits from token usage (`tokens.cache`). | No prefix ordering constraints. Never drop required instructions to improve cache hits. | 2 |
| Step limits by difficulty | Cap model steps per task by difficulty (few for easy, more for hard), within the agent's `steps` maximum. | Use the agent profile's `steps` value. User sets per-tier limits; hitting a limit returns partial results rather than silently escalating. | 2 |
| Same-tier fallback | When a model is unavailable or rate-limited, retry on another user-approved model in the same tier before considering a higher tier. | Fail the task and report the provider error. User lists fallback models per tier; never fall back to an unapproved model or provider. | 3 |
| Local models for trivial tasks | Allow a user-connected local model (e.g. via Ollama) to fill the small tier for trivial tasks. | Small tier uses the user's chosen hosted model. Only models the user has connected in OpenCode are eligible; local models are never installed or downloaded by the plugin. | 1 |

Guard: report savings from observed usage only (e.g. cost of the chosen tier versus the user's big-tier pricing when known); never present estimated savings as measured.

## Phase 0 — documentation discovery

Inspected the installed `@opencode/plugin@2.0.22` and matching client/schema declarations, along with `src/shared/types.ts` and `test/options.test.ts`.

Allowed patterns to copy and verify against these declarations:

- Session selection: `node_modules/@opencode/client/dist/promise/generated/client.d.ts` and `types.d.ts`: `session.switchModel({ sessionID, model: { providerID, id, variant? } })`; prompt inputs have no per-prompt model override.
- Context: `session.context({ sessionID })`; `session.prompt` supports text, files and metadata. Use a separate task session for model isolation rather than concurrently switching a shared session.
- Inventory: `model.list(...).data` contains model information; registry transform candidates are not proof of active availability.
- Persistence: `node_modules/@opencode/plugin/dist/storage.d.ts`: `get`, `set`, `remove`, `scan` for versioned JSON.
- Controls: `node_modules/@opencode/plugin/dist/tui/context.d.ts`: selection/confirmation dialogs and durable local settings; cancellation returns `undefined`.
- Cost: session schema reports observed USD cost and tokens; model schema has optional prices per million tokens, including context/cache tiers. `data.session.cost(sessionID)` is available in the TUI.

Guards: do not mutate readonly model hook references, invent prompt model overrides, interpret unavailable pricing as free, assume aggregate family cost, or promise an exact hard dollar cap for already in-flight requests. Confirm dispatch ordering against the running host before release.

## Phase 1 — settings and user interface

Implement a versioned options schema, independently editable toggles, model-tier selection, per-run overrides and explicit preset application. Copy parser patterns from `src/shared/types.ts` and storage/dialog patterns from Phase 0 declarations. Keep policy separate from run state.

Verify: extras are disabled by default; modes do not silently enable them; saving/reloading preserves explicit choices; preset application shows all changes; cancel dispatches nothing; unavailable models are rejected clearly.

Guard: no settings-only feature may be presented as working execution behaviour.

## Phase 2 — task graph, routing and context handoff

Implement task IDs, dependencies, difficulty and capability requirements, model overrides, context manifests, Explorer evidence reuse, optional direct path and optional routing preview. Copy V2 session/model patterns from Phase 0 declarations.

Verify: one agent uses different selected tiers across tasks; overrides win; independent tasks have isolated sessions; stale evidence refreshes; essential instructions remain in focused context; preview cancellation starts no work.

Guard: avoid fixed role-to-model routing and concurrent changes to one shared session's model.

## Phase 3 — budgets, selective retries and verification

Implement the optional budget scheduler, per-task checkpoint/results, dependency invalidation, approved escalation and risk-based reviewer selection. Preserve baseline verification regardless of enhancement settings. Use V2 session/context/cost types from Phase 0.

Verify: successful unaffected tasks are not rerun; invalidated dependents are rerun when needed; retries cannot exceed configured limits; credential/permission/network errors do not blindly escalate; expensive review is selected only by the configured policy; budget checks include reserved in-flight work.

Guard: retry side-effecting work only when replay is safe; otherwise require review. Show estimates and observed usage distinctly, accounting for cost-reporting delays and unknown prices.

## Phase 4 — optional performance history

Implement opt-in project-scoped records of model/task outcomes, verification results, retries, observed cost and latency, plus inspect/delete controls and routing recommendations. Copy versioned storage patterns from Phase 0.

Verify: no extra performance history is saved while disabled; records can be cleared; recommendations cite observed evidence; model changes require acceptance; failed tests do not automatically prove model failure.

Guard: do not use self-reported model confidence as evidence of correctness or silently override model choices.

## Phase 5 — complete workflow verification

Test options independently and together in Automatic, Guided and Manual modes against the supported V2 host. Confirm every API against installed types, then run proportional end-to-end checks for dispatch, model isolation, context, cancellation, retries and budgets. Include unknown pricing, provider failures, stale findings and changed dependency results.

Separately verify that the startup notification appears in a running interactive OpenCode terminal; successful module imports do not establish visibility.

## Delivery sequence

Settings and tier selection → task routing/context/preview → budgets → selective retries and risk-based review → presets and evidence reuse → performance suggestions → full workflow verification.

This document adds planned product options only. No orchestration behaviour is implemented by adding this plan.
