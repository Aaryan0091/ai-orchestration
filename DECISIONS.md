# Project decisions

Updated: 2026-10-03

## Model control

- Users choose the models for small, mid, and big tiers, plus the orchestrator's model; each task can override its selected model.
- No role has a specific model assigned yet. Current specialist profiles omit `model` and inherit the parent session's model.
- Routing is by each task's difficulty and capability needs, not a fixed model per role. Roles may suggest a default tier when difficulty is unclear.
- Automatic mode chooses tasks and agents and routes them within the user's selected tiers. Guided and Manual retain user overrides.
- Guided mode proposes a plan for user adjustment and approval, retaining user model choices.
- Manual mode lets users choose agents, models, and task order.
- Switching providers, models, or using a fallback must respect the user's explicit settings.

## Optional workflow enhancements

- The user requested all nine enhancements as separate opt-in options: failed-step escalation, risk-based verification, focused context, task budgets, Fast/Balanced/Thorough presets, reused findings, a direct path for simple tasks, routing previews, and performance-based suggestions.
- The user also requested seven cost-saving options, all opt-in: reasoning effort by difficulty, diff-only review, free checks first, prompt-cache-friendly prompts, step limits by difficulty, same-tier fallback, and local models for trivial tasks. Goal: never spend a big model or high reasoning effort on easy work.
- These extras are independent of Automatic/Guided/Manual mode; presets can be customized.
- See [the implementation plan](PLAN.md) for behaviour, controls, defaults, and verification criteria. These options are planned, not implemented.

## Context handoff to implement

- The orchestrator gives each specialist a bounded task and relevant context.
- Explorer can gather repository evidence for the handoff.
- Handoffs include the objective, relevant files/findings, constraints, previous results, and acceptance checks.
- Specialists return results to the orchestrator for coordination and verification.
- Copying agent instruction files with the installer does not transfer active sessions or conversation context.
- This workflow is planned; coordinated execution and context handoff are not implemented yet.

## Outstanding verification

- Check the terminal startup notification in a running interactive OpenCode V2 terminal.
- Module import/load tests do not prove that the notification is visible in the terminal.
