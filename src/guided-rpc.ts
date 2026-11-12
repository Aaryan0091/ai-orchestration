import { Rpc } from "@opencode/plugin/rpc"
import { routingFailureSchema } from "./rpc.ts"
import type { WorkflowStepPreview } from "./workflow-plan.ts"

const workflowStates = ["ready", "running", "completed", "stopped"] as const
const stepStates = [
  "ready",
  "waiting",
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "blocked",
] as const

export interface GuidedStep extends WorkflowStepPreview {
  state: (typeof stepStates)[number]
  runID?: string
  summary?: string
  diagnostic?: string
}

export interface GuidedWorkflow {
  id: string
  draftID: string
  title: string
  sessionID: string
  directory: string
  state: (typeof workflowStates)[number]
  steps: GuidedStep[]
}

export interface GuidedState {
  sessionID: string
  directory: string
  workflows: GuidedWorkflow[]
}

export interface GuidedReview {
  id: string
  workflowID: string
  stepID: string
  sessionID: string
  directory: string
  expiresAt: number
  task: string
  agent: WorkflowStepPreview["agent"]
  model: string
  previousResults: { stepID: string; runID: string; summary: string }[]
}

const text = { type: "string" } as const
const id = { type: "string", minLength: 1, maxLength: 200 } as const
const sessionInput = {
  type: "object",
  properties: { sessionID: id },
  required: ["sessionID"],
  additionalProperties: false,
} as const
const step = {
  type: "object",
  properties: {
    id,
    task: text,
    agent: text,
    dependsOn: { type: "array", items: id },
    difficulty: { enum: ["easy", "medium", "hard"] },
    tier: { enum: ["small", "mid", "big"] },
    model: text,
    blocker: text,
    state: { enum: stepStates },
    runID: id,
    summary: text,
    diagnostic: text,
  },
  required: ["id", "task", "agent", "dependsOn", "difficulty", "tier", "state"],
  additionalProperties: false,
} as const
const workflow = {
  type: "object",
  properties: {
    id,
    draftID: id,
    title: text,
    sessionID: id,
    directory: text,
    state: { enum: workflowStates },
    steps: { type: "array", items: step },
  },
  required: ["id", "draftID", "title", "sessionID", "directory", "state", "steps"],
  additionalProperties: false,
} as const
const stepInput = {
  type: "object",
  properties: { sessionID: id, workflowID: id, stepID: id },
  required: ["sessionID", "workflowID", "stepID"],
  additionalProperties: false,
} as const
const reviewInput = {
  type: "object",
  properties: { sessionID: id, reviewID: id },
  required: ["sessionID", "reviewID"],
  additionalProperties: false,
} as const
const previousResult = {
  type: "object",
  properties: { stepID: id, runID: id, summary: text },
  required: ["stepID", "runID", "summary"],
  additionalProperties: false,
} as const
const review = {
  type: "object",
  properties: {
    id,
    workflowID: id,
    stepID: id,
    sessionID: id,
    directory: text,
    expiresAt: { type: "number" },
    task: text,
    agent: text,
    model: text,
    previousResults: { type: "array", items: previousResult },
  },
  required: [
    "id",
    "workflowID",
    "stepID",
    "sessionID",
    "directory",
    "expiresAt",
    "task",
    "agent",
    "model",
    "previousResults",
  ],
  additionalProperties: false,
} as const
const actionOutput = {
  anyOf: [
    {
      type: "object",
      properties: { id },
      required: ["id"],
      additionalProperties: false,
    },
    routingFailureSchema,
  ],
} as const

/** A separate native Desktop contract. Draft/step/review IDs cannot start an engine plan.
 * OpenCode RPC: https://opencode.ai/docs/build/plugins/rpc#implement
 */
export const guidedRpc = Rpc.define({
  id: "ai-orchestration.guided",
  methods: {
    state: {
      input: sessionInput,
      output: {
        anyOf: [
          {
            type: "object",
            properties: {
              sessionID: id,
              directory: text,
              workflows: { type: "array", items: workflow },
            },
            required: ["sessionID", "directory", "workflows"],
            additionalProperties: false,
          },
          routingFailureSchema,
        ],
      },
    },
    begin: {
      input: {
        type: "object",
        properties: { sessionID: id, draftID: id },
        required: ["sessionID", "draftID"],
        additionalProperties: false,
      },
      output: actionOutput,
    },
    review: {
      input: {
        ...stepInput,
        properties: {
          ...stepInput.properties,
          includeDependencySummaries: { type: "boolean" },
        },
      },
      output: { anyOf: [review, routingFailureSchema] },
    },
    approve: { input: reviewInput, output: actionOutput },
    dismiss: { input: reviewInput, output: actionOutput },
    cancel: { input: stepInput, output: actionOutput },
  },
  events: { changed: { schema: sessionInput } },
})
