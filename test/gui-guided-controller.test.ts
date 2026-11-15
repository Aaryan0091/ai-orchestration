import { expect, test } from "bun:test"
import {
  type GuidedRequest,
  createGuidedActions,
  createGuidedDecision,
  draftCanRun,
  guidedStepCanStop,
} from "../src/gui-guided-controller.ts"
import type { GuidedReview, GuidedStep, GuidedWorkflow } from "../src/guided-rpc.ts"
import type { VerificationSpec } from "../src/verification.ts"
import {
  canRunCommandVerification,
  createGuiCommandActions,
} from "../src/gui-command-verification.ts"
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

test("review freezes caller-selected verification and rejects altered or unsolicited criteria", async () => {
  const criterion = { summaryEquals: " EXACT_MARKER " }
  const reply = { ...review, verification: { ...criterion } }
  const pending = Promise.withResolvers<GuidedReview>()
  const calls: GuidedRequest[] = []
  const actions = createGuidedActions(
    scope,
    () => true,
    async (input) => {
      calls.push(input)
      return pending.promise
    },
  )
  const reviewing = actions.review(workflow, step, false, criterion)
  criterion.summaryEquals = "MUTATED"
  expect(calls[0]).toMatchObject({ verification: { summaryEquals: " EXACT_MARKER " } })
  pending.resolve(reply)
  const result = await reviewing
  expect(result.verification).toEqual({ summaryEquals: " EXACT_MARKER " })
  reply.verification.summaryEquals = "MUTATED_REPLY"
  expect(result.verification).toEqual({ summaryEquals: " EXACT_MARKER " })

  for (const verification of [
    undefined,
    { summaryEquals: "DIFFERENT" },
    { summaryEquals: "EXPECTED", extra: true },
  ]) {
    const changed = createGuidedActions(
      scope,
      () => true,
      async () => ({
        ...review,
        verification,
      }),
    )
    await expect(
      changed.review(workflow, step, false, { summaryEquals: "EXPECTED" }),
    ).rejects.toThrow("Nothing was approved")
  }
  const unsolicited = createGuidedActions(
    scope,
    () => true,
    async () => ({
      ...review,
      verification: { summaryEquals: "AGENT_CHOSEN" },
    }),
  )
  await expect(unsolicited.review(workflow, step, false)).rejects.toThrow("Nothing was approved")
})

test("verification rejects invalid user input before RPC and stale verified replies", async () => {
  let calls = 0
  let active = true
  const verification = { summaryEquals: "EXPECTED" }
  const actions = createGuidedActions(
    scope,
    () => active,
    async () => {
      calls++
      active = false
      return { ...review, verification }
    },
  )
  for (const summaryEquals of ["", " ", "x".repeat(2001), "secret\0value"]) {
    await expect(actions.review(workflow, step, false, { summaryEquals })).rejects.toThrow(
      "Verification must contain only",
    )
  }
  const extra = { summaryEquals: "EXPECTED", unexpected: "not-allowed" } as VerificationSpec
  await expect(actions.review(workflow, step, false, extra)).rejects.toThrow(
    "Verification must contain only",
  )
  expect(calls).toBe(0)
  await expect(actions.review(workflow, step, false, verification)).rejects.toThrow(
    "active chat or server changed",
  )
  expect(calls).toBe(1)
})

test("approval sends only the frozen review ID, never a mutable verification criterion", async () => {
  const calls: GuidedRequest[] = []
  const actions = createGuidedActions(
    scope,
    () => true,
    async (input) => {
      calls.push(input)
      return { id: workflow.id }
    },
  )
  await actions.approve({ ...review, verification: { summaryEquals: "EXPECTED" } })
  expect(calls).toEqual([{ method: "approve", sessionID: scope.sessionID, reviewID: review.id }])
})

