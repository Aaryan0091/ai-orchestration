import type { Plugin } from "@opencode/plugin"
import { desktopReply, DesktopControlError } from "./desktop-controls.ts"
import { SPECIALIST_ROLES } from "./execution.ts"
import type { createWorkflowDrafts } from "./workflow-drafts.ts"
import {
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_ID_MAX_LENGTH,
  WORKFLOW_STEP_ID_PATTERN,
  WORKFLOW_TASK_MAX_LENGTH,
  WORKFLOW_TITLE_MAX_LENGTH,
} from "./workflow-plan.ts"

type Drafts = ReturnType<typeof createWorkflowDrafts>
const id = {
  type: "string",
  minLength: 1,
  maxLength: WORKFLOW_STEP_ID_MAX_LENGTH,
  pattern: WORKFLOW_STEP_ID_PATTERN,
} as const

/** Same direct native exposure as desktop-tools.ts; no model-callable state mutation beyond drafting.
 * OpenCode Server Tools: https://opencode.ai/docs/build/plugins/server#tools
 */
export function registerWorkflowTool(context: Pick<Plugin.Context, "tool">, drafts: Drafts) {
  return context.tool.transform((editor) => {
    editor.add({
      name: "orchestration_prepare_workflow",
      options: { codemode: false },
      description:
        "Draft a preview-only multi-step workflow in the user's OpenCode Desktop Orchestration panel. Supply a short title and numbered or named steps with a task, specialist and dependency IDs (empty when independent). Model choices use the saved project tiers; report blockers without substituting a model. Drafting does not start or approve anything, write settings, or collect files or chat history. For revisions prepare a new draft; the user can discard the old draft. Do not create runnable handoffs for a planning-only request.",
      input: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: WORKFLOW_TITLE_MAX_LENGTH },
          steps: {
            type: "array",
            minItems: 1,
            maxItems: WORKFLOW_MAX_STEPS,
            items: {
              type: "object",
              properties: {
                id,
                task: { type: "string", minLength: 1, maxLength: WORKFLOW_TASK_MAX_LENGTH },
                agent: { enum: SPECIALIST_ROLES },
                dependsOn: { type: "array", maxItems: WORKFLOW_MAX_STEPS - 1, items: id },
                difficulty: { enum: ["auto", "easy", "medium", "hard"] },
              },
              required: ["id", "task", "agent", "dependsOn"],
              additionalProperties: false,
            },
          },
        },
        required: ["title", "steps"],
        additionalProperties: false,
      },
      execute: async (input, call) => {
        const reply = await desktopReply(async () => {
          if (call.agent !== "orchestrator")
            throw new DesktopControlError("Only the orchestrator may prepare workflow drafts.")
          call.signal.throwIfAborted()
          return drafts.prepare(call.sessionID, input, call.signal)
        })
        return { content: JSON.stringify(reply) }
      },
    })
  })
}
