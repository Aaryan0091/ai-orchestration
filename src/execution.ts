import {
  difficultyTier,
  formatSelection,
  validateSelection,
  type Difficulty,
  type ModelCandidate,
  type RoutingConfig,
  type Selection,
} from "./routing.ts"
import {
  handoffPrompt,
  parseSpecialistReport,
  validateHandoff,
  type HandoffPackage,
  type SpecialistReport,
} from "./handoffs.ts"
import { AGENT_IDS, type AgentId } from "./shared/types.ts"

export type Capability = "text" | "tools" | "imageInput" | "imageOutput" | "reasoning"
export class StopUnconfirmedError extends Error {
  constructor(sessionID: string) {
    super(`Stop not confirmed for session ${sessionID}; check it in OpenCode.`)
    this.name = "StopUnconfirmedError"
  }
}
export type AgentRole = Exclude<AgentId, "orchestrator">
export const SPECIALIST_ROLES: readonly AgentRole[] = AGENT_IDS.filter(
  (agent): agent is AgentRole => agent !== "orchestrator",
)
export interface ExecutionModel extends ModelCandidate {
  capabilities: readonly Capability[]
}
export interface ExecutionOptions {
  reasoningVariants?: Partial<Record<Difficulty, string>>
  sameTierFallbacks?: Partial<Record<"small" | "mid" | "big", readonly Selection[]>>
  escalateFailedStep?: boolean
  maxRetries?: number
  maxDurationMs?: number
}
export interface ExecutionRequest {
  task: string
  agent?: AgentRole
  difficulty?: Difficulty | "auto"
  model?: Selection
  requiredCapabilities?: readonly Capability[]
  options?: ExecutionOptions
  handoff?: HandoffPackage
}
export interface Assessment {
  difficulty: Difficulty
  reason: string
  capabilities: readonly Capability[]
}
export interface ExecutionPlan {
  id: string
  task: string
  agent: AgentRole
  assessment: Assessment
  tier: "small" | "mid" | "big"
  models: readonly Selection[]
  options: ExecutionOptions
  createdAt: number
  handoff?: HandoffPackage
}
export interface WorkflowRoutingPreview {
  difficulty: Difficulty
  tier: ExecutionPlan["tier"]
  model?: string
  blocker?: string
}
export interface ExecutionOutcome {
  ok: boolean
  text: string
  /** Final assistant message only, excluding earlier tool narration. */
  finalText?: string
  failure?: "model" | "verification" | "credentials" | "permission" | "cancelled" | "unknown"
  safeToRetry?: boolean
}
export interface Attempt {
  model: Selection
  sessionID?: string
  outcome?: ExecutionOutcome
}
export interface TaskRun {
  id: string
  state: "running" | "stopping" | "completed" | "failed" | "cancelled"
  plan: ExecutionPlan
  attempts: Attempt[]
  result?: string
  specialistReport?: SpecialistReport
}
export interface ExecutionHost {
  readConfig(): Promise<RoutingConfig>
  listModels(): Promise<readonly ExecutionModel[]>
  createSession(input: { agent: AgentRole; model: Selection; signal: AbortSignal }): Promise<string>
  executeSession(input: {
    sessionID: string
    task: string
    signal: AbortSignal
  }): Promise<ExecutionOutcome>
  cancelSession(sessionID: string): Promise<void>
  now?(): number
  id?(): string
}

/** Conservative local heuristics, not an AI classifier or a confidence score. */
export function assessTask(task: string): Assessment {
  const capabilities: Capability[] = ["text"]
  if (
    /\b(inspect|analy[sz]e|read|describe)\b/i.test(task) &&
    /\b(image|screenshot|photo)\b/i.test(task)
  )
    capabilities.push("imageInput")
  if (
    /\b(write|change|edit|implement|fix|debug|test|run|search|read|inspect|review|refactor|build)\b/i.test(
      task,
    )
  )
    capabilities.push("tools")
  if (
    /\b(architecture|redesign|migration|security|race condition|multi[- ]file|distributed|refactor)\b/i.test(
      task,
    ) ||
    task.length > 1200
  )
    return {
      difficulty: "hard",
      reason: "Local rules found broad, risky or complex work.",
      capabilities,
    }
  if (
    /\b(read|list|find|summari[sz]e|typo|rename|explain)\b/i.test(task) &&
    task.length <= 240 &&
    !/\b(implement|debug|test|fix|build)\b/i.test(task)
  )
    return { difficulty: "easy", reason: "Local rules found a short, narrow task.", capabilities }
  return {
    difficulty: "medium",
    reason: "Unclear scope defaults to medium; you can override it.",
    capabilities,
  }
}

