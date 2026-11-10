import { expect, test } from "bun:test"
import { createLatestRead, type DesktopScope } from "../src/gui-controller.ts"
import { createWorkflowActions, matchesWorkflowEvent } from "../src/gui-workflow-controller.ts"
import type { WorkflowDraft } from "../src/workflow-rpc.ts"

const scope: DesktopScope = { serverID: "local", sessionID: "chat-a", directory: "/project-a" }
const draft: WorkflowDraft = {
  id: "workflow-123",
  sessionID: scope.sessionID,
  directory: scope.directory,
  title: "Review a change",
  createdAt: 1,
  expiresAt: 2,
  steps: [
    {
      id: "review",
      task: "Review changes",
      agent: "reviewer",
      dependsOn: [],
      difficulty: "easy",
      tier: "small",
      blocker: "Select a small model first.",
    },
  ],
}
const snapshot = { sessionID: scope.sessionID, directory: scope.directory, drafts: [draft] }

test("workflow panel only accepts state and change events from its originating project chat", async () => {
  for (const unexpected of [
    { ...snapshot, sessionID: "chat-b" },
    { ...snapshot, directory: "/project-b" },
    { ...snapshot, drafts: [{ ...draft, sessionID: "chat-b" }] },
    { ...snapshot, drafts: [{ ...draft, directory: "/project-b" }] },
    { ...snapshot, drafts: null },
  ]) {
    const actions = createWorkflowActions(
      scope,
      () => true,
      async () => unexpected,
    )
    await expect(actions.state()).rejects.toThrow("do not belong to this chat/project")
  }
  const event = { data: { sessionID: scope.sessionID }, location: { directory: scope.directory } }
  expect(matchesWorkflowEvent(scope, event)).toBe(true)
  expect(matchesWorkflowEvent(scope, { ...event, data: { sessionID: "chat-b" } })).toBe(false)
  expect(matchesWorkflowEvent(scope, { ...event, location: { directory: "/project-b" } })).toBe(
    false,
  )
  expect(matchesWorkflowEvent(scope, { data: event.data })).toBe(false)
})

test("a superseded refresh cannot restore a discarded draft", async () => {
  const pending: ((value: unknown) => void)[] = []
  const beginRead = createLatestRead()
  const actions = createWorkflowActions(
    scope,
    () => true,
    (request) =>
      request.method === "discard"
        ? Promise.resolve({ id: request.draftID })
        : new Promise((resolve) => pending.push(resolve)),
  )
  let visible = [draft]
  async function refresh() {
    const latest = beginRead()
    const drafts = await actions.state()
    if (latest()) visible = drafts
  }
  const staleRead = refresh()
  await actions.discard(draft)
  beginRead()
  visible = []
  const nextRead = refresh()
  pending[1]!({ ...snapshot, drafts: [] })
  await nextRead
  pending[0]!(snapshot)
  await staleRead
  expect(visible).toEqual([])
})

test("late responses from a disposed client cannot update a reconnected chat", async () => {
  let live = true
  let resolve!: (value: unknown) => void
  const sent: unknown[] = []
  const actions = createWorkflowActions(
    scope,
    () => live,
    async (request) => {
      sent.push(request)
      return new Promise((next) => {
        resolve = next
      })
    },
  )
  const read = actions.state()
  live = false
  resolve(snapshot)
  await expect(read).rejects.toThrow("active chat or server changed")
  await expect(actions.discard(draft)).rejects.toThrow("active chat or server changed")
  expect(sent).toEqual([{ method: "state", sessionID: scope.sessionID }])
})

test("review is local and discard sends only the exact scoped draft ID", async () => {
  const sent: unknown[] = []
  let response = { id: draft.id }
  const actions = createWorkflowActions(
    scope,
    () => true,
    async (request) => {
      sent.push(request)
      return request.method === "state" ? snapshot : response
    },
  )
  expect(Object.keys(actions).sort()).toEqual(["discard", "state"])
  expect(await actions.state()).toEqual([draft])
  await expect(actions.discard({ ...draft, sessionID: "chat-b" })).rejects.toThrow(
    "active chat or server changed",
  )
  expect(sent).toHaveLength(1)
  await actions.discard(draft)
  expect(sent[1]).toEqual({ method: "discard", sessionID: scope.sessionID, draftID: draft.id })
  response = { id: "wrong-draft" }
  await expect(actions.discard(draft)).rejects.toThrow("discard response was unclear")
})
