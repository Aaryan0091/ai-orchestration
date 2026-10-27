import {
  createExecutionEngine,
  type AgentRole,
  type ExecutionOptions,
  type ExecutionPlan,
  type ExecutionRequest,
  type TaskRun,
} from "./execution.ts"
import { formatSelection, parseSelection, type Difficulty } from "./routing.ts"
import { HANDOFF_ERROR, validateHandoff } from "./handoffs.ts"

/** Bounded JSON crosses the RPC trust boundary; unknown authority-bearing fields reject. */
export function parseHandoffRequest(text: string): ExecutionRequest {
  try {
    if (text.length > 60000) throw new Error(HANDOFF_ERROR)
    const value: unknown = JSON.parse(text)
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !["agent", "difficulty", "model", "handoff"].includes(key))
    )
      throw new Error(HANDOFF_ERROR)
    const input = value as Record<string, unknown>
    const handoff = validateHandoff(input.handoff)
    if (
      typeof input.agent !== "string" ||
      ![
        "explorer",
        "planner",
        "builder",
        "debugger",
        "reviewer",
        "verifier",
        "visualizer",
      ].includes(input.agent)
    )
      throw new Error(HANDOFF_ERROR)
    if (
      input.difficulty !== undefined &&
      !["auto", "easy", "medium", "hard"].includes(input.difficulty as string)
    )
      throw new Error(HANDOFF_ERROR)
    if (input.model !== undefined && typeof input.model !== "string") throw new Error(HANDOFF_ERROR)
    return {
      task: handoff.objective,
      agent: input.agent as AgentRole,
      difficulty: (input.difficulty ?? "auto") as Difficulty | "auto",
      ...(input.model !== undefined ? { model: parseSelection(input.model as string) } : {}),
      handoff,
    }
  } catch {
    throw new Error(HANDOFF_ERROR)
  }
}

export interface PolicyStore {
  read(): Promise<unknown>
  write(value: { version: 1; options: ExecutionOptions }): Promise<void>
}
export function restorePolicy(raw: unknown): ExecutionOptions {
  if (raw === undefined) return {}
  if (
    !raw ||
    typeof raw !== "object" ||
    !("version" in raw) ||
    raw.version !== 1 ||
    !("options" in raw) ||
    !raw.options ||
    typeof raw.options !== "object" ||
    Array.isArray(raw.options)
  )
    throw new Error("Invalid execution policy; use policy reset.")
  const options = raw.options as ExecutionOptions
  if (
    Object.keys(options).some(
      (key) =>
        !["reasoningVariants", "sameTierFallbacks", "escalateFailedStep", "maxRetries"].includes(
          key,
        ),
    )
  )
    throw new Error("Unknown execution policy setting.")
  if (
    options.maxRetries !== undefined &&
    (!Number.isInteger(options.maxRetries) || options.maxRetries < 0 || options.maxRetries > 3)
  )
    throw new Error("Invalid retry limit.")
  if (options.escalateFailedStep !== undefined && typeof options.escalateFailedStep !== "boolean")
    throw new Error("Invalid escalation policy.")
  for (const value of [options.reasoningVariants, options.sameTierFallbacks])
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
      throw new Error("Invalid nested execution policy.")
  for (const [difficulty, variant] of Object.entries(options.reasoningVariants ?? {}))
    if (
      !["easy", "medium", "hard"].includes(difficulty) ||
      typeof variant !== "string" ||
      !variant ||
      /\s|#/.test(variant)
    )
      throw new Error("Invalid reasoning variant policy.")
  for (const [tier, models] of Object.entries(options.sameTierFallbacks ?? {})) {
    if (!["small", "mid", "big"].includes(tier) || !Array.isArray(models) || models.length > 3)
      throw new Error("Invalid fallback policy.")
    for (const model of models) {
      if (
        !model ||
        typeof model !== "object" ||
        typeof model.providerID !== "string" ||
        typeof model.id !== "string" ||
        (model.variant !== undefined && typeof model.variant !== "string")
      )
        throw new Error("Invalid fallback model.")
      parseSelection(formatSelection(model))
    }
  }
  return structuredClone(options)
}

export function parseExecutionRequest(text: string): ExecutionRequest {
  const words = text.trim().split(/\s+/)
  const first = words.shift()
  if (!["auto", "easy", "medium", "hard"].includes(first ?? ""))
    throw new Error(
      "Usage: auto|easy|medium|hard [--agent ROLE] [--model provider/model#variant] TASK",
    )
  const request: ExecutionRequest = { task: "", difficulty: first as Difficulty | "auto" }
  while (words[0]?.startsWith("--")) {
    const flag = words.shift()
    const value = words.shift()
    if (!value) throw new Error(`Missing value for ${flag}.`)
    if (flag === "--agent") {
      if (request.agent) throw new Error("Duplicate agent override.")
      request.agent = value as AgentRole
    } else if (flag === "--model") {
      if (request.model) throw new Error("Duplicate model override.")
      request.model = parseSelection(value)
    } else throw new Error(`Unknown option ${flag}.`)
  }
  request.task = words.join(" ")
  return request
}

