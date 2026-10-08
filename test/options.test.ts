import { describe, expect, test } from "bun:test"

import { AGENT_IDS, isRoutingMode, parseOptions } from "../src/shared/types.ts"

describe("parseOptions", () => {
  test("uses safe defaults", () => {
    expect(parseOptions(undefined)).toEqual({ mode: "guided", notifyOnLoad: false })
    expect(parseOptions({})).toEqual({ mode: "guided", notifyOnLoad: false })
  })

  test("accepts supported modes and an explicit notification flag", () => {
    expect(parseOptions({ mode: "manual", notifyOnLoad: true })).toEqual({
      mode: "manual",
      notifyOnLoad: true,
    })
  })

  test("rejects unsupported or truthy non-boolean values", () => {
    expect(parseOptions({ mode: "magic", notifyOnLoad: "yes" })).toEqual({
      mode: "guided",
      notifyOnLoad: false,
    })
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