test("command criteria must match the exact user-selected frozen review fields", async () => {
  const expected = { command: "bun test", summaryEquals: "CHECKED" }
  let reply: GuidedReview = { ...review, verification: { ...expected } }
  const actions = createGuidedActions(
    scope,
    () => true,
    async () => reply,
  )
  expect((await actions.review(workflow, step, false, expected)).verification).toEqual(expected)
  reply = { ...review, verification: { ...expected, command: "bun run changed" } }
  await expect(actions.review(workflow, step, false, expected)).rejects.toThrow(
    "Nothing was approved",
  )
  reply = { ...review, verification: { summaryEquals: "CHECKED" } }
  await expect(actions.review(workflow, step, false, expected)).rejects.toThrow(
    "Nothing was approved",
  )
  reply = { ...review, verification: { command: "bun test" } }
  await expect(actions.review(workflow, step, false, expected)).rejects.toThrow(
    "Nothing was approved",
  )
  expect(
    (await actions.review(workflow, step, false, { command: "bun test" })).verification,
  ).toEqual({
    command: "bun test",
  })
})

function commandFixture() {
  const completed: GuidedStep = {
    ...step,
    state: "completed",
    verification: { command: "bun test" },
  }
  const owned = { ...workflow, steps: [completed] }
  const ticket = {
    id: "command-ticket",
    sessionID: scope.sessionID,
    directory: scope.directory,
    workflowID: workflow.id,
    stepID: step.id,
    command: "bun test",
    executionCommand: "bun test",
    permissionSessionID: scope.sessionID,
    expiresAt: Date.now() + 60000,
    timeoutMs: 30000,
    metadata: { orchestrationVerification: "command-ticket" },
  }
  const result = {
    id: ticket.id,
    sessionID: scope.sessionID,
    directory: scope.directory,
    workflowID: workflow.id,
    stepID: step.id,
    shellID: "native-shell-id",
    result: {
      source: "native-shell",
      status: "running",
      ticketID: ticket.id,
      command: "bun test",
      diagnostic: "Native event observed.",
    },
  }
  const calls: { method: string; input: unknown }[] = []
  let active = true
  let prepare: () => Promise<unknown> = async () => ticket
  let create: () => Promise<unknown> = async () => ({ data: { id: "native-shell-id" } })
  const actions = createGuiCommandActions(scope, () => active, {
    prepare: async (input) => {
      calls.push({ method: "prepare", input })
      return prepare()
    },
    create: async (input) => {
      calls.push({ method: "create", input })
      return create()
    },
    status: async (input) => {
      calls.push({ method: "status", input })
      return result
    },
    cancel: async (input) => {
      calls.push({ method: "cancel", input })
      return result
    },
    remove: async (input) => {
      calls.push({ method: "remove", input })
      return {}
    },
  })
  return {
    actions,
    completed,
    owned,
    ticket,
    result,
    calls,
    inactive() {
      active = false
    },
    prepareWith(value: () => Promise<unknown>) {
      prepare = value
    },
    createWith(value: () => Promise<unknown>) {
      create = value
    },
  }
}

test("command verification dispatches exact native command once and trusts only bound backend status", async () => {
  const f = commandFixture()
  expect(f.calls).toEqual([])
  await f.actions.run(f.owned, f.completed)
  expect(f.calls.map((call) => call.method)).toEqual(["prepare", "create"])
  expect(f.calls[1]?.input).toEqual({
    location: { directory: scope.directory },
    cwd: scope.directory,
    command: "bun test",
    timeout: 30000,
    metadata: { orchestrationVerification: f.ticket.id },
  })
  await expect(f.actions.run(f.owned, f.completed)).rejects.toThrow("already requested")
  expect((await f.actions.status(f.owned, f.completed))?.shellID).toBe("native-shell-id")
  await f.actions.cancel(f.owned, f.completed)
  expect(f.calls.at(-1)).toEqual({
    method: "remove",
    input: {
      id: "native-shell-id",
      location: { directory: scope.directory },
    },
  })
  await f.actions.cancel(f.owned, f.completed)
  expect(f.calls.filter((call) => call.method === "remove")).toHaveLength(2)
  f.result.sessionID = "foreign-chat"
  await expect(f.actions.status(f.owned, f.completed)).rejects.toThrow("did not match")
})

