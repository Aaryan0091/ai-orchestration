import { Plugin } from "@opencode/plugin/tui"

import { parseOptions } from "./shared/types.ts"

export default Plugin.define({
  id: "ai-orchestration.tui",
  setup(context) {
    const options = parseOptions(context.options)

    if (options.notifyOnLoad) {
      context.ui.toast.show({
        message: `AI Orchestration ready (${options.mode} mode)`,
        variant: "success",
      })
    }
  },
})
