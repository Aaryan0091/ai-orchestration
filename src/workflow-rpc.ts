import { Rpc } from "@opencode/plugin/rpc"
import { routingFailureSchema } from "./rpc.ts"
import type { WorkflowStepPreview } from "./workflow-plan.ts"

export const WORKFLOW_DRAFTS_PER_CHAT = 5

export interface WorkflowDraft {
  id: string
  sessionID: string
  directory: string
  title: string
  createdAt: number
  expiresAt: number
  steps: WorkflowStepPreview[]
}

export interface WorkflowDraftState {
  sessionID: string
  directory: string
  drafts: WorkflowDraft[]
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
  },
  required: ["id", "task", "agent", "dependsOn", "difficulty", "tier"],
  additionalProperties: false,
} as const
const draft = {
  type: "object",
  properties: {
    id,
    sessionID: id,
    directory: text,
    title: text,
    createdAt: { type: "number" },
    expiresAt: { type: "number" },
    steps: { type: "array", items: step },
  },
  required: ["id", "sessionID", "directory", "title", "createdAt", "expiresAt", "steps"],
  additionalProperties: false,
} as const

/** A separate, portable read/discard contract: no desktop approval or engine IDs.
 * OpenCode RPC: https://opencode.ai/docs/build/plugins/rpc#define
 */
export const workflowRpc = Rpc.define({
  id: "ai-orchestration.workflow",
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
              drafts: { type: "array", maxItems: WORKFLOW_DRAFTS_PER_CHAT, items: draft },
            },
            required: ["sessionID", "directory", "drafts"],
            additionalProperties: false,
          },
          routingFailureSchema,
        ],
      },
    },
    discard: {
      input: {
        type: "object",
        properties: { sessionID: id, draftID: id },
        required: ["sessionID", "draftID"],
        additionalProperties: false,
      },
      output: {
        anyOf: [
          {
            type: "object",
            properties: { id },
            required: ["id"],
            additionalProperties: false,
          },
          routingFailureSchema,
        ],
      },
    },
  },
  events: { changed: { schema: sessionInput } },
})
