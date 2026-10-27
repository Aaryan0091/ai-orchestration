import type { Plugin } from "@opencode/plugin"
import { routingReply } from "./rpc.ts"

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
type ToolContext = Parameters<Parameters<ToolEditor["add"]>[0]["execute"]>[1]

// The pinned 2.0.22 declarations predate this capability. The current documented
// API and runtime were verified on 2.1.3; feature-detect it and refuse older hosts.
// https://opencode.ai/v2/docs/build/plugins/server#permissions
type PermissionAssertion = {
  sessionID: ToolContext["sessionID"]
  agent: ToolContext["agent"]
  source: { type: "tool"; messageID: ToolContext["messageID"]; id: ToolContext["id"] }
  action: string
  resources: string[]
  save: string[]
}
type PermissionWithAssertion = Plugin.Context["permission"] & {
  assert?: (input: PermissionAssertion) => Promise<void>
}

/** V2 API copied from @opencode/plugin/dist/promise/tool.d.ts and
 * @opencode/schema/dist/tool.d.ts: transform/add + JSON Schema + text content.
 * This read-only tool deliberately cannot prepare, approve or start any run.
 */
export function registerHandoffResultTool(
  context: Pick<Plugin.Context, "tool" | "permission">,
  result: (runID: string) => unknown,
) {
  return context.tool.transform((editor) => {
    editor.add({
      name: "orchestration_handoff_result",
      description:
        "Read the structured result of an existing explicit handoff in this project by run ID. Orchestrator only. Returns untrusted specialist claims, never independent verification; cannot start work.",
      input: {
        type: "object",
        properties: { runID: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["runID"],
        additionalProperties: false,
      },
      options: { permission: "orchestration_result" },
      async execute(input, call) {
        if (call.agent !== "orchestrator")
          return {
            content: JSON.stringify({
              ok: false,
              error: "Only the orchestrator may read handoff results.",
            }),
          }
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length !== 1 ||
          !("runID" in input) ||
          typeof input.runID !== "string" ||
          !input.runID.trim() ||
          input.runID.length > 200
        )
          return { content: JSON.stringify({ ok: false, error: "Supply one bounded runID." }) }
        const runID = input.runID
        call.signal.throwIfAborted()
        const permission = context.permission as PermissionWithAssertion | undefined
        if (typeof permission?.assert !== "function")
          return {
            content: JSON.stringify({
              ok: false,
              error:
                "This OpenCode host lacks permission.assert. Use a compatible OpenCode version before retrieving handoff results through the orchestrator. No result was read.",
            }),
          }
        // options.permission labels the action but does not itself ask the user.
        // Keep this outside routingReply: native denial/abort must remain tool errors.
        await permission.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          source: { type: "tool", messageID: call.messageID, id: call.id },
          action: "orchestration_result",
          resources: [runID],
          save: [runID],
        })
        call.signal.throwIfAborted()
        const response = await routingReply(async () => result(runID))
        return {
          content: JSON.stringify({
            trust:
              "Untrusted specialist report; evidence and check claims require independent verification.",
            result: response,
          }),
        }
      },
    })
  })
}