export function formatPlan(plan: ExecutionPlan): string {
  return [
    `Task: ${plan.task.slice(0, 180)}${plan.task.length > 180 ? "… (your full entered task is bound to this approval)" : ""}`,
    `Agent: ${plan.agent}; difficulty: ${plan.assessment.difficulty}; tier: ${plan.tier}`,
    plan.assessment.reason,
    `Required: ${plan.assessment.capabilities.join(", ")}`,
    `Approved models: ${plan.models.map(formatSelection).join(" → ")}`,
    `Maximum attempts: ${plan.models.length}; escalation: ${plan.options.escalateFailedStep === true ? "on" : "off"}`,
    ...(plan.handoff
      ? [
          "Explicit context handoff (untrusted caller-supplied data, not independently verified). The full package below is bound to this single-use approval. No files or chat history are automatically collected. File references do not grant permissions.",
          JSON.stringify(plan.handoff, null, 2),
          "Review this context for secrets before approval: all supplied contents are sent to the approved provider(s). Specialist checks/evidence are self-reported, not independent verification.",
        ]
      : []),
    "Cost unknown. Running sends this task to the listed provider(s), may spend API credits and uses the agent's project permissions.",
    "Only this task retries, only before tools run. Current chat stays unchanged.",
    "OpenCode's automatic provider retries are disabled for these child sessions; only the approved attempts may run.",
  ].join("\n")
}
export function formatRun(run: TaskRun): string {
  return [
    `Run: ${run.id}`,
    `State: ${run.state}; attempts: ${run.attempts.length}/${run.plan.models.length}`,
    ...run.attempts.map(
      (attempt) => `${formatSelection(attempt.model)}; session: ${attempt.sessionID ?? "starting"}`,
    ),
    ...(run.result ? [run.result.slice(0, 800)] : []),
    "Open the listed session in OpenCode for full output. Status is kept only until plugin restart.",
  ].join("\n")
}

export function createExecutionCommands(
  engine: ReturnType<typeof createExecutionEngine>,
  store: PolicyStore,
) {
  let pending: Promise<unknown> = Promise.resolve()
  async function options() {
    await pending
    return restorePolicy(await store.read())
  }
  return {
    async prepareHandoff(text: string) {
      const plan = await engine.preview({ ...parseHandoffRequest(text), options: await options() })
      return { id: plan.id, message: formatPlan(plan) }
    },
    async previewHandoff(text: string) {
      const plan = await engine.preview({ ...parseHandoffRequest(text), options: await options() })
      engine.discard(plan.id)
      return `Handoff preview only — no agents started or model requests sent.\n${formatPlan(plan)}`
    },
    async prepare(text: string) {
      const plan = await engine.preview({
        ...parseExecutionRequest(text),
        options: await options(),
      })
      return { id: plan.id, message: formatPlan(plan) }
    },
    async preview(text: string) {
      const plan = await engine.preview({
        ...parseExecutionRequest(text),
        options: await options(),
      })
      engine.discard(plan.id)
      return `Routing preview only — no agents started or model requests sent.\n${formatPlan(plan)}`
    },
    async start(id: string) {
      return formatRun(engine.start(id, { approved: true }))
    },
    async discard(id: string) {
      engine.discard(id)
      return "Cancelled approval; no agent started."
    },
    async runCommand(text: string) {
      const [action, id, ...extra] = text.trim().split(/\s+/)
      if (extra.length || !id || !["status", "cancel", "result"].includes(action ?? ""))
        throw new Error(
          "Usage: status RUN_ID | cancel RUN_ID | result RUN_ID; to start use /orchestration-run auto TASK",
        )
      if (action === "result") return JSON.stringify(engine.handoffResult(id), null, 2)
      return formatRun(action === "cancel" ? await engine.cancel(id) : engine.status(id))
    },
    policy(text: string): Promise<string> {
      const next = pending.then(async () => {
        const [action = "show", target, value, ...extra] = text.trim()
          ? text.trim().split(/\s+/)
          : []
        if (extra.length) throw new Error("Too many policy arguments.")
        if (action === "reset") {
          if (target) throw new Error("Usage: reset")
          await store.write({ version: 1, options: {} })
          return "Optional execution controls reset to off; zero retries."
        }
        const policy = restorePolicy(await store.read())
        if (action === "show") {
          if (target) throw new Error("Usage: show")
          return `Optional execution policy:\n${JSON.stringify(policy, null, 2)}\nUnspecified controls are off. Changes affect newly prepared tasks only.`
        }
        if (action === "reasoning") {
          if (!["easy", "medium", "hard"].includes(target ?? "") || !value || /\s|#/.test(value))
            throw new Error("Usage: reasoning easy|medium|hard VARIANT|off")
          policy.reasoningVariants ??= {}
          if (value === "off") delete policy.reasoningVariants[target as Difficulty]
          else policy.reasoningVariants[target as Difficulty] = value
        } else if (action === "fallback") {
          if (!["small", "mid", "big"].includes(target ?? "") || !value)
            throw new Error("Usage: fallback small|mid|big provider/model#variant|off")
          policy.sameTierFallbacks ??= {}
          policy.sameTierFallbacks[target as "small" | "mid" | "big"] =
            value === "off" ? [] : [parseSelection(value)]
        } else if (action === "escalation") {
          if (!["on", "off"].includes(target ?? "") || value)
            throw new Error("Usage: escalation on|off")
          policy.escalateFailedStep = target === "on"
        } else if (action === "retries") {
          if (value || !/^[0-3]$/.test(target ?? "")) throw new Error("Usage: retries 0|1|2|3")
          policy.maxRetries = Number(target)
        } else throw new Error("Usage: show | reset | reasoning | fallback | escalation | retries")
        await store.write({ version: 1, options: policy })
        return "Saved this project's optional execution policy. Models and variants are revalidated before approval; controls never bypass permissions."
      })
      pending = next.catch(() => undefined)
      return next
    },
  }
}
