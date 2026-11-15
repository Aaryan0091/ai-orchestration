import { Rpc } from "@opencode/plugin/rpc"
import { routingFailureSchema } from "./rpc.ts"
import type { CommandVerificationResult } from "./verification.ts"

export interface CommandTicket {
  id: string
  sessionID: string
  workflowID: string
  stepID: string
  directory: string
  command: string
  executionCommand: string
  permissionSessionID: string
  expiresAt: number
  timeoutMs: 30000
  metadata: { orchestrationVerification: string }
}

export interface CommandStatus {
  id: string
  sessionID: string
  workflowID: string
  stepID: string
  directory: string
  result: CommandVerificationResult
  shellID?: string
}

const id = { type: "string", minLength: 1, maxLength: 200 } as const
const text = { type: "string" } as const
const result = {
  type: "object",
  properties: {
    status: { enum: ["pending", "running", "passed", "failed", "unverified", "cancelled"] },
    source: { const: "native-shell" },
    command: text,
    ticketID: id,
    sessionID: id,
    shellID: id,
    exitCode: { type: "number" },
    diagnostic: text,
  },
  required: ["status", "source", "command", "ticketID", "diagnostic"],
  additionalProperties: false,
} as const
const fields = { id, sessionID: id, workflowID: id, stepID: id, directory: text } as const
const ticket = {
  type: "object",
  properties: {
    ...fields,
    command: text,
    executionCommand: text,
    permissionSessionID: id,
    expiresAt: { type: "number" },
    timeoutMs: { const: 30000 },
    metadata: {
      type: "object",
      properties: { orchestrationVerification: id },
      required: ["orchestrationVerification"],
      additionalProperties: false,
    },
  },
  required: [
    ...Object.keys(fields),
    "command",
    "executionCommand",
    "permissionSessionID",
    "expiresAt",
    "timeoutMs",
    "metadata",
  ],
  additionalProperties: false,
} as const
const status = {
  type: "object",
  properties: { ...fields, result, shellID: id },
  required: [...Object.keys(fields), "result"],
  additionalProperties: false,
} as const
const lookup = {
  type: "object",
  properties: { sessionID: id, id },
  required: ["sessionID", "id"],
  additionalProperties: false,
} as const

/** Trusted native controls only; no model-facing execution or result-attestation tool. */
export const commandVerificationRpc = Rpc.define({
  id: "ai-orchestration.command-verification",
  methods: {
    prepare: {
      input: {
        type: "object",
        properties: { sessionID: id, workflowID: id, stepID: id },
        required: ["sessionID", "workflowID", "stepID"],
        additionalProperties: false,
      },
      output: { anyOf: [ticket, routingFailureSchema] },
    },
    status: { input: lookup, output: { anyOf: [status, routingFailureSchema] } },
    cancel: { input: lookup, output: { anyOf: [status, routingFailureSchema] } },
  },
  events: {},
})
