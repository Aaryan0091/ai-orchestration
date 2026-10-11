import { Plugin } from "@opencode/plugin/tui"

import { parseTuiOptions } from "./shared/types.ts"

export default Plugin.define({
  id: "ai-orchestration.tui",
  setup(context) {
    const options = parseTuiOptions(context.options)

    if (options.notifyOnLoad) {
      context.ui.toast.show({
        message: "AI Orchestration ready",
        variant: "success",
      })
    }
  },
})
