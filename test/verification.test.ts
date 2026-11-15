import { describe, expect, test } from "bun:test"
import {
  VERIFICATION_SUMMARY_MAX_LENGTH,
  VERIFICATION_COMMAND_MAX_LENGTH,
  parseVerificationSpec,
  verifyStep,
  verifySummary,
} from "../src/verification.ts"

describe("independent report-summary verification", () => {
  test("no configured check is explicitly unverified, not a reported success", () => {
    expect(parseVerificationSpec(undefined)).toBeUndefined()
    expect(verifySummary(undefined, "The agent says all checks passed")).toEqual({
      status: "unverified",
      source: "not-configured",
      diagnostic: "No independent check was configured. Specialist claims remain unverified.",
    })
  })

  test("validates trusted bounded exact criteria without normalizing whitespace or Unicode", () => {
    const input = { summaryEquals: "  Résultat ✅\n" }
    const spec = parseVerificationSpec(input)!
    expect(spec).toEqual(input)
    input.summaryEquals = "tampered"
    expect(spec.summaryEquals).toBe("  Résultat ✅\n")
    expect(verifySummary(spec, "  Résultat ✅\n").status).toBe("passed")
    expect(verifySummary(spec, "Résultat ✅").status).toBe("failed")
    expect(verifySummary({ summaryEquals: "é" }, "e\u0301").status).toBe("failed")
    expect(
      parseVerificationSpec({ summaryEquals: "A".repeat(VERIFICATION_SUMMARY_MAX_LENGTH) }),
    ).toBeDefined()
  })

  test("rejects malformed, empty, inherited and executable-looking extra fields", () => {
    const inherited = Object.create({ summaryEquals: "OK" })
    for (const value of [
      null,
      "OK",
      [],
      {},
      inherited,
      { summaryEquals: "" },
      { summaryEquals: " \n " },
      { summaryEquals: 5 },
      { summaryEquals: "OK\0" },
      { summaryEquals: "A".repeat(VERIFICATION_SUMMARY_MAX_LENGTH + 1) },
      { summaryEquals: "OK", executable: "echo BAD" },
      { summaryEquals: "OK", passed: true },
    ])
      expect(() => parseVerificationSpec(value)).toThrow("Verification must contain only")
  })

  test("commands require independently confirmed native exit evidence", () => {
    expect(parseVerificationSpec({ command: "bun run check" })).toEqual({
      command: "bun run check",
    })
    expect(parseVerificationSpec({ command: "  bun test  ", summaryEquals: "OK" })).toEqual({
      command: "  bun test  ",
      summaryEquals: "OK",
    })
    for (const command of ["", "\n", "x\0", "x".repeat(VERIFICATION_COMMAND_MAX_LENGTH + 1)])
      expect(() => parseVerificationSpec({ command })).toThrow("Verification must contain only")
    const spec = { command: "bun test", summaryEquals: "OK" }
    expect(verifyStep(spec, "OK")).toMatchObject({ status: "unverified", source: "local-checks" })
    const result = {
      status: "passed" as const,
      source: "native-shell" as const,
      command: "bun test",
      ticketID: "ticket",
      shellID: "shell",
      exitCode: 0,
      diagnostic: "Native exit code",
    }
    expect(verifyStep(spec, "OK", result).status).toBe("passed")
    expect(verifyStep(spec, "WRONG", result).status).toBe("failed")
    expect(verifyStep(spec, "OK", { ...result, command: "other" }).status).toBe("unverified")
    expect(verifyStep(spec, "OK", { ...result, status: "running" }).status).toBe("unverified")
    expect(verifyStep(spec, "OK", { ...result, status: "failed", exitCode: 1 }).status).toBe(
      "failed",
    )
    expect(verifyStep(spec, "OK", { ...result, status: "cancelled" }).status).toBe("failed")
    expect(verifyStep(spec, "OK", { ...result, exitCode: 1 }).status).toBe("unverified")
    const { ticketID: _ticketID, ...noTicket } = result
    const { shellID: _shellID, ...noShell } = result
    expect(verifyStep(spec, "OK", noTicket).status).toBe("unverified")
    expect(verifyStep(spec, "OK", noShell).status).toBe("unverified")
    expect(verifyStep({ command: spec.command }, "OK", result)).toMatchObject({
      status: "passed",
      source: "native-shell",
    })
  })

  test("compares complete actual output, not a substring, displayed prefix or self-report", () => {
    const spec = { summaryEquals: "OK" }
    const matched = verifySummary(spec, "OK")
    expect(matched).toMatchObject({
      status: "passed",
      source: "local-summary-equality",
      expectedSummary: "OK",
      actualSummary: "OK",
    })
    expect(matched.diagnostic).toContain("does not verify the underlying work")
    for (const actual of ["prefix OK", "OK suffix", "OK\n", "OK".repeat(4000)]) {
      const result = verifySummary(spec, actual)
      expect(result.status).toBe("failed")
      expect(result.actualSummary).toBe(actual)
    }
    expect(verifySummary(spec, undefined)).toMatchObject({
      status: "unverified",
      source: "local-summary-equality",
      expectedSummary: "OK",
    })
  })
})
