import type { Plugin } from "@opencode/plugin"
import {
  desktopReply,
  DesktopControlError,
  type createDesktopControls,
} from "./desktop-controls.ts"

type Controls = ReturnType<typeof createDesktopControls>
type Editor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
type Call = Parameters<Parameters<Editor["add"]>[0]["execute"]>[1]

/** Chat proposes; only the native GUI has approve/discard RPC controls.
 * Never add start/approve/settings-write/cancel execution tools here.
 * Tools API: https://opencode.ai/v2/docs/build/plugins/server#tools
 */
export function registerDesktopTools(context: Pick<Plugin.Context, "tool">, controls: Controls) {
  return context.tool.transform((editor) => {
    async function execute(call: Call, operation: () => Promise<unknown>) {
      const reply = await desktopReply(async () => {
        if (call.agent !== "orchestrator")
          throw new DesktopControlError(
            "Only the orchestrator may propose desktop requests or read their status.",
          )
        call.signal.throwIfAborted()
        return operation()
      })
      return { content: JSON.stringify(reply) }
    }
    const empty = { type: "object", properties: {}, additionalProperties: false } as const
    editor.add({
      name: "orchestration_prepare_handoff",
      description:
        "Propose one specialist task from normal chat. Supply a bounded handoff with objective, explicit context and acceptance checks. Returns a frozen preview for the user's native Desktop review panel; does not start an agent or approve spending. Tell the user to review it in Orchestration controls. No automatic file/history collection.",
      input: {
        type: "object",
        properties: {
          agent: {
            enum: [
              "explorer",
              "planner",
              "builder",
              "debugger",
              "reviewer",
              "verifier",
              "visualizer",
            ],
          },
          difficulty: { enum: ["auto", "easy", "medium", "hard"] },
          model: { type: "string", maxLength: 1000 },
          handoff: { type: "object" },
        },
        required: ["agent", "handoff"],
        additionalProperties: false,
      },
      execute: async (input, call) =>
        execute(call, () => controls.prepareHandoff(call.sessionID, input, call.signal)),
    })
    editor.add({
      name: "orchestration_prepare_model_change",
      description:
        "Propose changing one saved project model tier. Use an exact connected provider/model#variant ID or null to clear the tier. Desktop user approval is required; proposing saves nothing, starts no work and never changes the current chat model.",
      input: {
        type: "object",
        properties: {
          slot: { enum: ["small", "mid", "big", "orchestrator"] },
          selection: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
        },
        required: ["slot", "selection"],
        additionalProperties: false,
      },
      execute: async (input, call) =>
        execute(call, async () => {
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => !["slot", "selection"].includes(key))
          )
            throw new DesktopControlError(
              "Supply only slot and selection for a model-change proposal.",
            )
          return controls.proposeModel(
            { ...structuredClone(input), sessionID: call.sessionID },
            call.signal,
          )
        }),
    })
    editor.add({
      name: "orchestration_prepare_cancel",
      description:
        "Propose cancelling an existing specialist run belonging to this chat. The Desktop user must approve the cancellation. This tool does not interrupt or restart anything itself.",
      input: {
        type: "object",
        properties: { runID: { type: "string", minLength: 1, maxLength: 200 } },
        required: ["runID"],
        additionalProperties: false,
      },
      execute: async (input, call) =>
        execute(call, async () => {
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).length !== 1 ||
            !("runID" in input)
          )
            throw new DesktopControlError(
              "Supply only the existing run ID for a cancellation proposal.",
            )
          return controls.proposeCancel(
            { runID: input.runID, sessionID: call.sessionID },
            call.signal,
          )
        }),
    })
    editor.add({
      name: "orchestration_desktop_status",
      description:
        "Read pending proposals and specialist run status for this chat without generation, approval or settings changes. Completed means a session/report finished, not independent verification. Use orchestration_handoff_result with its native permission check to retrieve a report by returned run ID.",
      input: empty,
      execute: async (input, call) =>
        execute(call, async () => {
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).length
          )
            throw new DesktopControlError(
              "Status takes no arguments; it uses the actual current chat.",
            )
          return controls.state({ sessionID: call.sessionID }, call.signal)
        }),
    })
    editor.add({
      name: "orchestration_project_models",
      description:
        "Read saved project model tiers and search eligible connected model IDs. No provider generation or settings change. Use page/query to inspect bounded results before proposing a model preference.",
      input: {
        type: "object",
        properties: {
          query: { type: "string", maxLength: 100 },
          page: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
      },
      execute: async (input, call) =>
        execute(call, async () => {
          if (
            !input ||
            typeof input !== "object" ||
            Array.isArray(input) ||
            Object.keys(input).some((key) => !["query", "page"].includes(key))
          )
            throw new DesktopControlError("Model search accepts only query and page.")
          return controls.models(
            { ...structuredClone(input), sessionID: call.sessionID },
            call.signal,
          )
        }),
    })
  })
}
