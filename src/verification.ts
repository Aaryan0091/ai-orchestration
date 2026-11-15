/** Trusted Desktop-selected checks only. Model reports cannot configure verification. */
export const VERIFICATION_SUMMARY_MAX_LENGTH = 2000
export const VERIFICATION_COMMAND_MAX_LENGTH = 1000

export interface VerificationSpec {
  summaryEquals?: string
  command?: string
}

export interface CommandVerificationResult {
  status: "pending" | "running" | "passed" | "failed" | "unverified" | "cancelled"
  source: "native-shell"
  command: string
  ticketID?: string
  sessionID?: string
  shellID?: string
  exitCode?: number
  diagnostic: string
}

export interface VerificationResult {
  status: "passed" | "failed" | "unverified"
  source: "local-summary-equality" | "not-configured" | "native-shell" | "local-checks"
  expectedSummary?: string
  actualSummary?: string
  diagnostic: string
}

export class VerificationError extends Error {
  constructor() {
    super(
      `Verification must contain only summaryEquals (up to ${VERIFICATION_SUMMARY_MAX_LENGTH} characters) and/or command (up to ${VERIFICATION_COMMAND_MAX_LENGTH} characters). Provide at least one nonempty text field, without NUL characters.`,
    )
    this.name = "VerificationError"
  }
}

/** Preserve whitespace and Unicode exactly: this is equality, not a semantic judgment. */
export function parseVerificationSpec(value: unknown): VerificationSpec | undefined {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length === 0 ||
    Object.keys(value).some((key) => key !== "summaryEquals" && key !== "command")
  )
    throw new VerificationError()
  const result: VerificationSpec = {}
  for (const [key, limit] of [
    ["summaryEquals", VERIFICATION_SUMMARY_MAX_LENGTH],
    ["command", VERIFICATION_COMMAND_MAX_LENGTH],
  ] as const) {
    if (!Object.hasOwn(value, key)) continue
    const text = (value as Record<string, unknown>)[key]
    if (typeof text !== "string" || !text.trim() || text.length > limit || text.includes("\0"))
      throw new VerificationError()
    result[key] = text
  }
  if (Object.keys(result).length === 0) throw new VerificationError()
  return result
}

/** Independently compare the full report summary, never its self-reported check status. */
export function verifySummary(
  spec: VerificationSpec | undefined,
  summary: string | undefined,
): VerificationResult {
  if (spec?.summaryEquals === undefined)
    return {
      status: "unverified",
      source: "not-configured",
      diagnostic: "No independent check was configured. Specialist claims remain unverified.",
    }
  if (summary === undefined)
    return {
      status: "unverified",
      source: "local-summary-equality",
      expectedSummary: spec.summaryEquals,
      diagnostic: "The required report summary is unavailable. The equality check could not run.",
    }
  const passed = summary === spec.summaryEquals
  return {
    status: passed ? "passed" : "failed",
    source: "local-summary-equality",
    expectedSummary: spec.summaryEquals,
    actualSummary: summary,
    diagnostic: passed
      ? "The full report summary exactly matches the approved expected text. This does not verify the underlying work."
      : "The full report summary does not exactly match the approved expected text. Dependent steps remain blocked.",
  }
}

/** Combine independently observed command evidence with the exact-summary check. */
export function verifyStep(
  spec: VerificationSpec | undefined,
  summary: string | undefined,
  commandResult?: CommandVerificationResult,
): VerificationResult {
  const result = verifySummary(spec, summary)
  if (!spec?.command) return result
  const source = spec.summaryEquals === undefined ? "native-shell" : "local-checks"
  if (spec.summaryEquals !== undefined && result.status !== "passed") return { ...result, source }
  if (
    !commandResult ||
    commandResult.command !== spec.command ||
    commandResult.source !== "native-shell"
  )
    return {
      ...result,
      status: "unverified",
      source,
      diagnostic:
        "The required command has not been independently checked. Review and run it separately; dependent steps remain blocked.",
    }
  if (
    commandResult.status === "passed" &&
    commandResult.exitCode === 0 &&
    !!commandResult.shellID &&
    !!commandResult.ticketID
  )
    return {
      ...result,
      status: "passed",
      source,
      diagnostic:
        "All configured independent checks passed. A zero command exit code and/or summary equality do not prove the absence of other defects.",
    }
  return {
    ...result,
    status:
      commandResult.status === "failed" || commandResult.status === "cancelled"
        ? "failed"
        : "unverified",
    source,
    diagnostic:
      commandResult.status === "failed" || commandResult.status === "cancelled"
        ? "The required independent command check failed or was cancelled. Dependent steps remain blocked."
        : "The required independent command check is not confirmed as passed. Dependent steps remain blocked.",
  }
}

export const verificationSpecSchema = {
  type: "object",
  properties: {
    summaryEquals: {
      type: "string",
      minLength: 1,
      maxLength: VERIFICATION_SUMMARY_MAX_LENGTH,
    },
    command: { type: "string", minLength: 1, maxLength: VERIFICATION_COMMAND_MAX_LENGTH },
  },
  anyOf: [{ required: ["summaryEquals"] }, { required: ["command"] }],
  additionalProperties: false,
} as const

export const verificationResultSchema = {
  type: "object",
  properties: {
    status: { enum: ["passed", "failed", "unverified"] },
    source: { enum: ["local-summary-equality", "not-configured", "native-shell", "local-checks"] },
    expectedSummary: { type: "string", maxLength: VERIFICATION_SUMMARY_MAX_LENGTH },
    actualSummary: { type: "string", maxLength: 8000 },
    diagnostic: { type: "string" },
  },
  required: ["status", "source", "diagnostic"],
  additionalProperties: false,
} as const

export const commandVerificationResultSchema = {
  type: "object",
  properties: {
    status: { enum: ["pending", "running", "passed", "failed", "unverified", "cancelled"] },
    source: { const: "native-shell" },
    command: { type: "string", maxLength: VERIFICATION_COMMAND_MAX_LENGTH },
    ticketID: { type: "string" },
    sessionID: { type: "string" },
    shellID: { type: "string" },
    exitCode: { type: "number" },
    diagnostic: { type: "string" },
  },
  required: ["status", "source", "command", "diagnostic"],
  additionalProperties: false,
} as const