test("command confirmation dismisses before native permission waits and cannot be repeated", async () => {
  const f = commandFixture()
  const events: string[] = []
  let grant!: (ticket: typeof f.ticket) => void
  f.prepareWith(() => {
    events.push("native-permission")
    return new Promise((resolve) => {
      grant = resolve
    })
  })
  const pending = f.actions.run(f.owned, f.completed, () => events.push("dialog-closed"))
  expect(events).toEqual(["dialog-closed", "native-permission"])
  expect(f.calls.map((call) => call.method)).toEqual(["prepare"])
  await expect(
    f.actions.run(f.owned, f.completed, () => events.push("duplicate-close")),
  ).rejects.toThrow("already requested")
  expect(events).toEqual(["dialog-closed", "native-permission"])
  grant(f.ticket)
  await pending
  expect(f.calls.map((call) => call.method)).toEqual(["prepare", "create"])
})

test("native permission denial remains reportable after dialog dismissal without dispatch or replay", async () => {
  const f = commandFixture()
  let closed = false
  let panelError = ""
  f.prepareWith(async () => {
    expect(closed).toBe(true)
    throw new Error("Native permission denied")
  })
  await f.actions
    .run(f.owned, f.completed, () => (closed = true))
    .catch((cause: Error) => {
      panelError = cause.message
    })
  expect(panelError).toBe("Native permission denied")
  expect(f.calls.map((call) => call.method)).toEqual(["prepare"])
  await expect(f.actions.run(f.owned, f.completed)).rejects.toThrow("already requested")
})

test("a mismatched required summary cannot offer or dispatch a native command", async () => {
  const f = commandFixture()
  f.completed.verification = { command: "bun test", summaryEquals: "EXPECTED" }
  f.completed.summary = "WRONG"
  expect(canRunCommandVerification(f.completed)).toBe(false)
  await expect(f.actions.run(f.owned, f.completed)).rejects.toThrow("summary did not match")
  expect(f.calls).toEqual([])
  f.completed.summary = "EXPECTED"
  expect(canRunCommandVerification(f.completed)).toBe(true)
})

test("command dispatch rejects changed criteria, identity, timeout, and metadata tickets", async () => {
  for (const altered of [
    { command: "rm changed" },
    { executionCommand: "rm changed" },
    { sessionID: "foreign-chat" },
    { permissionSessionID: "hidden-child-chat" },
    { directory: "/foreign" },
    { workflowID: "foreign" },
    { timeoutMs: 0 },
    { metadata: { orchestrationVerification: "forged" } },
    { expiresAt: Date.now() - 1 },
  ]) {
    const f = commandFixture()
    Object.assign(f.ticket, altered)
    await expect(f.actions.run(f.owned, f.completed)).rejects.toThrow("did not match")
    expect(f.calls.map((call) => call.method)).toEqual(["prepare"])
  }
})

test("ambiguous native command dispatch and stale prepare replies never authorize replay", async () => {
  const f = commandFixture()
  f.createWith(async () => {
    throw new Error("Transport lost")
  })
  await expect(f.actions.run(f.owned, f.completed)).rejects.toThrow("Transport lost")
  await expect(f.actions.run(f.owned, f.completed)).rejects.toThrow("already requested")
  expect(f.calls.filter((call) => call.method === "create")).toHaveLength(1)
  const stale = commandFixture()
  stale.prepareWith(async () => {
    stale.inactive()
    return stale.ticket
  })
  await expect(stale.actions.run(stale.owned, stale.completed)).rejects.toThrow(
    "active chat or server changed",
  )
  expect(stale.calls.map((call) => call.method)).toEqual(["prepare"])
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
