import { describe, expect, test } from "bun:test"
import { createExecutionEngine, type ExecutionHost, type ExecutionModel } from "../src/execution.ts"
import type { RoutingConfig } from "../src/routing.ts"
import { previewWorkflow, validateWorkflowInput } from "../src/workflow-plan.ts"

const step = (id: string, dependsOn: string[] = []) => ({
  id,
  task: "Read the README",
  agent: "explorer" as const,
  dependsOn,
})
const input = (...steps: unknown[]) => ({ title: "Review changes", steps })

function fixture() {
  const reads = { config: 0, inventory: 0, ids: 0, created: 0, executed: 0, cancelled: 0 }
  const config: RoutingConfig = {
    version: 1,
    selections: {
      small: { providerID: "test", id: "small", variant: "low" },
      big: { providerID: "test", id: "big" },
    },
  }
  const models: ExecutionModel[] = [
    {
      providerID: "test",
      id: "small",
      enabled: true,
      variants: [{ id: "low" }],
      capabilities: ["text", "tools"],
    },
    {
      providerID: "test",
      id: "big",
      enabled: true,
      variants: [],
      capabilities: ["text"],
    },
  ]
  const host: ExecutionHost = {
    readConfig: async () => {
      reads.config++
      return config
    },
    listModels: async () => {
      reads.inventory++
      return models
    },
    id: () => `run-${++reads.ids}`,
    createSession: async () => `session-${++reads.created}`,
    executeSession: async () => {
      reads.executed++
      return { ok: true, text: "done" }
    },
    cancelSession: async () => {
      reads.cancelled++
    },
  }
  return { host, engine: createExecutionEngine(host), config, models, reads }
}

describe("workflow planning", () => {
  test("validates every step and dependency before resolving any model", async () => {
    const f = fixture()
    for (const [value, error] of [
      [input(), "1 to 12 steps"],
      [input(...Array.from({ length: 13 }, (_, index) => step(`step${index}`))), "1 to 12 steps"],
      [input(step("a"), step("a")), "duplicate step IDs"],
      [input(step("a"), step("b", ["c"])), "missing dependency"],
      [input(step("a", ["b"]), step("b", ["a"])), "circular dependencies"],
      [input(step("a", ["a"])), "circular dependencies"],
      [input(step("a"), step("b", ["a", "a"])), "duplicate dependencies"],
      [input({ ...step("a"), agent: "orchestrator" }), "known specialist"],
      [input({ ...step("a"), difficulty: "expert" }), "difficulty must be"],
      [input({ ...step("a"), model: "test/big" }), "unsupported fields"],
      [input({ ...step("a"), task: "x".repeat(1001) }), "at most 1000 characters"],
      [input(step("a\n")), "must start with"],
      [
        input(
          step(
            "a",
            Array.from({ length: 12 }, (_, index) => `step${index}`),
          ),
        ),
        "up to 11",
      ],
      [{ ...input(step("a")), title: " " }, "Workflow title"],
      [{ ...input(step("a")), history: [] }, "unsupported fields"],
    ] as const) {
      await expect(previewWorkflow(value, f.engine.previewRouting)).rejects.toThrow(error)
    }
    expect(f.reads).toEqual({
      config: 0,
      inventory: 0,
      ids: 0,
      created: 0,
      executed: 0,
      cancelled: 0,
    })
  })

  test("topologically sorts deterministically and returns fresh bounded objects", () => {
    const source = input(
      step("final", ["work"]),
      step("work", ["scan"]),
      step("scan"),
      step("other"),
    )
    const plan = validateWorkflowInput(source)
    expect(plan.steps.map(({ id }) => id)).toEqual(["scan", "work", "final", "other"])
    expect(plan.steps[1]?.dependsOn).toEqual(["scan"])
    expect(plan.steps[1]).not.toBe(source.steps[1])
    expect(plan.steps[1]?.dependsOn).not.toBe(
      (source.steps[1] as ReturnType<typeof step>).dependsOn,
    )
  })

  test("uses one fresh saved tier and inventory snapshot per preview, showing per-step blockers", async () => {
    const f = fixture()
    const source = input(
      step("read"),
      { ...step("plan", ["read"]), agent: "planner", difficulty: "medium" },
      { ...step("check", ["plan"]), agent: "verifier", difficulty: "hard" },
      { ...step("image"), task: "Generate an image" },
    )
    const plan = await previewWorkflow(source, f.engine.createWorkflowRoutingResolver())
    expect(plan.steps).toMatchObject([
      { id: "read", difficulty: "easy", tier: "small", model: "test/small#low" },
      { id: "plan", difficulty: "medium", tier: "mid", blocker: "Select a mid model first." },
      {
        id: "check",
        tier: "big",
        model: "test/big",
        blocker:
          "Model does not have confirmed capabilities: tools. Choose a compatible model for the saved big tier, then prepare a new draft.",
      },
      { id: "image", blocker: expect.stringContaining("Image generation is not supported") },
    ])
    expect(plan.steps[1]?.model).toBeUndefined()
    expect(f.reads).toEqual({
      config: 1,
      inventory: 1,
      ids: 0,
      created: 0,
      executed: 0,
      cancelled: 0,
    })
    f.models[0]!.enabled = false
    const revised = await previewWorkflow(
      input(step("read")),
      f.engine.createWorkflowRoutingResolver(),
    )
    expect(revised.steps[0]?.blocker).toContain("Model unavailable: test/small#low")
  })

  test("never issues runnable plan IDs or consumes execution capacity", async () => {
    const f = fixture()
    for (let count = 0; count < 105; count++)
      await previewWorkflow(input(step("read")), f.engine.createWorkflowRoutingResolver())
    expect(f.reads.ids).toBe(0)
    expect(() => f.engine.start("read", { approved: true })).toThrow("Unknown or already used plan")
    expect(() => f.engine.start("run-1", { approved: true })).toThrow(
      "Unknown or already used plan",
    )
    expect(f.reads.created).toBe(0)
    expect(f.reads.executed).toBe(0)
    const runnable = await f.engine.preview({ task: "Read the README", agent: "explorer" })
    expect(runnable.id).toBe("run-1")
    expect(runnable.models[0]).toEqual({ providerID: "test", id: "small", variant: "low" })
  })

  test("does not expose arbitrary storage, catalog, or resolver diagnostics", async () => {
    const f = fixture()
    f.host.listModels = async () => {
      throw new Error("private model catalog error")
    }
    const plan = await previewWorkflow(
      input(step("read")),
      f.engine.createWorkflowRoutingResolver(),
    )
    expect(plan.steps[0]?.blocker).toBe("Could not read connected models.")
    f.host.readConfig = async () => {
      throw new Error("private storage error")
    }
    const revision = await previewWorkflow(
      input(step("read")),
      f.engine.createWorkflowRoutingResolver(),
    )
    expect(revision.steps[0]?.blocker).toBe("Could not read saved project model tiers.")
    await expect(
      previewWorkflow(input(step("read")), async () => {
        throw new Error("private resolver error")
      }),
    ).rejects.toThrow("Could not preview workflow routing. Try again.")
  })
})
