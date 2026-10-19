export const MODEL_SLOTS = ["small", "mid", "big", "orchestrator"] as const
export type ModelSlot = (typeof MODEL_SLOTS)[number]
export type Difficulty = "easy" | "medium" | "hard"
export interface Selection {
  providerID: string
  id: string
  variant?: string
}
export interface ModelCandidate {
  providerID: string
  id: string
  enabled: boolean
  variants: readonly { id: string }[]
}
export interface RoutingConfig {
  version: 1
  selections: Partial<Record<ModelSlot, Selection>>
}
export interface RoutingHost {
  directory: string
  list(): Promise<readonly ModelCandidate[]>
  read(key: string): Promise<unknown>
  write(key: string, config: RoutingConfig): Promise<void>
  remove(key: string): Promise<void>
}

const empty = (): RoutingConfig => ({ version: 1, selections: {} })
const slot = (value: string | undefined): ModelSlot => {
  if (!MODEL_SLOTS.includes(value as ModelSlot))
    throw new Error("Choose small, mid, big or orchestrator.")
  return value as ModelSlot
}
export function parseSelection(value: string): Selection {
  const slash = value.indexOf("/")
  if (slash < 1 || slash === value.length - 1 || /\s/.test(value)) {
    throw new Error("Use a listed provider/model ID; model IDs may contain slashes.")
  }
  const hash = value.indexOf("#", slash)
  const id = value.slice(slash + 1, hash < 0 ? undefined : hash)
  const variant = hash < 0 ? undefined : value.slice(hash + 1)
  if (!id || variant === "" || variant?.includes("#")) throw new Error("Invalid model variant.")
  return { providerID: value.slice(0, slash), id, ...(variant ? { variant } : {}) }
}
export function formatSelection(model: Selection): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}
export function customAgentIneligible(selection: Selection): boolean {
  return (
    selection.providerID === "opencode" &&
    (selection.id.endsWith("-free") || selection.id === "big-pickle")
  )
}
export function validateSelection(selection: Selection, models: readonly ModelCandidate[]): void {
  if (customAgentIneligible(selection)) {
    throw new Error(
      "OpenCode free models cannot run our custom agents. Choose another connected model.",
    )
  }
  const model = models.find(
    (item) => item.providerID === selection.providerID && item.id === selection.id && item.enabled,
  )
  if (!model)
    throw new Error(
      `Model unavailable: ${formatSelection(selection)}. Run /orchestration-models list.`,
    )
  if (selection.variant && !model.variants.some((variant) => variant.id === selection.variant)) {
    throw new Error(`Variant unavailable: ${formatSelection(selection)}.`)
  }
}
export function restoreConfig(value: unknown): RoutingConfig {
  if (value === undefined) return empty()
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("selections" in value)
  ) {
    throw new Error("Unsupported saved routing settings. Reset explicitly to clear them.")
  }
  const selections = value.selections
  if (!selections || typeof selections !== "object" || Array.isArray(selections))
    throw new Error("Invalid saved routing settings.")
  const result = empty()
  for (const [key, raw] of Object.entries(selections)) {
    const name = slot(key)
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.providerID !== "string" ||
      typeof raw.id !== "string" ||
      (raw.variant !== undefined && typeof raw.variant !== "string")
    )
      throw new Error("Invalid saved model selection.")
    result.selections[name] = parseSelection(
      `${raw.providerID}/${raw.id}${raw.variant === undefined ? "" : `#${raw.variant}`}`,
    )
  }
  return result
}
export function difficultyTier(value: string | undefined): "small" | "mid" | "big" {
  if (value === "easy") return "small"
  if (value === "medium") return "mid"
  if (value === "hard") return "big"
  throw new Error("Specify easy, medium or hard. Difficulty assessment is manual in this preview.")
}

