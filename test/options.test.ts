import { describe, expect, test } from "bun:test"

import { AGENT_IDS, isRoutingMode, parseOptions, parseTuiOptions } from "../src/shared/types.ts"

describe("parseOptions", () => {
  test("uses safe defaults", () => {
    expect(parseOptions(undefined)).toEqual({ mode: "guided" })
    expect(parseOptions({})).toEqual({ mode: "guided" })
  })

  test("accepts supported modes", () => {
    expect(parseOptions({ mode: "manual" })).toEqual({ mode: "manual" })
  })

  test("rejects unsupported values", () => {
    expect(parseOptions({ mode: "magic" })).toEqual({ mode: "guided" })
  })
})

describe("parseTuiOptions", () => {
  test("notifies by default because project options do not reach the TUI plugin", () => {
    expect(parseTuiOptions(undefined)).toEqual({ notifyOnLoad: true })
    expect(parseTuiOptions({})).toEqual({ notifyOnLoad: true })
  })

  test("only an explicit false disables the notification", () => {
    expect(parseTuiOptions({ notifyOnLoad: false })).toEqual({ notifyOnLoad: false })
    expect(parseTuiOptions({ notifyOnLoad: "no" })).toEqual({ notifyOnLoad: true })
  })
})

describe("foundation contracts", () => {
  test("exposes the eight initial agents", () => {
    expect(AGENT_IDS).toHaveLength(8)
    expect(new Set(AGENT_IDS).size).toBe(AGENT_IDS.length)
  })

  test("recognizes only documented routing modes", () => {
    expect(isRoutingMode("automatic")).toBe(true)
    expect(isRoutingMode("guided")).toBe(true)
    expect(isRoutingMode("manual")).toBe(true)
    expect(isRoutingMode("unknown")).toBe(false)
  })
})
