import { describe, expect, test } from "bun:test"
import type { ExecutionPlan, ExecutionRequest, TaskRun } from "../src/execution.ts"
import { createGuidedWorkflows } from "../src/guided-workflows.ts"
import type { SpecialistReport } from "../src/handoffs.ts"
import type { WorkflowDraft } from "../src/workflow-rpc.ts"

const directory = "/guided-workflow-test"
const sessionID = "chat-a"
const draftID = "workflow-draft-a"
const check = "The approved step objective was completed."

function fixture() {
  let time = 100
  let serial = 0
  const draft: WorkflowDraft = {
    id: draftID,
    sessionID,
    directory,
    title: "Validate login",
    createdAt: time,
    expiresAt: time + 10 * 60 * 1000,
    steps: [
      {
        id: "inspect",
        task: "Inspect login",
        agent: "explorer",
        dependsOn: [],
        difficulty: "easy",
        tier: "small",
        model: "provider/one#low",
      },
      {
        id: "plan",
        task: "Plan a fix",
        agent: "planner",
        dependsOn: ["inspect"],
        difficulty: "medium",
        tier: "mid",
        model: "provider/two",
      },
      {
        id: "verify",
        task: "Verify the plan",
        agent: "verifier",
        dependsOn: ["plan"],
        difficulty: "hard",
        tier: "big",
        model: "provider/three",
      },
    ],
  }
  const plans = new Map<string, ExecutionPlan>()
  const runs = new Map<string, TaskRun>()
  const calls = {
    preview: [] as ExecutionRequest[],
    start: [] as string[],
    discard: [] as string[],
    cancel: [] as string[],
  }
  let location = directory
  let waitForPreview: Promise<void> | undefined
  let rejectPreview = false
  let uncertainCancel = false
  const enteredPreview = Promise.withResolvers<void>()
  const api = createGuidedWorkflows({
    directory,
    now: () => time,
    id: () => `test-${++serial}`,
    session: async () => ({ location: { directory: location } }),
    draft: async () => draft,
    changed: async () => {},
    engine: {
      async preview(request) {
        calls.preview.push(structuredClone(request))
        enteredPreview.resolve()
        if (waitForPreview) await waitForPreview
        if (rejectPreview) throw new Error("Provider returned secret-key=hidden")
        const plan: ExecutionPlan = {
          id: `private-engine-${calls.preview.length}`,
          task: request.task,
          agent: request.agent!,
          assessment: {
            difficulty: request.difficulty === "auto" ? "easy" : request.difficulty!,
            reason: "fixture",
            capabilities: ["text"],
          },
          tier: "small",
          models: [request.model!],
          options: request.options!,
          createdAt: time,
          ...(request.handoff ? { handoff: request.handoff } : {}),
        }
        plans.set(plan.id, plan)
        return structuredClone(plan)
      },
      start(planID, approval) {
        expect(approval).toEqual({ approved: true })
        const plan = plans.get(planID)
        if (!plan) throw new Error("Unknown plan")
        plans.delete(planID)
        calls.start.push(planID)
        const run: TaskRun = { id: planID, state: "running", plan, attempts: [] }
        runs.set(run.id, run)
        return structuredClone(run)
      },
      status(runID) {
        const run = runs.get(runID)
        if (!run) throw new Error("Unknown run")
        return structuredClone(run)
      },
      async cancel(runID) {
        calls.cancel.push(runID)
        if (uncertainCancel) throw new Error("Untrusted provider debug trace")
        const run = runs.get(runID)!
        run.state = "cancelled"
        return structuredClone(run)
      },
      discard(planID) {
        calls.discard.push(planID)
        plans.delete(planID)
      },
    },
  })

  async function begin(selectedDraftID = draftID) {
    return (await api.begin({ sessionID, draftID: selectedDraftID })).id
  }
  async function review(workflowID: string, stepID: string, includeDependencySummaries?: boolean) {
    return api.review({ sessionID, workflowID, stepID, includeDependencySummaries })
  }
  async function approve(reviewID: string, signal?: AbortSignal) {
    return api.approve({ sessionID, reviewID }, signal)
  }
  async function state() {
    return (await api.state({ sessionID })).workflows[0]!
  }
  function finish(
    runID: string,
    summary: string,
    status: SpecialistReport["checks"][number]["status"] = "passed",
  ) {
    const run = runs.get(runID)!
    run.state = "completed"
    run.specialistReport = {
      version: 1,
      summary,
      findings: [],
      evidence: [],
      limitations: [],
      checks: [{ check, status, details: "Fixture result" }],
    }
  }
  return {
    api,
    draft,
    begin,
    review,
    approve,
    state,
    finish,
    calls,
    plans,
    runs,
    move: () => {
      location = "/other-project"
    },
    advance: (ms: number) => {
      time += ms
    },
    holdPreview: (promise: Promise<void>) => {
      waitForPreview = promise
    },
    enteredPreview: enteredPreview.promise,
    rejectPreview: () => {
      rejectPreview = true
    },
    uncertainCancel: (uncertain: boolean) => {
      uncertainCancel = uncertain
    },
  }
}

