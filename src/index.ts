import { Plugin } from "@opencode/plugin"

import { AGENT_IDS, parseOptions, type PluginSnapshot } from "./shared/types.ts"

export default Plugin.define({
  id: "ai-orchestration.server",
  async setup(context) {
    const options = parseOptions(context.options)
    const snapshot: PluginSnapshot = {
      agents: AGENT_IDS,
      mode: options.mode,
      version: 1,
    }

    await context.storage.set("foundation", {
      agents: [...snapshot.agents],
      mode: snapshot.mode,
      version: snapshot.version,
    })
  },
})
