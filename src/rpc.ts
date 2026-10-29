import { Rpc } from "@opencode/plugin/rpc"
import { HANDOFF_ERROR } from "./handoffs.ts"

/**
 * Official plugin guide: https://opencode.ai/v2/docs/build/plugins/
 * Verified portable schemas in node_modules/@opencode/plugin/dist/promise/rpc.d.ts
 * and node_modules/@opencode/schema/dist/rpc.d.ts (2.0.22).
 */
const text = { type: "string" } as const
// Successful replies retain their original shape. Application failures are data,
// not thrown RPC errors: OpenCode intentionally hides undeclared server errors.
const failure = {
  type: "object",
  properties: {
    ok: { const: false },
    error: {
      type: "object",
      properties: { code: { const: "routing.application" }, message: text },
      required: ["code", "message"],
      additionalProperties: false,
    },
  },
  required: ["ok", "error"],
  additionalProperties: false,
} as const
const textReply = { anyOf: [text, failure] } as const
export const routingFailureSchema = failure
export const routingRpc = Rpc.define({
  id: "ai-orchestration.routing",
  methods: {
    models: { input: text, output: textReply },
    route: { input: text, output: textReply },
    prepare: {
      input: text,
      output: {
        anyOf: [
          {
            type: "object",
            properties: { id: text, message: text },
            required: ["id", "message"],
            additionalProperties: false,
          },
          failure,
        ],
      },
    },
    handoff: {
      input: { type: "string", maxLength: 60010 },
      output: {
        anyOf: [
          text,
          {
            type: "object",
            properties: { id: text, message: text },
            required: ["id", "message"],
            additionalProperties: false,
          },
          failure,
        ],
      },
    },
    start: { input: text, output: textReply },
    discard: { input: text, output: textReply },
    run: { input: text, output: textReply },
    policy: { input: text, output: textReply },
  },
  events: {},
})

export interface RoutingFailure {
  ok: false
  error: { code: "routing.application"; message: string }
}

// Only known local validation text crosses the boundary. Provider/transport
// objects, stack traces and arbitrary exception messages may contain credentials.
const safeMessages = new Set([
  HANDOFF_ERROR,
  "Handoff objective must match the task.",
  "This run has no handoff package.",
  "Usage: preview JSON | run JSON; paste the complete handoff request object.",
  "Choose small, mid, big or orchestrator.",
  "Use a listed provider/model ID; model IDs may contain slashes.",
  "Invalid model variant.",
  "OpenCode free models cannot run our custom agents. Choose another connected model.",
  "Unsupported saved routing settings. Reset explicitly to clear them.",
  "Invalid saved routing settings.",
  "Invalid saved model selection.",
  "Specify easy, medium or hard. Difficulty assessment is manual in this preview.",
  "Invalid execution policy; use policy reset.",
  "Unknown execution policy setting.",
  "Invalid retry limit.",
  "Invalid escalation policy.",
  "Invalid nested execution policy.",
  "Invalid reasoning variant policy.",
  "Invalid fallback policy.",
  "Invalid fallback model.",
  "Duplicate agent override.",
  "Duplicate model override.",
  "Too many policy arguments.",
  "Image generation is not supported by this text-task runner. Use OpenCode's image tools directly.",
  "Supply a task between 1 and 20000 characters.",
  "Unknown specialist agent.",
  "Unknown required capability.",
  "Retries must be an integer from 0 to 3.",
  "Escalation must be true or false.",
  "Reasoning defaults require a nonempty variant for easy, medium or hard.",
  "Duration must be between 1000 and 1800000 milliseconds.",
  "Too many pending plans; start or discard a plan first.",
  "Unknown task run.",
  "Explicit approval is required before starting a paid model request.",
  "Unknown or already used plan. Preview again.",
  "Plan expired. Preview again.",
  "Three tasks are already running. Finish or cancel one first.",
  "Usage: reset [small|mid|big|orchestrator]",
  "Usage: list [PAGE]",
  "Usage: show",
  "Usage: reset",
  "Usage: list | show | set SLOT provider/model[#variant] | reset [SLOT]",
  "Supply a provider/model after --model.",
  "Usage: easy|medium|hard [--model provider/model[#variant]] TASK",
  "Usage: auto|easy|medium|hard [--agent ROLE] [--model provider/model#variant] TASK",
  "Usage: status RUN_ID | cancel RUN_ID | result RUN_ID; to start use /orchestration-run auto TASK",
  "Usage: reasoning easy|medium|hard VARIANT|off",
  "Usage: fallback small|mid|big provider/model#variant|off",
  "Usage: escalation on|off",
  "Usage: retries 0|1|2|3",
  "Usage: show | reset | reasoning | fallback | escalation | retries",
])

export function safeApplicationMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : undefined
  if (message && safeMessages.has(message)) return message
  const tier = message?.match(
    /^Select (?:a |the )(small|mid|big) model (?:first\.|with \/orchestration-models set first\.)$/,
  )?.[1]
  if (tier)
    return `Select the ${tier} model first: /orchestration-models set ${tier} provider/model. Use /orchestration-models list for exact IDs.`
  if (message?.startsWith("Model unavailable: "))
    return "Model unavailable. Run /orchestration-models list and select an available model."
  if (message?.startsWith("Variant unavailable: "))
    return "Variant unavailable. Run /orchestration-models list and choose a listed variant."
  if (message?.startsWith("Model does not have confirmed capabilities: "))
    return "Model lacks required capabilities. Choose a model supporting this task's text, tools or image requirements."
  if (message && /^Choose a page from 1 to \d+\.$/.test(message)) return message
  if (message && /^Missing value for --(agent|model)\.$/.test(message)) return message
  if (message?.startsWith("Unknown option "))
    return "Unknown option. Use --agent ROLE or --model provider/model before the task."
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
    return "Routing operation cancelled or timed out. Check the run status before retrying a start request."
  return "Routing operation failed. Check the connected provider and project settings, then retry. No raw provider details are displayed."
}

export async function routingReply<T>(operation: () => Promise<T>): Promise<T | RoutingFailure> {
  try {
    const value = await operation()
    // Older local configuration commands return text failures rather than throw.
    if (typeof value === "string" && value.startsWith("Routing error: "))
      return {
        ok: false,
        error: {
          code: "routing.application",
          message: safeApplicationMessage(new Error(value.slice(15))),
        },
      }
    return value
  } catch (error) {
    return {
      ok: false,
      error: { code: "routing.application", message: safeApplicationMessage(error) },
    }
  }
}

export class RoutingApplicationError extends Error {}

export function unwrapRoutingReply(value: unknown): unknown {
  if (value && typeof value === "object" && "ok" in value) {
    if (
      value.ok !== false ||
      !("error" in value) ||
      !value.error ||
      typeof value.error !== "object" ||
      !("code" in value.error) ||
      value.error.code !== "routing.application" ||
      !("message" in value.error) ||
      typeof value.error.message !== "string"
    )
      throw new Error("Invalid routing response.")
    throw new RoutingApplicationError(value.error.message)
  }
  return value
}

export function commandArguments(name: string, input = ""): string {
  const trimmed = input.trim()
  const prefix = `/${name}`
  return trimmed === prefix
    ? ""
    : trimmed.startsWith(`${prefix} `)
      ? trimmed.slice(prefix.length).trim()
      : trimmed
}
