import { Plugin } from "@opencode/plugin"
import { createRoutingCommands } from "./routing.ts"
import { routingReply, routingRpc } from "./rpc.ts"
import { createExecutionEngine } from "./execution.ts"
import { createExecutionCommands } from "./execution-commands.ts"
import { createSessionAdapter } from "./session-adapter.ts"

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

    const commands = createRoutingCommands({
      directory: context.location.directory,
      list: async () =>
        (
          await context.model.list(
            { location: { directory: context.location.directory } },
            { signal: AbortSignal.timeout(10_000) },
          )
        ).data,
      read: (key) => context.storage.get(key),
      write: (key, config) =>
        context.storage.set(key, {
          version: config.version,
          selections: Object.fromEntries(
            Object.entries(config.selections).map(([slot, selection]) => [
              slot,
              {
                providerID: selection.providerID,
                id: selection.id,
                ...(selection.variant ? { variant: selection.variant } : {}),
              },
            ]),
          ),
        }),
      remove: (key) => context.storage.remove(key),
    })
    const adapter = createSessionAdapter(context, commands.config)
    await adapter.initialize()
    const engine = createExecutionEngine(adapter)
    const policyKey = `execution-policy/v1/${encodeURIComponent(context.location.directory)}`
    const execution = createExecutionCommands(engine, {
      read: () => context.storage.get(policyKey),
      write: (value) => context.storage.set(policyKey, JSON.parse(JSON.stringify(value))),
    })
    try {
      const registration = await context.rpc.register(routingRpc, {
        models: async (input, call) =>
          routingReply(() => commands.models(typeof input === "string" ? input : "", call.signal)),
        route: async (input) =>
          routingReply(() => execution.preview(typeof input === "string" ? input : "")),
        prepare: async (input) =>
          routingReply(() => execution.prepare(typeof input === "string" ? input : "")),
        start: async (input) =>
          routingReply(() => execution.start(typeof input === "string" ? input : "")),
        discard: async (input) =>
          routingReply(() => execution.discard(typeof input === "string" ? input : "")),
        run: async (input) =>
          routingReply(() => execution.runCommand(typeof input === "string" ? input : "")),
        policy: async (input) =>
          routingReply(() => execution.policy(typeof input === "string" ? input : "")),
      })
      return async () => {
        try {
          await registration.dispose()
        } finally {
          await adapter.dispose()
        }
      }
    } catch (error) {
      await adapter.dispose()
      throw error
    }
  },
})
