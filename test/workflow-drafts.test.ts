import { expect, test } from "bun:test"
import { createWorkflowDrafts } from "../src/workflow-drafts.ts"
import { WORKFLOW_DRAFTS_PER_CHAT } from "../src/workflow-rpc.ts"

const directory = "/project"
const origin = { sessionID: "origin" }
const request = () => ({
  title: "Workflow draft",
  steps: [{ id: "inspect", task: "Inspect project", agent: "explorer", dependsOn: [] }],
})

function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, promise }
}

test("draft inputs, result views and read snapshots cannot mutate the stored draft", async () => {
  const pause = gate()
  const drafts = createWorkflowDrafts({
    directory,
    session: async () => {
      await pause.promise
      return { location: { directory } }
    },
    createResolver: () => async () => ({ difficulty: "easy", tier: "small", model: "test/model" }),
    changed: async () => {},
  })
  const input = request()
  const preparing = drafts.prepare(origin.sessionID, input)
  input.steps[0]!.task = "replaced while awaiting session"
  pause.open()
  const draft = await preparing
  draft.steps[0]!.task = "replaced through response"
  const snapshot = await drafts.state(origin)
  expect(snapshot.drafts[0]?.steps[0]?.task).toBe("Inspect project")
  snapshot.drafts[0]!.steps[0]!.task = "replaced through state"
  expect((await drafts.state(origin)).drafts[0]?.steps[0]?.task).toBe("Inspect project")
  drafts.dispose()
  await expect(drafts.state(origin)).rejects.toThrow("cleared on restart")
})

test("workflow drafts expire, and failed notifications do not roll back or repeat actions", async () => {
  let time = 1
  let notifications = 0
  const drafts = createWorkflowDrafts({
    directory,
    session: async () => ({ location: { directory } }),
    createResolver: () => async () => ({ difficulty: "easy", tier: "small", model: "test/model" }),
    changed: async () => {
      notifications++
      throw new Error("lost notification")
    },
    now: () => time,
  })
  const first = await drafts.prepare(origin.sessionID, request())
  expect((await drafts.state(origin)).drafts).toEqual([first])
  time = first.expiresAt
  expect((await drafts.state(origin)).drafts).toEqual([])
  await expect(drafts.discard({ ...origin, draftID: first.id })).rejects.toThrow("not available")
  const second = await drafts.prepare(origin.sessionID, request())
  expect(await drafts.discard({ ...origin, draftID: second.id })).toEqual({ id: second.id })
  expect((await drafts.state(origin)).drafts).toEqual([])
  expect(notifications).toBe(3)
})

test("draft capacity includes parallel preparations, and moved chats cannot publish them", async () => {
  const inFlight = gate()
  const release = gate()
  let location = directory
  let resolving = 0
  let changed = 0
  const drafts = createWorkflowDrafts({
    directory,
    session: async () => ({ location: { directory: location } }),
    createResolver: () => async () => {
      if (++resolving === WORKFLOW_DRAFTS_PER_CHAT) inFlight.open()
      await release.promise
      return { difficulty: "easy", tier: "small", model: "test/model" }
    },
    changed: async () => {
      changed++
    },
  })
  const pending = Promise.allSettled(
    Array.from({ length: WORKFLOW_DRAFTS_PER_CHAT }, () =>
      drafts.prepare(origin.sessionID, request()),
    ),
  )
  await inFlight.promise
  await expect(drafts.prepare(origin.sessionID, request())).rejects.toThrow(
    "Too many workflow drafts",
  )
  location = "/moved"
  release.open()
  const results = await pending
  expect(results.map((result) => result.status)).toEqual(
    Array(WORKFLOW_DRAFTS_PER_CHAT).fill("rejected"),
  )
  location = directory
  expect((await drafts.state(origin)).drafts).toEqual([])
  expect(changed).toBe(0)
  await drafts.prepare(origin.sessionID, request())
  expect((await drafts.state(origin)).drafts).toHaveLength(1)
})
