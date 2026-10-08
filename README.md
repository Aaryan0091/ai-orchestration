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

It does **not** orchestrate sessions yet. That comes in the next implementation phase.

See [project decisions](DECISIONS.md) for user-controlled model assignments, planned context handoffs, and the outstanding interactive terminal notification check.

The [optional workflow controls plan](PLAN.md) describes task-based model routing and nine separately selectable enhancements for future implementation.

## Requirements

- Bun 1.2 or newer
- OpenCode V2 compatible with `@opencode/plugin` 2.0.22
- At least one provider connected through OpenCode

This plugin never asks for or stores provider API keys. Connect providers with OpenCode itself.

## Develop locally

```sh
bun install
bun run check
opencode
```

The root `opencode.jsonc` loads this repository through its local `server.ts` and `tui.ts` entrypoints and selects the bundled `orchestrator` agent. Set `notifyOnLoad` to `false` if you do not want the startup toast.

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
        "notifyOnLoad": true,
      },
    },
  ],
}
```

Supported modes:

- `automatic`: the orchestrator chooses the workflow with minimal interruption;
- `guided`: the orchestrator proposes important choices for user review;
- `manual`: the user chooses assignments and execution order.

Phase 1 parses these options and records a non-secret diagnostic snapshot in OpenCode's plugin-scoped storage. It does not yet persist workflows, session progress, model assignments, or user memory. Mode-specific execution arrives with the orchestration engine.

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