const capabilities: readonly Capability[] = [
  "text",
  "tools",
  "imageInput",
  "imageOutput",
  "reasoning",
]
const clone = <T>(value: T): T => structuredClone(value)
const unsupportedImageTask = /\b(generate|create|draw|paint)\b.{0,35}\b(image|photo|picture)\b/i

function assessExecutionRequest(request: ExecutionRequest) {
  if (!request.task?.trim() || request.task.length > 20000)
    throw new Error("Supply a task between 1 and 20000 characters.")
  const agent = request.agent ?? "explorer"
  if (!SPECIALIST_ROLES.includes(agent)) throw new Error("Unknown specialist agent.")
  const inferred = assessTask(request.task)
  const override = request.difficulty === "auto" ? undefined : request.difficulty
  const difficulty = override ?? inferred.difficulty
  const required = [
    ...new Set([
      ...inferred.capabilities,
      ...(request.requiredCapabilities ?? []),
      ...(["builder", "debugger", "verifier", "reviewer", "explorer"].includes(agent)
        ? ["tools" as const]
        : []),
    ]),
  ]
  if (required.some((item) => !capabilities.includes(item)))
    throw new Error("Unknown required capability.")
  return {
    agent,
    assessment: {
      difficulty,
      reason: override ? "Explicit user difficulty override." : inferred.reason,
      capabilities: required,
    },
    tier: difficultyTier(difficulty),
  }
}

