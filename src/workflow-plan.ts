import {
  SPECIALIST_ROLES,
  type AgentRole,
  type ExecutionRequest,
  type WorkflowRoutingPreview,
} from "./execution.ts"

export const WORKFLOW_MAX_STEPS = 12
export const WORKFLOW_TITLE_MAX_LENGTH = 120
export const WORKFLOW_TASK_MAX_LENGTH = 1000
export const WORKFLOW_STEP_ID_MAX_LENGTH = 40
export const WORKFLOW_STEP_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_-]*$"

const stepIDPattern = new RegExp(WORKFLOW_STEP_ID_PATTERN)

export interface WorkflowInputStep {
  id: string
  task: string
  agent: AgentRole
  dependsOn: string[]
  difficulty?: ExecutionRequest["difficulty"]
}

export interface WorkflowInput {
  title: string
  steps: WorkflowInputStep[]
}

export interface WorkflowStepPreview
  extends Omit<WorkflowInputStep, "difficulty">,
    WorkflowRoutingPreview {}

/** Only bounded, local validation messages from this module may cross the RPC boundary. */
export class WorkflowPlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowPlanError"
  }
}

function record(value: unknown, allowedKeys: readonly string[], label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkflowPlanError(`${label} must be an object.`)
  if (Object.keys(value).some((key) => !allowedKeys.includes(key)))
    throw new WorkflowPlanError(`${label} contains unsupported fields.`)
  return value as Record<string, unknown>
}

function boundedText(value: unknown, limit: number, label: string) {
  if (typeof value !== "string" || !value.trim() || value.length > limit || value.includes("\0"))
    throw new WorkflowPlanError(`${label} must be nonempty text of at most ${limit} characters.`)
  return value.trim()
}

function stepID(value: unknown, label: string) {
  if (
    typeof value !== "string" ||
    value.length > WORKFLOW_STEP_ID_MAX_LENGTH ||
    value.trim() !== value ||
    !stepIDPattern.test(value)
  )
    throw new WorkflowPlanError(
      `${label} must start with a letter or number and use only letters, numbers, underscores, or hyphens (up to ${WORKFLOW_STEP_ID_MAX_LENGTH} characters).`,
    )
  return value
}

/** Canonicalizes bounded caller-supplied metadata and stably sorts dependencies before any routing. */
export function validateWorkflowInput(input: unknown): WorkflowInput {
  const raw = record(input, ["title", "steps"], "Workflow")
  const title = boundedText(raw.title, WORKFLOW_TITLE_MAX_LENGTH, "Workflow title")
  if (!Array.isArray(raw.steps) || raw.steps.length === 0 || raw.steps.length > WORKFLOW_MAX_STEPS)
    throw new WorkflowPlanError(`Workflow must contain 1 to ${WORKFLOW_MAX_STEPS} steps.`)

  const steps: WorkflowInputStep[] = []
  const ids = new Set<string>()
  for (const [index, value] of raw.steps.entries()) {
    const label = `Step ${index + 1}`
    const step = record(value, ["id", "task", "agent", "dependsOn", "difficulty"], label)
    const id = stepID(step.id, `${label} ID`)
    if (ids.has(id)) throw new WorkflowPlanError("Workflow contains duplicate step IDs.")
    ids.add(id)
    const task = boundedText(step.task, WORKFLOW_TASK_MAX_LENGTH, `${label} task`)
    const agent = SPECIALIST_ROLES.find((role) => role === step.agent)
    if (!agent) throw new WorkflowPlanError(`${label} must name a known specialist agent.`)
    const difficulty = step.difficulty
    if (
      difficulty !== undefined &&
      difficulty !== "auto" &&
      difficulty !== "easy" &&
      difficulty !== "medium" &&
      difficulty !== "hard"
    )
      throw new WorkflowPlanError(`${label} difficulty must be auto, easy, medium, or hard.`)
    if (!Array.isArray(step.dependsOn) || step.dependsOn.length >= WORKFLOW_MAX_STEPS)
      throw new WorkflowPlanError(
        `${label} dependencies must be an array of up to ${WORKFLOW_MAX_STEPS - 1} step IDs.`,
      )
    const dependsOn = Array.from(step.dependsOn, (value) => stepID(value, `${label} dependency`))
    if (new Set(dependsOn).size !== dependsOn.length)
      throw new WorkflowPlanError(`${label} has duplicate dependencies.`)
    steps.push({ id, task, agent, dependsOn, ...(difficulty !== undefined ? { difficulty } : {}) })
  }

  if (steps.some(({ dependsOn }) => dependsOn.some((dependency) => !ids.has(dependency))))
    throw new WorkflowPlanError("Workflow refers to a missing dependency step.")

  // Pick the first available step in the caller's order, breaking ties deterministically.
  const emitted = new Set<string>()
  const ordered: WorkflowInputStep[] = []
  while (ordered.length < steps.length) {
    const next = steps.find(
      ({ id, dependsOn }) => !emitted.has(id) && dependsOn.every((id) => emitted.has(id)),
    )
    if (!next) throw new WorkflowPlanError("Workflow contains circular dependencies.")
    ordered.push(next)
    emitted.add(next.id)
  }
  return { title, steps: ordered }
}

/** Returns only reviewable text/routing metadata, not executable plans or approvals. */
export async function previewWorkflow(
  input: unknown,
  resolve: (request: ExecutionRequest) => Promise<WorkflowRoutingPreview>,
): Promise<{ title: string; steps: WorkflowStepPreview[] }> {
  const { title, steps } = validateWorkflowInput(input)
  const preview: WorkflowStepPreview[] = []
  for (const { id, task, agent, dependsOn, difficulty } of steps) {
    let route: WorkflowRoutingPreview
    try {
      route = await resolve({ task, agent, ...(difficulty !== undefined ? { difficulty } : {}) })
    } catch {
      throw new WorkflowPlanError("Could not preview workflow routing. Try again.")
    }
    preview.push({
      id,
      task,
      agent,
      dependsOn,
      difficulty: route.difficulty,
      tier: route.tier,
      ...(route.model !== undefined ? { model: route.model } : {}),
      ...(route.blocker !== undefined ? { blocker: route.blocker } : {}),
    })
  }
  return { title, steps: preview }
}