/** Local-only commands: no model prompt, generation, session switching or dispatch API. */
export function createRoutingCommands(host: RoutingHost) {
  const key = `task-routing/v1/${encodeURIComponent(host.directory)}`
  let pending: Promise<unknown> = Promise.resolve()
  // Serialize reads and updates so simultaneous commands cannot lose saved selections.
  function serialized(run: () => Promise<string>, signal?: AbortSignal): Promise<string> {
    const next = pending.then(() => {
      signal?.throwIfAborted()
      return run()
    })
    pending = next.catch(() => undefined)
    return next.catch(
      (error: unknown) =>
        `Routing error: ${error instanceof Error ? error.message : "Operation failed."}`,
    )
  }
  return {
    async config(): Promise<RoutingConfig> {
      await pending
      return restoreConfig(await host.read(key))
    },
    models(text: string, signal?: AbortSignal): Promise<string> {
      return serialized(async () => {
        const [action = "show", target, model, ...extra] = text.trim()
          ? text.trim().split(/\s+/)
          : []
        if (action === "reset") {
          if (model || extra.length) throw new Error("Usage: reset [small|mid|big|orchestrator]")
          if (!target) {
            signal?.throwIfAborted()
            await host.remove(key)
            return "Cleared this project's model selections."
          }
          const name = slot(target)
          const config = restoreConfig(await host.read(key))
          delete config.selections[name]
          signal?.throwIfAborted()
          await host.write(key, config)
          return `Cleared ${name}.`
        }
        if (action === "list") {
          const page = target === undefined ? 1 : Number(target)
          if (!Number.isSafeInteger(page) || page < 1 || model || extra.length)
            throw new Error("Usage: list [PAGE]")
          const models = (await host.list())
            .filter((item) => item.enabled)
            .sort((a, b) => formatSelection(a).localeCompare(formatSelection(b)))
          const pages = Math.max(1, Math.ceil(models.length / 3))
          if (page > pages) throw new Error(`Choose a page from 1 to ${pages}.`)
          return [
            `Available connected models — page ${page}/${pages} (no requests sent):`,
            ...models
              .slice((page - 1) * 3, page * 3)
              .map(
                (item) =>
                  `${formatSelection(item)}${customAgentIneligible(item) ? " [ineligible for custom agents]" : ""}${item.variants.length ? `; variants: ${item.variants.map((v) => v.id).join(", ")}` : ""}`,
              ),
            ...(page < pages ? [`Next: /orchestration-models list ${page + 1}`] : []),
          ].join("\n")
        }
        const config = restoreConfig(await host.read(key))
        if (action === "show") {
          if (target) throw new Error("Usage: show")
          const models = await host.list()
          return [
            "Project model selections:",
            ...MODEL_SLOTS.map((name) => {
              const selected = config.selections[name]
              if (!selected) return `${name}: not selected`
              try {
                validateSelection(selected, models)
                return `${name}: ${formatSelection(selected)}`
              } catch (error) {
                return `${name}: ${formatSelection(selected)} [${error instanceof Error ? error.message : "unavailable"}]`
              }
            }),
            "Selections affect future plugin tasks only; the current chat model is unchanged.",
          ].join("\n")
        }
        if (action !== "set" || !model || extra.length)
          throw new Error("Usage: list | show | set SLOT provider/model[#variant] | reset [SLOT]")
        const name = slot(target)
        const selected = parseSelection(model)
        validateSelection(selected, await host.list())
        config.selections[name] = selected
        signal?.throwIfAborted()
        await host.write(key, config)
        return `Saved ${name}: ${formatSelection(selected)} for this project. Current chat model unchanged.`
      }, signal)
    },
    route(text: string, signal?: AbortSignal): Promise<string> {
      return serialized(async () => {
        const words = text.trim().split(/\s+/)
        const difficulty = words.shift()
        const tier = difficultyTier(difficulty)
        let override: Selection | undefined
        if (words[0] === "--model") {
          words.shift()
          const value = words.shift()
          if (!value) throw new Error("Supply a provider/model after --model.")
          override = parseSelection(value)
        }
        if (!words.length)
          throw new Error("Usage: easy|medium|hard [--model provider/model[#variant]] TASK")
        const config = restoreConfig(await host.read(key))
        const selected = override ?? config.selections[tier]
        if (!selected)
          throw new Error(`Select the ${tier} model with /orchestration-models set first.`)
        const models = await host.list()
        validateSelection(selected, models)
        const orchestrator = config.selections.orchestrator
        if (orchestrator) validateSelection(orchestrator, models)
        return [
          "Routing preview only — no agents started or model requests sent.",
          `Task: ${words.join(" ")}`,
          `Difficulty: ${difficulty} (provided by you)`,
          `Tier: ${tier}`,
          `Model: ${formatSelection(selected)}${override ? " (explicit override)" : ""}`,
          `Orchestrator: ${orchestrator ? formatSelection(orchestrator) : "not selected; required before future execution"}`,
          "Cost: not estimated; token requirements are unknown.",
          "Current chat model unchanged.",
        ].join("\n")
      }, signal)
    },
  }
}
