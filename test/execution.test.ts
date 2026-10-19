import { describe, expect, test } from "bun:test"
import {
  assessTask,
  createExecutionEngine,
  StopUnconfirmedError,
  type ExecutionHost,
  type ExecutionModel,
  type ExecutionOutcome,
  type ExecutionRequest,
} from "../src/execution.ts"

const models: ExecutionModel[] = ["small", "mid", "big", "backup"].map((id) => ({
  providerID: "test",
  id,
  enabled: true,
  variants: [{ id: "low" }, { id: "high" }],
  capabilities: ["text", "tools", "reasoning"],
}))
function fixture(outcomes: ExecutionOutcome[] = [{ ok: true, text: "done" }]) {
  const created: string[] = []
  const cancelled: string[] = []
  let clock = 100
  let counter = 0
  const host: ExecutionHost = {
    readConfig: async () => ({
      version: 1,
      selections: {
        small: { providerID: "test", id: "small" },
        mid: { providerID: "test", id: "mid" },
        big: { providerID: "test", id: "big" },
      },
    }),
    listModels: async () => models,
    createSession: async ({ model }) => {
      created.push(model.id)
      return `session-${created.length}`
    },
    executeSession: async () => outcomes.shift() ?? { ok: true, text: "done" },
    cancelSession: async (id) => {
      cancelled.push(id)
    },
    now: () => clock,
    id: () => `plan-${++counter}`,
  }
  return {
    engine: createExecutionEngine(host),
    host,
    created,
    cancelled,
    advance: () => {
      clock += 600001
    },
  }
}
const task: ExecutionRequest = { task: "read the README", agent: "explorer" }
async function settle(f: ReturnType<typeof fixture>, id: string) {
  for (let count = 0; count < 100; count++) {
    if (f.engine.status(id).state !== "running") return f.engine.status(id)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Did not settle")
}

describe("task execution", () => {
  test("uncertain transport stop retains capacity until cancellation is confirmed", async () => {
    const f = fixture()
    f.host.executeSession = async ({ sessionID }) => {
      throw new StopUnconfirmedError(sessionID)
    }
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const plan = await f.engine.preview(task)
      ids.push(plan.id)
      f.engine.start(plan.id, { approved: true })
      expect((await settle(f, plan.id)).state).toBe("stopping")
    }
    const fourth = await f.engine.preview(task)
    expect(() => f.engine.start(fourth.id, { approved: true })).toThrow("Three tasks")
    expect((await f.engine.cancel(ids[0]!)).state).toBe("cancelled")
    expect(f.engine.start(fourth.id, { approved: true }).state).toBe("running")
    await settle(f, fourth.id)
    for (const id of [...ids.slice(1), fourth.id]) await f.engine.cancel(id)
  })
  test("honest local assessment handles simple, complex and unknown requests", () => {
    expect(assessTask("read README").difficulty).toBe("easy")
    expect(assessTask("redesign architecture across multi-file changes").difficulty).toBe("hard")
    expect(assessTask("something ambiguous").difficulty).toBe("medium")
    expect(assessTask("inspect screenshot").capabilities).toContain("imageInput")
  })
  test("preview has no side effects and approval mandatory", async () => {
    const f = fixture()
    const plan = await f.engine.preview(task)
    expect(plan.models[0]?.id).toBe("small")
    expect(f.created).toEqual([])
    expect(() => f.engine.start(plan.id, { approved: false })).toThrow("approval")
    expect(f.created).toEqual([])
  })
  test("explicit difficulty/model/variant overrides win", async () => {
    const f = fixture()
    const plan = await f.engine.preview({
      ...task,
      difficulty: "hard",
      model: { providerID: "test", id: "backup", variant: "low" },
      options: { reasoningVariants: { hard: "high" } },
    })
    expect(plan.tier).toBe("big")
    expect(plan.models[0]).toEqual({ providerID: "test", id: "backup", variant: "low" })
    expect(plan.assessment.reason).toContain("Explicit")
  })
  test("optional reasoning uses inventory variants", async () => {
    const f = fixture()
    expect(
      (await f.engine.preview({ ...task, options: { reasoningVariants: { easy: "low" } } }))
        .models[0]?.variant,
    ).toBe("low")
    await expect(
      f.engine.preview({ ...task, options: { reasoningVariants: { easy: "fake" } } }),
    ).rejects.toThrow("Variant unavailable")
  })
  test("capability mismatch and unknown requirement fail closed", async () => {
    const f = fixture()
    await expect(f.engine.preview({ ...task, task: "inspect screenshot" })).rejects.toThrow(
      "capabilities",
    )
    await expect(
      f.engine.preview({ ...task, requiredCapabilities: ["bogus" as never] }),
    ).rejects.toThrow("Unknown required")
  })
  test("run uses separate selected session and single-use approval", async () => {
    const f = fixture()
    const plan = await f.engine.preview(task)
    const run = f.engine.start(plan.id, { approved: true })
    expect(() => f.engine.start(plan.id, { approved: true })).toThrow("already used")
    const result = await settle(f, run.id)
    expect(result.state).toBe("completed")
    expect(f.created).toEqual(["small"])
    expect(result.attempts[0]?.sessionID).toBe("session-1")
  })
  test("plans expire and caller mutations cannot alter approval", async () => {
    const f = fixture()
    const plan = await f.engine.preview(task)
    plan.models[0]!.id = "big"
    f.advance()
    expect(() => f.engine.start(plan.id, { approved: true })).toThrow("expired")
    const other = await f.engine.preview(task)
    other.models[0]!.id = "big"
    const run = f.engine.start(other.id, { approved: true })
    await settle(f, run.id)
    expect(f.created).toEqual(["small"])
  })
  test("default fails once without fallback or escalation", async () => {
    const f = fixture([{ ok: false, text: "failed", failure: "model", safeToRetry: true }])
    const plan = await f.engine.preview(task)
    const run = f.engine.start(plan.id, { approved: true })
    expect((await settle(f, run.id)).state).toBe("failed")
    expect(f.created).toEqual(["small"])
  })
  test("opted-in fallback then escalation retries only this task bounded", async () => {
    const f = fixture([
      { ok: false, text: "failed", failure: "model", safeToRetry: true },
      { ok: false, text: "verification", failure: "verification", safeToRetry: true },
      { ok: true, text: "passed" },
    ])
    const plan = await f.engine.preview({
      ...task,
      options: {
        maxRetries: 2,
        sameTierFallbacks: { small: [{ providerID: "test", id: "backup" }] },
        escalateFailedStep: true,
      },
    })
    const run = f.engine.start(plan.id, { approved: true })
    expect((await settle(f, run.id)).state).toBe("completed")
    expect(f.created).toEqual(["small", "backup", "mid"])
  })
  test("potential side effects never replay without explicit approval", async () => {
    const f = fixture([{ ok: false, text: "changed files", failure: "verification" }])
    const plan = await f.engine.preview({
      ...task,
      options: { maxRetries: 1, escalateFailedStep: true },
    })
    const run = f.engine.start(plan.id, { approved: true })
    await settle(f, run.id)
    expect(f.created).toEqual(["small"])
  })
  test("explicit replay approval permits otherwise unsafe retry", async () => {
    const f = fixture([{ ok: false, text: "changed files", failure: "verification" }])
    const plan = await f.engine.preview({
      ...task,
      options: { maxRetries: 1, escalateFailedStep: true },
    })
    const run = f.engine.start(plan.id, { approved: true, confirmSideEffectReplay: true })
    await settle(f, run.id)
    expect(f.created).toEqual(["small", "mid"])
  })
  for (const failure of ["credentials", "permission", "cancelled", "unknown"] as const)
    test(`${failure} failure never retries`, async () => {
      const f = fixture([{ ok: false, text: "blocked", failure, safeToRetry: true }])
      const plan = await f.engine.preview({
        ...task,
        options: { maxRetries: 3, escalateFailedStep: true },
      })
      const run = f.engine.start(plan.id, { approved: true, confirmSideEffectReplay: true })
      await settle(f, run.id)
      expect(f.created).toEqual(["small"])
    })
  test("exceptions are conservative and do not retry", async () => {
    const f = fixture()
    f.host.executeSession = async () => {
      throw new Error("network unknown")
    }
    const plan = await f.engine.preview({
      ...task,
      options: { maxRetries: 1, escalateFailedStep: true },
    })
    const run = f.engine.start(plan.id, { approved: true })
    expect((await settle(f, run.id)).result).toBe("network unknown")
    expect(f.created).toEqual(["small"])
  })
  test("cancel aborts pending task and cancels server session", async () => {
    const f = fixture()
    f.host.executeSession = async ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    const plan = await f.engine.preview(task)
    const run = f.engine.start(plan.id, { approved: true })
    await new Promise((resolve) => setTimeout(resolve, 1))
    expect((await f.engine.cancel(run.id)).state).toBe("cancelled")
    expect(f.cancelled).toEqual(["session-1"])
  })
  test("inventory is revalidated before dispatch", async () => {
    const f = fixture()
    const plan = await f.engine.preview(task)
    f.host.listModels = async () => []
    const run = f.engine.start(plan.id, { approved: true })
    expect((await settle(f, run.id)).state).toBe("failed")
    expect(f.created).toEqual([])
  })
  test("rejects invalid limits, task and agent", async () => {
    const f = fixture()
    for (const maxRetries of [-1, 4, 0.5])
      await expect(f.engine.preview({ ...task, options: { maxRetries } })).rejects.toThrow(
        "Retries",
      )
    await expect(f.engine.preview({ ...task, task: "" })).rejects.toThrow("task")
    await expect(f.engine.preview({ ...task, agent: "fake" as never })).rejects.toThrow("agent")
    await expect(f.engine.preview({ ...task, options: { maxDurationMs: 0 } })).rejects.toThrow(
      "Duration",
    )
  })
  test("text diagrams do not falsely require image input", () => {
    expect(assessTask("explain with a diagram").capabilities).not.toContain("imageInput")
    expect(assessTask("generate an image").capabilities).not.toContain("imageInput")
  })
  test("failed interruption is reported as uncertain, never cancelled", async () => {
    const f = fixture()
    f.host.executeSession = async ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      )
    f.host.cancelSession = async () => {
      throw new Error("server unavailable")
    }
    const plan = await f.engine.preview(task)
    const run = f.engine.start(plan.id, { approved: true })
    await new Promise((resolve) => setTimeout(resolve, 1))
    const stopped = await f.engine.cancel(run.id)
    expect(stopped.state).toBe("stopping")
    expect(stopped.result).toContain("Stop not confirmed for session session-1")
    expect(f.engine.status(run.id).state).toBe("stopping")
    f.host.cancelSession = async () => undefined
    expect((await f.engine.cancel(run.id)).state).toBe("cancelled")
  })
  test("cancellation during creation waits for ID and interrupts before claiming stopped", async () => {
    const f = fixture()
    let resolveCreation!: (id: string) => void
    f.host.createSession = async () =>
      new Promise((resolve) => {
        resolveCreation = resolve
      })
    let prompts = 0
    f.host.executeSession = async () => {
      prompts++
      return { ok: true, text: "unexpected" }
    }
    const plan = await f.engine.preview(task)
    const run = f.engine.start(plan.id, { approved: true })
    await new Promise((resolve) => setTimeout(resolve, 1))
    const stopping = f.engine.cancel(run.id)
    expect(f.engine.status(run.id).state).toBe("stopping")
    resolveCreation("late-session")
    expect((await stopping).state).toBe("cancelled")
    expect(f.cancelled).toEqual(["late-session"])
    expect(prompts).toBe(0)
  })
  test("execution deadline interrupts the actual child", async () => {
    const f = fixture()
    f.host.executeSession = async ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      )
    const plan = await f.engine.preview({ ...task, options: { maxDurationMs: 1000 } })
    const run = f.engine.start(plan.id, { approved: true })
    await new Promise((resolve) => setTimeout(resolve, 1050))
    expect(f.engine.status(run.id).state).toBe("cancelled")
    expect(f.cancelled).toEqual(["session-1"])
  })
  test("three concurrent tasks are allowed, fourth waits without consuming plan", async () => {
    const f = fixture()
    f.host.executeSession = async ({ signal }) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      )
    const active: string[] = []
    for (let i = 0; i < 3; i++) {
      const plan = await f.engine.preview(task)
      active.push(f.engine.start(plan.id, { approved: true }).id)
    }
    const fourth = await f.engine.preview(task)
    expect(() => f.engine.start(fourth.id, { approved: true })).toThrow("Three tasks")
    await Promise.all(active.map((id) => f.engine.cancel(id)))
    const next = f.engine.start(fourth.id, { approved: true })
    await f.engine.cancel(next.id)
  })
  test("completed history is bounded and old plans can be discarded", async () => {
    const f = fixture()
    const dropped = await f.engine.preview(task)
    f.engine.discard(dropped.id)
    expect(() => f.engine.start(dropped.id, { approved: true })).toThrow("Unknown")
    let first = ""
    for (let i = 0; i < 201; i++) {
      const plan = await f.engine.preview(task)
      const run = f.engine.start(plan.id, { approved: true })
      if (!first) first = run.id
      await settle(f, run.id)
    }
    expect(() => f.engine.status(first)).toThrow("Unknown task")
  })
})
