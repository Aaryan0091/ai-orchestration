import { expect, test } from "bun:test"
import {
  type GuidedRequest,
  createGuidedActions,
  createGuidedDecision,
  draftCanRun,
  guidedStepCanStop,
} from "../src/gui-guided-controller.ts"
import type { GuidedReview, GuidedStep, GuidedWorkflow } from "../src/guided-rpc.ts"
import type { WorkflowDraft } from "../src/workflow-rpc.ts"

const scope = { serverID: "remote", sessionID: "chat", directory: "/project" }
const first: GuidedStep = {
  id: "inspect",
  task: "Inspect login",
  agent: "explorer",
  dependsOn: [],
  difficulty: "easy",
  tier: "small",
  model: "fixture/small",
  state: "completed",
}
const step: GuidedStep = {
  ...first,
  id: "review",
  task: "Review findings",
  agent: "reviewer",
  dependsOn: [first.id],
  state: "ready",
}
const workflow: GuidedWorkflow = {
  id: "workflow",
  draftID: "draft",
  title: "Login review",
  sessionID: scope.sessionID,
  directory: scope.directory,
  state: "ready",
  steps: [first, step],
}
const review: GuidedReview = {
  id: "review-ticket",
  workflowID: workflow.id,
  stepID: step.id,
  sessionID: scope.sessionID,
  directory: scope.directory,
  expiresAt: 100,
  task: step.task,
  agent: step.agent,
  model: step.model!,
  previousResults: [],
}
const draft: WorkflowDraft = {
  id: workflow.draftID,
  title: workflow.title,
  sessionID: scope.sessionID,
  directory: scope.directory,
  createdAt: 1,
  expiresAt: 100,
  steps: [first, step],
}

test("guided setup cannot be requested for a blocked or foreign draft", async () => {
  const calls: GuidedRequest[] = []
  const actions = createGuidedActions(
    scope,
    () => true,
    async (input) => {
      calls.push(input)
      return { id: workflow.id }
    },
  )
  const blocked = { ...draft, steps: [{ ...step, blocker: "Select a compatible model." }] }
  expect(draftCanRun(blocked)).toBe(false)
  await expect(actions.begin(blocked)).rejects.toThrow("compatible model tiers")
  await expect(actions.begin({ ...draft, sessionID: "another-chat" })).rejects.toThrow(
    "active chat or server changed",
  )
  expect(calls).toEqual([])
  expect(await actions.begin(draft)).toBe(workflow.id)
  expect(calls).toEqual([{ method: "begin", sessionID: scope.sessionID, draftID: draft.id }])
})

test("review validates exact ready step, model, and opt-in dependency data", async () => {
  let reply = review
  const calls: GuidedRequest[] = []
  const actions = createGuidedActions(
    scope,
    () => true,
    async (input) => {
      calls.push(input)
      return reply
    },
  )
  await expect(actions.review(workflow, { ...step, state: "waiting" }, false)).rejects.toThrow(
    "not ready",
  )
  expect(calls).toEqual([])
  const reviewed = await actions.review(workflow, step, false)
  expect(reviewed).toEqual(review)
  expect(reviewed).not.toBe(review)
  expect(calls).toEqual([
    {
      method: "review",
      sessionID: scope.sessionID,
      workflowID: workflow.id,
      stepID: step.id,
      includeDependencySummaries: false,
    },
  ])
  reply = { ...review, model: "fixture/different" }
  await expect(actions.review(workflow, step, false)).rejects.toThrow("Nothing was approved")
  const previous = { stepID: first.id, runID: "prior-run", summary: "Unverified output" }
  reply = { ...review, previousResults: [previous] }
  await expect(actions.review(workflow, step, false)).rejects.toThrow("Nothing was approved")
  expect((await actions.review(workflow, step, true)).previousResults).toEqual([previous])
  expect(calls.at(-1)).toMatchObject({ includeDependencySummaries: true })
  reply = { ...review, previousResults: [{ ...previous, stepID: "unrelated" }] }
  await expect(actions.review(workflow, step, true)).rejects.toThrow("Nothing was approved")
})

test("reads and mutations reject stale clients and cross-chat replies", async () => {
  let active = true
  const foreign = { ...workflow, sessionID: "another-chat" }
  const mismatched = createGuidedActions(
    scope,
    () => active,
    async () => ({
      sessionID: scope.sessionID,
      directory: scope.directory,
      workflows: [foreign],
    }),
  )
  await expect(mismatched.state()).rejects.toThrow("do not belong to this chat/project")
  let calls = 0
  const stale = createGuidedActions(
    scope,
    () => active,
    async () => {
      calls++
      active = false
      return { id: workflow.id }
    },
  )
  await expect(stale.approve(review)).rejects.toThrow("active chat or server changed")
  await expect(stale.approve(review)).rejects.toThrow("active chat or server changed")
  expect(calls).toBe(1)
})

test("a failed or in-flight approval is never retried or dismissed", async () => {
  let approvals = 0
  let dismissals = 0
  let reject!: (error: Error) => void
  const decision = createGuidedDecision({
    approve() {
      approvals++
      return new Promise((_, fail) => {
        reject = fail
      })
    },
    async dismiss() {
      dismissals++
    },
  })
  const started = decision.approve()
  expect(await decision.approve()).toBeUndefined()
  await decision.dismiss()
  reject(new Error("Connection lost"))
  await expect(started).rejects.toThrow("Connection lost")
  expect(await decision.approve()).toBeUndefined()
  await decision.dismiss()
  expect(approvals).toBe(1)
  expect(dismissals).toBe(0)
})

test("closing an unapproved review only dismisses once; cancellation targets the running step", async () => {
  const calls: GuidedRequest[] = []
  const actions = createGuidedActions(
    scope,
    () => true,
    async (input) => {
      calls.push(input)
      return { id: input.method === "dismiss" ? review.id : workflow.id }
    },
  )
  const decision = createGuidedDecision({
    approve: () => actions.approve(review),
    dismiss: () => actions.dismiss(review),
  })
  await decision.dismiss()
  await decision.dismiss()
  expect(await decision.approve()).toBeUndefined()
  await expect(actions.cancel(workflow, step)).rejects.toThrow("no longer active")
  await actions.cancel(workflow, { ...step, state: "running" })
  expect(calls).toEqual([
    { method: "dismiss", sessionID: scope.sessionID, reviewID: review.id },
    { method: "cancel", sessionID: scope.sessionID, workflowID: workflow.id, stepID: step.id },
  ])
})

test("a starting step can be cancelled and an unconfirmed stop can be explicitly retried", async () => {
  const calls: GuidedRequest[] = []
  const actions = createGuidedActions(
    scope,
    () => true,
    async (input) => {
      calls.push(input)
      return { id: workflow.id }
    },
  )
  const starting = { ...step, state: "starting" as const }
  const stopping = { ...step, state: "stopping" as const }
  expect(guidedStepCanStop(starting)).toBe(true)
  expect(guidedStepCanStop(stopping)).toBe(true)
  expect(guidedStepCanStop(first)).toBe(false)
  expect(calls).toEqual([])
  const request: GuidedRequest = {
    method: "cancel",
    sessionID: scope.sessionID,
    workflowID: workflow.id,
    stepID: step.id,
  }
  await actions.cancel(workflow, starting)
  expect(calls).toEqual([request])
  await actions.cancel(workflow, stopping)
  expect(calls).toEqual([request, request])
  await expect(actions.cancel(workflow, first)).rejects.toThrow("no longer active")
  expect(calls).toHaveLength(2)
})
