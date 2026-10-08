# Project decisions

Updated: 2026-10-08

## Platform

- Target OpenCode V2 only, pinned to 2.0.22 (`@opencode/plugin` 2.0.22). Do not run `/update` until a dedicated upgrade branch re-tests and re-pins.
- The server plugin works in both the OpenCode desktop app and the terminal app because both use the same engine.
- OpenCode V2 has no plugin API for the desktop app's interface, so the agent workspace and visualizer will be a local web page served by the plugin and opened in the browser. The terminal plugin keeps small extras such as the startup notification.
- No LangGraph or other workflow engine unless OpenCode's session system proves insufficient.

## Model control

- Users choose the models for small, mid, and big tiers, plus the orchestrator's model; each task can override its selected model.
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

## Context handoff to implement

- The orchestrator gives each specialist a bounded task and relevant context.
- Explorer can gather repository evidence for the handoff.
- Handoffs include the objective, relevant files/findings, constraints, previous results, and acceptance checks.
- Specialists return results to the orchestrator for coordination and verification.
- When the user messages a specialist directly, the change is reported back to the orchestrator so later handoffs stay current.
- Copying agent instruction files with the installer does not transfer active sessions or conversation context.
- This workflow is planned; coordinated execution and context handoff are not implemented yet.

## Pending decisions

- The plugin creates and drives each specialist's session itself. Recommended; awaiting confirmation.
- Hold the optional workflow enhancements until the MVP works end to end. Recommended; awaiting confirmation.

## Verification status

- Both plugins load in OpenCode 2.0.22: `/plugins` lists `ai-orchestration.tui` and `ai-orchestration.server` as loaded (2026-10-08).
- The startup notification was hidden by another plugin's error notification; re-check that it is visible now that claude-mem is disabled.
- The orchestrator replies inside OpenCode on a connected provider (Gemini 3.8 Flash).
