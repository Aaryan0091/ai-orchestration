import { Plugin } from "@opencode/plugin"
import { createRoutingCommands } from "./routing.ts"
import { routingReply, routingRpc } from "./rpc.ts"
import { createExecutionEngine } from "./execution.ts"
import { createExecutionCommands } from "./execution-commands.ts"
import { createSessionAdapter } from "./session-adapter.ts"
import { registerHandoffResultTool } from "./handoff-tool.ts"
import { createDesktopControls, desktopReply } from "./desktop-controls.ts"
import { desktopRpc } from "./desktop-rpc.ts"
import { registerDesktopTools } from "./desktop-tools.ts"
import { createWorkflowDrafts } from "./workflow-drafts.ts"
import { workflowRpc } from "./workflow-rpc.ts"
import { registerWorkflowTool } from "./workflow-tool.ts"

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
    type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]
    type ScopedRegistration = {
      dispose(): Promise<void>
      events: { emit(name: "changed", data: { sessionID: string }): Promise<void> }
    }
    const session = (sessionID: string) =>
      context.session.get({ sessionID: sessionID as SessionID })
    let desktopRegistration: ScopedRegistration | undefined
    let workflowRegistration: ScopedRegistration | undefined
    const desktop = createDesktopControls({
      directory: context.location.directory,
      session,
      routing: commands,
      execution,
      engine,
      listModels: async () =>
        (await context.model.list({ location: { directory: context.location.directory } })).data,
      changed: async (sessionID) => {
        await desktopRegistration?.events.emit("changed", { sessionID })
      },
    })
    const workflow = createWorkflowDrafts({
      directory: context.location.directory,
      session,
      createResolver: engine.createWorkflowRoutingResolver,
      changed: async (sessionID) => {
        await workflowRegistration?.events.emit("changed", { sessionID })
      },
    })
    let toolRegistration: Awaited<ReturnType<typeof registerHandoffResultTool>> | undefined
    let desktopTools: Awaited<ReturnType<typeof registerDesktopTools>> | undefined
    let workflowTool: Awaited<ReturnType<typeof registerWorkflowTool>> | undefined
    let routingRegistration: { dispose(): Promise<void> } | undefined
    async function dispose() {
      let failure: unknown
      workflow.dispose()
      for (const registration of [
        routingRegistration,
        workflowRegistration,
        desktopRegistration,
        workflowTool,
        desktopTools,
        toolRegistration,
      ]) {
        try {
          await registration?.dispose()
        } catch (error) {
          failure ??= error
        }
      }
      try {
        await desktop.dispose()
      } catch (error) {
        failure ??= error
      }
      try {
        await adapter.dispose()
      } catch (error) {
        failure ??= error
      }
      if (failure) throw failure
    }
    try {
      toolRegistration = await registerHandoffResultTool(context, engine.handoffResult)
      desktopTools = await registerDesktopTools(context, desktop)
      workflowTool = await registerWorkflowTool(context, workflow)
      desktopRegistration = await context.rpc.register(desktopRpc, {
        state: (input, call) => desktopReply(() => desktop.state(input, call.signal)),
        review: (input, call) => desktopReply(() => desktop.review(input, call.signal)),
        approve: (input, call) => desktopReply(() => desktop.approve(input, call.signal)),
        discard: (input, call) => desktopReply(() => desktop.discard(input, call.signal)),
        models: (input, call) => desktopReply(() => desktop.models(input, call.signal)),
        proposeModel: (input, call) => desktopReply(() => desktop.proposeModel(input, call.signal)),
        proposeCancel: (input, call) =>
          desktopReply(() => desktop.proposeCancel(input, call.signal)),
        run: (input, call) => desktopReply(() => desktop.run(input, call.signal)),
      })
      workflowRegistration = await context.rpc.register(workflowRpc, {
        state: (input, call) => desktopReply(() => workflow.state(input, call.signal)),
        discard: (input, call) => desktopReply(() => workflow.discard(input, call.signal)),
      })
      const registration = await context.rpc.register(routingRpc, {
        models: async (input, call) =>
          routingReply(() => commands.models(typeof input === "string" ? input : "", call.signal)),
        route: async (input) =>
          routingReply(() => execution.preview(typeof input === "string" ? input : "")),
        prepare: async (input) =>
          routingReply(() => execution.prepare(typeof input === "string" ? input : "")),
        handoff: async (input) =>
          routingReply(async () => {
            const match =
              typeof input === "string" ? /^(preview|run)\s+([\s\S]+)$/.exec(input.trim()) : null
            if (!match)
              throw new Error(
                "Usage: preview JSON | run JSON; paste the complete handoff request object.",
              )
            return match[1] === "run"
              ? execution.prepareHandoff(match[2]!)
              : execution.previewHandoff(match[2]!)
          }),
        start: async (input) =>
          routingReply(() => execution.start(typeof input === "string" ? input : "")),
        discard: async (input) =>
          routingReply(() => execution.discard(typeof input === "string" ? input : "")),
        run: async (input) =>
          routingReply(() => execution.runCommand(typeof input === "string" ? input : "")),
        policy: async (input) =>
          routingReply(() => execution.policy(typeof input === "string" ? input : "")),
      })
      routingRegistration = registration
      return dispose
    } catch (error) {
      await dispose()
      throw error
    }
  },
})