describe("guided workflows", () => {
  test("setup and review are inert; an exact one-time approval starts only the ordered step", async () => {
    const f = fixture()
    const id = await f.begin()
    expect(await f.begin()).toBe(id)
    expect((await f.state()).steps.map((step) => step.state)).toEqual([
      "ready",
      "waiting",
      "waiting",
    ])
    await expect(f.review(id, "plan")).rejects.toThrow("not ready")
    const first = await f.review(id, "inspect")
    expect(first.model).toBe("provider/one#low")
    expect(first.previousResults).toEqual([])
    expect(f.calls.preview).toEqual([])
    expect(f.calls.start).toEqual([])
    expect(f.plans.size).toBe(0)
    f.draft.steps[0]!.model = "provider/substitution"
    first.model = "provider/tampered"
    await f.approve(first.id)
    expect(f.calls.preview[0]).toMatchObject({
      task: "Inspect login",
      agent: "explorer",
      model: { providerID: "provider", id: "one", variant: "low" },
      handoff: {
        version: 1,
        objective: "Inspect login",
        files: [],
        findings: [],
        previousResults: [],
        acceptanceChecks: [check],
      },
      options: { maxRetries: 0, escalateFailedStep: false },
    })
    const view = await f.state()
    expect(view.steps[0]?.runID).toStartWith("guided-run-")
    expect(view.steps[0]?.runID).not.toBe(f.calls.start[0])
    expect(JSON.stringify(view)).not.toContain("private-engine-")
    await expect(f.approve(first.id)).rejects.toThrow("already used")
    await expect(f.review(id, "plan")).rejects.toThrow("not ready")
    expect(f.calls.start).toHaveLength(1)

    f.finish(f.calls.start[0]!, "A".repeat(2100))
    expect((await f.state()).steps.map((step) => step.state)).toEqual([
      "completed",
      "ready",
      "waiting",
    ])
    expect((await f.review(id, "plan")).previousResults).toEqual([])
    const next = await f.review(id, "plan", true)
    expect(next.previousResults[0]).toMatchObject({
      stepID: "inspect",
      runID: view.steps[0]?.runID,
    })
    const reviewedSummary = next.previousResults[0]!.summary
    expect(reviewedSummary.length).toBe(2000)
    next.previousResults[0]!.summary = "tampered"
    await f.approve(next.id)
    expect(f.calls.preview[1]?.handoff?.previousResults).toEqual([
      { runID: next.previousResults[0]!.runID, summary: reviewedSummary },
    ])
    f.finish(f.calls.start[1]!, "Plan result")
    const final = await f.review(id, "verify", true)
    expect(final.previousResults.map((item) => item.stepID)).toEqual(["plan"])
    await f.approve(final.id)
    f.finish(f.calls.start[2]!, "Verified")
    expect((await f.state()).state).toBe("completed")
    expect(f.calls.start).toHaveLength(3)
  })

  test("rejects blocked tiers, malformed input, wrong chat/project, expired and superseded reviews", async () => {
    const f = fixture()
    f.draft.steps[2]!.blocker = "Missing big tier"
    await expect(f.begin()).rejects.toThrow("blocked model selections")
    delete f.draft.steps[2]!.blocker
    const id = await f.begin()
    expect((await f.api.state({ sessionID: "chat-b" })).workflows).toEqual([])
    await expect(
      f.api.review({ sessionID: "chat-b", workflowID: id, stepID: "inspect" }),
    ).rejects.toThrow("not available in this chat")
    await expect(
      f.api.review({ sessionID, workflowID: id, stepID: "inspect", includeDependencySummaries: 1 }),
    ).rejects.toThrow("Invalid guided workflow")
    await expect(f.api.begin({ sessionID, draftID, model: "override" })).rejects.toThrow(
      "Invalid guided workflow",
    )
    const old = await f.review(id, "inspect")
    const current = await f.review(id, "inspect")
    await expect(f.approve(old.id)).rejects.toThrow("already used")
    await expect(f.api.approve({ sessionID: "chat-b", reviewID: current.id })).rejects.toThrow(
      "not available in this chat",
    )
    expect(await f.api.dismiss({ sessionID, reviewID: current.id })).toEqual({ id: current.id })
    await expect(f.approve(current.id)).rejects.toThrow("already used")
    const expired = await f.review(id, "inspect")
    f.advance(10 * 60 * 1000)
    await expect(f.approve(expired.id)).rejects.toThrow("expired")
    f.move()
    await expect(f.api.state({ sessionID })).rejects.toThrow("another project")
    expect(f.calls.preview).toEqual([])
  })

  test("reserves a step before async planning; moving chats discards the private plan without dispatch", async () => {
    const f = fixture()
    const id = await f.begin()
    const review = await f.review(id, "inspect")
    const gate = Promise.withResolvers<void>()
    f.holdPreview(gate.promise)
    const approval = f.approve(review.id)
    await f.enteredPreview
    expect((await f.state()).steps[0]?.state).toBe("starting")
    await expect(f.approve(review.id)).rejects.toThrow("already used")
    await expect(f.review(id, "inspect")).rejects.toThrow("not ready")
    f.move()
    gate.resolve()
    await expect(approval).rejects.toThrow("another project")
    expect(f.calls.start).toEqual([])
    expect(f.calls.discard).toEqual(["private-engine-1"])
    expect(f.plans.size).toBe(0)
  })

  test("expired or aborted in-flight approvals cannot dispatch; a fresh review is required", async () => {
    for (const cause of ["expired", "aborted"] as const) {
      const f = fixture()
      const id = await f.begin()
      const review = await f.review(id, "inspect")
      const gate = Promise.withResolvers<void>()
      f.holdPreview(gate.promise)
      const controller = new AbortController()
      const approval = f.approve(review.id, controller.signal)
      await f.enteredPreview
      if (cause === "expired") f.advance(10 * 60 * 1000)
      else controller.abort()
      gate.resolve()
      await expect(approval).rejects.toThrow()
      expect((await f.state()).steps[0]?.state).toBe("ready")
      expect(f.calls.start).toEqual([])
      expect(f.calls.discard).toEqual(["private-engine-1"])
    }
  })

  test("failed/not-run checks and evicted prerequisite results keep dependents blocked", async () => {
    for (const outcome of ["failed", "not-run", "evicted"] as const) {
      const f = fixture()
      const id = await f.begin()
      await f.approve((await f.review(id, "inspect")).id)
      const engineID = f.calls.start[0]!
      if (outcome === "evicted") {
        f.finish(engineID, "Report")
        expect((await f.state()).steps[1]?.state).toBe("ready")
        f.runs.delete(engineID)
      } else f.finish(engineID, "Report", outcome)
      const state = await f.state()
      expect(state.state).toBe("stopped")
      expect(state.steps.map((step) => step.state)).toEqual(["failed", "blocked", "blocked"])
      await expect(f.review(id, "plan", true)).rejects.toThrow("not ready")
      expect(f.calls.start).toHaveLength(1)
    }
  })

  test("model validation failure is sanitized, stops the workflow, and never substitutes a model", async () => {
    const f = fixture()
    const id = await f.begin()
    const review = await f.review(id, "inspect")
    f.rejectPreview()
    await expect(f.approve(review.id)).rejects.toThrow("Check the model connection")
    const state = await f.state()
    expect(state.state).toBe("stopped")
    expect(JSON.stringify(state)).not.toContain("secret-key")
    expect(f.calls.start).toEqual([])
  })

  test("unconfirmed cancellation remains stopping, blocks all later steps, and can be confirmed", async () => {
    const f = fixture()
    const id = await f.begin()
    await f.approve((await f.review(id, "inspect")).id)
    f.uncertainCancel(true)
    const input = { sessionID, workflowID: id, stepID: "inspect" }
    await f.api.cancel(input)
    const stopping = await f.state()
    expect(stopping.steps.map((step) => step.state)).toEqual(["stopping", "blocked", "blocked"])
    expect(stopping.steps[0]?.diagnostic).toContain("Stop not confirmed")
    expect(JSON.stringify(stopping)).not.toContain("Untrusted provider debug trace")
    f.uncertainCancel(false)
    await f.api.cancel(input)
    expect((await f.state()).steps.map((step) => step.state)).toEqual([
      "cancelled",
      "blocked",
      "blocked",
    ])
    expect(f.calls.start).toHaveLength(1)
  })

  test("dispose cancels active owned sessions and closes the approval path without replay", async () => {
    const f = fixture()
    const id = await f.begin()
    const review = await f.review(id, "inspect")
    await f.approve(review.id)
    await f.api.dispose()
    expect(f.calls.cancel).toEqual(f.calls.start)
    await expect(f.approve(review.id)).rejects.toThrow("cleared on restart")
    expect(f.calls.start).toHaveLength(1)
  })

  test("cancelling setup before engine start prevents dispatch after asynchronous planning", async () => {
    const f = fixture()
    const id = await f.begin()
    const review = await f.review(id, "inspect")
    const gate = Promise.withResolvers<void>()
    f.holdPreview(gate.promise)
    const approval = f.approve(review.id)
    await f.enteredPreview
    await f.api.cancel({ sessionID, workflowID: id, stepID: "inspect" })
    gate.resolve()
    await expect(approval).rejects.toThrow("cancelled before it started")
    expect((await f.state()).steps.map((step) => step.state)).toEqual([
      "cancelled",
      "blocked",
      "blocked",
    ])
    expect(f.calls.start).toEqual([])
    expect(f.calls.cancel).toEqual([])
    expect(f.calls.discard).toEqual(["private-engine-1"])
  })

  test("rechecks a prerequisite after async planning, before dispatching its dependent", async () => {
    const f = fixture()
    const id = await f.begin()
    await f.approve((await f.review(id, "inspect")).id)
    const firstID = f.calls.start[0]!
    f.finish(firstID, "Report")
    const secondReview = await f.review(id, "plan", true)
    const gate = Promise.withResolvers<void>()
    f.holdPreview(gate.promise)
    const approval = f.approve(secondReview.id)
    // State reads the first step and observes its completed report while the second is preparing.
    expect((await f.state()).steps[1]?.state).toBe("starting")
    f.runs.delete(firstID)
    gate.resolve()
    await expect(approval).rejects.toThrow("specialist result is unavailable")
    expect(f.calls.start).toEqual([firstID])
    expect(f.calls.discard).toEqual(["private-engine-2"])
    expect((await f.state()).steps[2]?.state).toBe("blocked")
  })

  test("capacity only evicts finished workflows owned by the same chat", async () => {
    const f = fixture()
    const first = await f.begin()
    for (let i = 1; i < 5; i++) {
      f.draft.id = `draft-${i}`
      await f.begin(f.draft.id)
    }
    f.draft.id = "over-capacity"
    await expect(f.begin(f.draft.id)).rejects.toThrow("limit was reached")
    await f.approve((await f.review(first, "inspect")).id)
    await f.api.cancel({ sessionID, workflowID: first, stepID: "inspect" })
    const replacement = await f.begin(f.draft.id)
    const ids = (await f.api.state({ sessionID })).workflows.map(({ id }) => id)
    expect(ids).toHaveLength(5)
    expect(ids).toContain(replacement)
    expect(ids).not.toContain(first)
  })
})