export function createExecutionEngine(host: ExecutionHost) {
  const plans = new Map<string, ExecutionPlan>()
  const runs = new Map<string, TaskRun>()
  const controllers = new Map<string, AbortController>()
  const pendingCreations = new Map<string, Promise<string>>()
  const interruptions = new Map<string, Promise<void>>()
  const now = host.now ?? Date.now
  const id = host.id ?? (() => crypto.randomUUID())
  function interrupt(sessionID: string) {
    const existing = interruptions.get(sessionID)
    if (existing) return existing
    const stopping = host.cancelSession(sessionID)
    interruptions.set(sessionID, stopping)
    void stopping.catch(() => {
      interruptions.delete(sessionID)
    })
    return stopping
  }
  async function confirmStopped(run: TaskRun) {
    try {
      const creating = pendingCreations.get(run.id)
      const sessionID = creating ? await creating : run.attempts.at(-1)?.sessionID
      if (sessionID && run.attempts.at(-1)) run.attempts.at(-1)!.sessionID = sessionID
      if (sessionID) await interrupt(sessionID)
      run.state = "cancelled"
      run.result = "Cancelled by user or execution deadline."
    } catch (error) {
      run.state = "stopping"
      run.result = `Stop not confirmed for session ${run.attempts.at(-1)?.sessionID ?? "unknown"}: ${error instanceof Error ? error.message : "interruption failed"}. Check that session manually; no retries will run.`
    }
  }

  function validate(
    model: Selection,
    inventory: readonly ExecutionModel[],
    required: readonly Capability[],
    capabilityGuidance = "Choose an override.",
  ) {
    validateSelection(model, inventory)
    const entry = inventory.find(
      (item) => item.providerID === model.providerID && item.id === model.id,
    )
    const missing = required.filter((capability) => !entry?.capabilities.includes(capability))
    if (missing.length)
      throw new Error(
        `Model does not have confirmed capabilities: ${missing.join(", ")}. ${capabilityGuidance}`,
      )
  }

  /** One snapshot per workflow. Reads saved tiers and the catalog, never the runnable plans map. */
  function createWorkflowRoutingResolver() {
    async function safeRead<T>(read: () => Promise<T>): Promise<T | undefined> {
      try {
        return clone(await read())
      } catch {
        // Do not surface arbitrary storage/catalog failures (potential credential data).
        return undefined
      }
    }
    let config: Promise<RoutingConfig | undefined> | undefined
    let inventory: Promise<readonly ExecutionModel[] | undefined> | undefined
    return async (request: ExecutionRequest): Promise<WorkflowRoutingPreview> => {
      const { assessment, tier } = assessExecutionRequest(request)
      const route = { difficulty: assessment.difficulty, tier }
      if (unsupportedImageTask.test(request.task))
        return { ...route, blocker: "Image generation is not supported by this text-task runner." }
      const saved = await (config ??= safeRead(() => host.readConfig()))
      if (!saved) return { ...route, blocker: "Could not read saved project model tiers." }
      const primary = saved.selections[tier]
      if (!primary) return { ...route, blocker: `Select a ${tier} model first.` }
      const proposed = { ...route, model: formatSelection(primary) }
      const available = await (inventory ??= safeRead(() => host.listModels()))
      if (!available) return { ...proposed, blocker: "Could not read connected models." }
      try {
        validate(
          primary,
          available,
          assessment.capabilities,
          `Choose a compatible model for the saved ${tier} tier, then prepare a new draft.`,
        )
      } catch (error) {
        // Only local validation runs here; it does not make requests to any provider.
        return {
          ...proposed,
          blocker: error instanceof Error ? error.message : "The saved model is unsuitable.",
        }
      }
      return proposed
    }
  }

  async function preview(request: ExecutionRequest): Promise<ExecutionPlan> {
    request = clone(request)
    const handoff = request.handoff === undefined ? undefined : validateHandoff(request.handoff)
    if (handoff && request.task !== handoff.objective)
      throw new Error("Handoff objective must match the task.")
    if (unsupportedImageTask.test(request.task))
      throw new Error(
        "Image generation is not supported by this text-task runner. Use OpenCode's image tools directly.",
      )
    const { agent, assessment, tier } = assessExecutionRequest(request)
    const { difficulty, capabilities: required } = assessment
    const options = clone(request.options ?? {})
    const maxRetries = options.maxRetries ?? 0
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3)
      throw new Error("Retries must be an integer from 0 to 3.")
    if (options.escalateFailedStep !== undefined && typeof options.escalateFailedStep !== "boolean")
      throw new Error("Escalation must be true or false.")
    if (options.reasoningVariants) {
      for (const [name, variant] of Object.entries(options.reasoningVariants)) {
        if (
          !["easy", "medium", "hard"].includes(name) ||
          typeof variant !== "string" ||
          !variant.trim()
        )
          throw new Error("Reasoning defaults require a nonempty variant for easy, medium or hard.")
      }
    }
    if (
      options.maxDurationMs !== undefined &&
      (!Number.isInteger(options.maxDurationMs) ||
        options.maxDurationMs < 1000 ||
        options.maxDurationMs > 30 * 60 * 1000)
    )
      throw new Error("Duration must be between 1000 and 1800000 milliseconds.")
    const config = await host.readConfig()
    const inventory = await host.listModels()
    const primary = request.model ?? config.selections[tier]
    if (!primary) throw new Error(`Select a ${tier} model first.`)
    function withReasoning(selection: Selection): Selection {
      // An explicit per-task variant wins over optional difficulty defaults.
      const variant = selection.variant ?? options.reasoningVariants?.[difficulty]
      return { ...selection, ...(variant ? { variant } : {}) }
    }
    const candidates = [withReasoning(primary)]
    if (maxRetries > 0) {
      for (const fallback of options.sameTierFallbacks?.[tier] ?? [])
        candidates.push(withReasoning(fallback))
      if (options.escalateFailedStep) {
        const higher =
          tier === "small" ? (["mid", "big"] as const) : tier === "mid" ? (["big"] as const) : []
        for (const slot of higher) {
          const selection = config.selections[slot]
          if (selection) candidates.push(withReasoning(selection))
        }
      }
    }
    const unique = candidates
      .filter(
        (selection, index) =>
          candidates.findIndex(
            (item) =>
              item.providerID === selection.providerID &&
              item.id === selection.id &&
              item.variant === selection.variant,
          ) === index,
      )
      .slice(0, maxRetries + 1)
    for (const candidate of unique) validate(candidate, inventory, required)
    const plan: ExecutionPlan = {
      id: id(),
      task: request.task.trim(),
      agent,
      assessment,
      tier,
      models: unique,
      options,
      createdAt: now(),
      ...(handoff ? { handoff } : {}),
    }
    for (const [planID, saved] of plans) {
      if (now() - saved.createdAt > 10 * 60 * 1000) plans.delete(planID)
    }
    if (plans.size >= 100) throw new Error("Too many pending plans; start or discard a plan first.")
    plans.set(plan.id, clone(plan))
    return clone(plan)
  }

  function status(runID: string): TaskRun {
    const run = runs.get(runID)
    if (!run) throw new Error("Unknown task run.")
    return clone(run)
  }

  async function work(run: TaskRun, controller: AbortController, confirmSideEffectReplay: boolean) {
    try {
      const inventory = await host.listModels()
      for (const model of run.plan.models) {
        controller.signal.throwIfAborted()
        validate(model, inventory, run.plan.assessment.capabilities)
        const attempt: Attempt = { model: clone(model) }
        run.attempts.push(attempt)
        const creating = host.createSession({
          agent: run.plan.agent,
          model: clone(model),
          signal: controller.signal,
        })
        pendingCreations.set(run.id, creating)
        try {
          attempt.sessionID = await creating
        } finally {
          pendingCreations.delete(run.id)
        }
        controller.signal.throwIfAborted()
        attempt.outcome = await host.executeSession({
          sessionID: attempt.sessionID,
          task: run.plan.handoff ? handoffPrompt(run.plan.handoff) : run.plan.task,
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        run.result = attempt.outcome.text
        if (attempt.outcome.ok) {
          if (run.plan.handoff) {
            try {
              run.specialistReport = parseSpecialistReport(
                attempt.outcome.finalText ?? attempt.outcome.text,
                run.plan.handoff,
              )
            } catch (error) {
              attempt.outcome = {
                ok: false,
                text: error instanceof Error ? error.message : "Invalid report.",
                failure: "verification",
                safeToRetry: false,
              }
              run.result = attempt.outcome.text
              run.state = "failed"
              return
            }
          }
          run.state = "completed"
          return
        }
        const retryable = ["model", "verification"].includes(attempt.outcome.failure ?? "unknown")
        if (!retryable || (!attempt.outcome.safeToRetry && !confirmSideEffectReplay)) break
      }
      run.state = "failed"
    } catch (error) {
      if (controller.signal.aborted) await confirmStopped(run)
      else if (error instanceof StopUnconfirmedError) {
        run.state = "stopping"
        run.result = error.message
      } else {
        run.state = "failed"
        run.result = error instanceof Error ? error.message : "Execution failed."
      }
    } finally {
      controllers.delete(run.id)
    }
  }

  function start(
    planID: string,
    approval: { approved: boolean; confirmSideEffectReplay?: boolean },
  ): TaskRun {
    if (approval.approved !== true)
      throw new Error("Explicit approval is required before starting a paid model request.")
    const plan = plans.get(planID)
    if (!plan) throw new Error("Unknown or already used plan. Preview again.")
    if (now() - plan.createdAt > 10 * 60 * 1000) {
      plans.delete(planID)
      throw new Error("Plan expired. Preview again.")
    }
    if (
      [...runs.values()].filter((run) => run.state === "running" || run.state === "stopping")
        .length >= 3
    )
      throw new Error("Three tasks are already running. Finish or cancel one first.")
    if (runs.size >= 200) {
      for (const [runID, previous] of runs) {
        if (previous.state !== "running" && previous.state !== "stopping") {
          for (const attempt of previous.attempts)
            if (attempt.sessionID) interruptions.delete(attempt.sessionID)
          runs.delete(runID)
          break
        }
      }
    }
    plans.delete(planID)
    const run: TaskRun = { id: plan.id, state: "running", plan: clone(plan), attempts: [] }
    runs.set(run.id, run)
    const controller = new AbortController()
    controllers.set(run.id, controller)
    const timeout = setTimeout(
      () => {
        void cancel(run.id).catch(() => undefined)
      },
      plan.options.maxDurationMs ?? 10 * 60 * 1000,
    )
    void work(run, controller, approval.confirmSideEffectReplay === true).finally(() =>
      clearTimeout(timeout),
    )
    return clone(run)
  }

  async function cancel(runID: string): Promise<TaskRun> {
    const run = runs.get(runID)
    if (!run) throw new Error("Unknown task run.")
    if (run.state !== "running" && run.state !== "stopping") return clone(run)
    controllers.get(runID)?.abort(new Error("Cancelled by user."))
    run.state = "stopping"
    await confirmStopped(run)
    return clone(run)
  }

  return {
    preview,
    previewRouting(request: ExecutionRequest) {
      return createWorkflowRoutingResolver()(request)
    },
    createWorkflowRoutingResolver,
    start,
    status,
    cancel,
    handoffResult(runID: string) {
      const run = status(runID)
      if (!run.plan.handoff) throw new Error("This run has no handoff package.")
      return {
        version: 1 as const,
        runID: run.id,
        state: run.state,
        agent: run.plan.agent,
        objective: run.plan.handoff.objective,
        attempts: run.attempts.map(({ model, sessionID }) => ({ model, sessionID })),
        report: run.specialistReport ?? null,
        evidenceVerified: false as const,
        ...(run.state !== "completed" && run.result ? { diagnostic: run.result } : {}),
      }
    },
    discard(planID: string) {
      plans.delete(planID)
    },
  }
}
