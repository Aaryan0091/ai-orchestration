import { Rpc } from "@opencode/plugin/rpc"
import { routingFailureSchema } from "./rpc.ts"

export type TicketKind = "handoff" | "model-change" | "cancel"
export interface TicketSummary {
  id: string
  sessionID: string
  directory: string
  kind: TicketKind
  title: string
  createdAt: number
  expiresAt: number
}
export interface TicketPreview extends TicketSummary {
  message: string
}
export interface RunSummary {
  id: string
  state: "running" | "stopping" | "completed" | "failed" | "cancelled"
  agent: string
  task: string
  sessionIDs: string[]
}
export interface DesktopState {
  sessionID: string
  directory: string
  pending: TicketSummary[]
  runs: RunSummary[]
}
export interface DesktopModels {
  selections: Partial<Record<"small" | "mid" | "big" | "orchestrator", string>>
  models: { id: string; eligible: boolean; variants: string[] }[]
  page: number
  pages: number
}
export interface DesktopActionResult {
  ticketID: string
  kind: TicketKind
  message: string
  runID?: string
}
export interface DesktopRun extends RunSummary {
  summary: string
  result: string
}

const text = { type: "string" } as const
const id = { type: "string", minLength: 1, maxLength: 200 } as const
const sessionInput = {
  type: "object",
  properties: { sessionID: id },
  required: ["sessionID"],
  additionalProperties: false,
} as const
const ticketInput = {
  type: "object",
  properties: { sessionID: id, ticketID: id },
  required: ["sessionID", "ticketID"],
  additionalProperties: false,
} as const
const runInput = {
  type: "object",
  properties: { sessionID: id, runID: id },
  required: ["sessionID", "runID"],
  additionalProperties: false,
} as const
const kind = { enum: ["handoff", "model-change", "cancel"] } as const
const ticketProperties = {
  id,
  sessionID: id,
  directory: text,
  kind,
  title: text,
  createdAt: { type: "number" },
  expiresAt: { type: "number" },
} as const
const ticketRequired = [
  "id",
  "sessionID",
  "directory",
  "kind",
  "title",
  "createdAt",
  "expiresAt",
] as const
const ticketSchema = {
  type: "object",
  properties: ticketProperties,
  required: ticketRequired,
  additionalProperties: false,
} as const
const previewSchema = {
  type: "object",
  properties: { ...ticketProperties, message: text },
  required: [...ticketRequired, "message"],
  additionalProperties: false,
} as const
const runProperties = {
  id,
  state: { enum: ["running", "stopping", "completed", "failed", "cancelled"] },
  agent: text,
  task: text,
  sessionIDs: { type: "array", items: id },
} as const
const runRequired = ["id", "state", "agent", "task", "sessionIDs"] as const
const runSchema = {
  type: "object",
  properties: runProperties,
  required: runRequired,
  additionalProperties: false,
} as const
const actionSchema = {
  type: "object",
  properties: { ticketID: id, kind, message: text, runID: id },
  required: ["ticketID", "kind", "message"],
  additionalProperties: false,
} as const

/** Shared portable contract: no server-only root imports in the GUI graph.
 * API patterns: https://opencode.ai/v2/docs/build/plugins/rpc
 * Changed events are notifications only; GUI reads state/review to reconcile.
 */
export const desktopRpc = Rpc.define({
  id: "ai-orchestration.desktop",
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
              pending: { type: "array", items: ticketSchema },
              runs: { type: "array", items: runSchema },
            },
            required: ["sessionID", "directory", "pending", "runs"],
            additionalProperties: false,
          },
          routingFailureSchema,
        ],
      },
    },
    review: { input: ticketInput, output: { anyOf: [previewSchema, routingFailureSchema] } },
    approve: { input: ticketInput, output: { anyOf: [actionSchema, routingFailureSchema] } },
    discard: { input: ticketInput, output: { anyOf: [actionSchema, routingFailureSchema] } },
    proposeModel: {
      input: {
        type: "object",
        properties: {
          sessionID: id,
          slot: { enum: ["small", "mid", "big", "orchestrator"] },
          selection: { anyOf: [text, { type: "null" }] },
        },
        required: ["sessionID", "slot", "selection"],
        additionalProperties: false,
      },
      output: { anyOf: [previewSchema, routingFailureSchema] },
    },
    proposeCancel: { input: runInput, output: { anyOf: [previewSchema, routingFailureSchema] } },
    models: {
      input: {
        type: "object",
        properties: {
          sessionID: id,
          query: { type: "string", maxLength: 100 },
          page: { type: "integer", minimum: 1 },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        anyOf: [
          {
            type: "object",
            properties: {
              selections: {
                type: "object",
                properties: { small: text, mid: text, big: text, orchestrator: text },
                additionalProperties: false,
              },
              models: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: text,
                    eligible: { type: "boolean" },
                    variants: { type: "array", items: text },
                  },
                  required: ["id", "eligible", "variants"],
                  additionalProperties: false,
                },
              },
              page: { type: "integer" },
              pages: { type: "integer" },
            },
            required: ["selections", "models", "page", "pages"],
            additionalProperties: false,
          },
          routingFailureSchema,
        ],
      },
    },
    run: {
      input: runInput,
      output: {
        anyOf: [
          {
            type: "object",
            properties: { ...runProperties, summary: text, result: text },
            required: [...runRequired, "summary", "result"],
            additionalProperties: false,
          },
          routingFailureSchema,
        ],
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: { sessionID: id },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
})
