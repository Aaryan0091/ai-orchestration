import type { Plugin } from "@opencode/plugin"
import type { ExecutionHost, ExecutionModel, ExecutionOutcome } from "./execution.ts"
import { StopUnconfirmedError } from "./execution.ts"
import type { RoutingConfig } from "./routing.ts"

/** Official V2 session APIs: https://opencode.ai/v2/docs/build/plugins/ */
export function createSessionAdapter(
  context: Plugin.Context,
  readConfig: () => Promise<RoutingConfig>,
): ExecutionHost & { initialize(): Promise<void>; dispose(): Promise<void> } {
  const location = { directory: context.location.directory }
  const knownCreated = new Set<string>()
  const owned = new Set<string>()
  let registration: Promise<{ dispose(): Promise<void> }> | undefined
  function initialize() {
    // OpenCode also retries provider requests inside a single session. Those hidden
    // retries would bypass the routing plan's approved maximum attempts. Disable
    // them only while this adapter owns the child; never alter the user's chat.
    registration ??= context.session.hook("retry", (input) => {
      if (owned.has(input.sessionID)) input.decision = { retry: false }
    })
    return registration.then(() => undefined)
  }
  return {
    initialize,
    async dispose() {
      if (registration) await (await registration).dispose()
    },
    readConfig,
    async listModels(): Promise<ExecutionModel[]> {
      const inventory = await context.model.list(
        { location },
        { signal: AbortSignal.timeout(10_000) },
      )
      return inventory.data.map((model) => ({
        ...model,
        capabilities: [
          ...(model.capabilities.output.includes("text") ? ["text" as const] : []),
          ...(model.capabilities.tools ? ["tools" as const] : []),
          ...(model.capabilities.input.includes("image") ? ["imageInput" as const] : []),
          ...(model.capabilities.output.includes("image") ? ["imageOutput" as const] : []),
        ],
      }))
    },
    async createSession({ agent, model, signal }) {
      await initialize()
      const agents = await context.agent.list({ location }, { signal })
      if (!agents.data.some((entry) => entry.id === agent))
        throw new Error(`Agent ${agent} is not installed in this project.`)
      signal.throwIfAborted()
      // Do not couple create's response to user cancellation: the engine must receive
      // the created ID before interrupting it. Creation itself never prompts a model.
      const session = await context.session.create(
        { agent, model, location, title: `Orchestration: ${agent}` },
        { signal: AbortSignal.timeout(10_000) },
      )
      knownCreated.add(session.id)
      owned.add(session.id)
      return session.id
    },
    async executeSession({ sessionID, task, signal }): Promise<ExecutionOutcome> {
      // prompt queues the task. Completion is proven separately with wait + outcome.
      try {
        // Removing before POST is deliberate: transport failure is not proof no prompt ran.
        knownCreated.delete(sessionID)
        await context.session.prompt({ sessionID, text: task, resume: true }, { signal })
        await context.session.wait({ sessionID }, { signal })
      } catch (error) {
        // Aborting an HTTP wait does not stop OpenCode's background execution.
        try {
          await context.session.interrupt(
            { sessionID, resume: false },
            { signal: AbortSignal.timeout(10_000) },
          )
          await context.session.wait({ sessionID }, { signal: AbortSignal.timeout(10_000) })
          const stopped = await context.session.get(
            { sessionID },
            { signal: AbortSignal.timeout(10_000) },
          )
          if (!stopped.outcome) throw new Error("Idle outcome not confirmed.")
          owned.delete(sessionID)
        } catch {
          throw new StopUnconfirmedError(sessionID)
        }
        throw error
      }
      const session = await context.session.get({ sessionID }, { signal })
      // A missing terminal outcome is not proof of failure or safe replay.
      if (!session.outcome) throw new StopUnconfirmedError(sessionID)
      owned.delete(sessionID)
      const messages = await context.session.context({ sessionID }, { signal })
      const assistants = messages.filter((message) => message.type === "assistant")
      const text = assistants
        .flatMap((message) =>
          message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
        )
        .join("\n")
      const error = [...assistants].reverse().find((message) => message.error)?.error
      const tools = assistants.some((message) =>
        message.content.some((part) => part.type === "tool"),
      )
      const compacted = messages.some((message) => message.type === "compaction")
      const output = assistants.some((message) =>
        message.content.some((part) => part.type !== "text" || part.text.length > 0),
      )
      const last = assistants[assistants.length - 1]
      if (session.outcome === "succeeded" && !error && last?.finish === "stop")
        return { ok: true, text }
      if (session.outcome === "interrupted")
        return { ok: false, text: "Session interrupted.", failure: "cancelled" }
      const message =
        error?.message ??
        `Session ended with ${session.outcome ?? "unknown"} outcome; finish ${last?.finish ?? "unknown"}.`
      const failure =
        error?.status === 401 || error?.status === 403
          ? "credentials"
          : error &&
              /permission|denied|free tier|custom agent|only be used from within|entitlement/i.test(
                message,
              )
            ? "permission"
            : error || last?.finish === "length"
              ? "model"
              : "unknown"
      // Context can be compacted. Only an explicit pre-generation provider failure
      // without output/tools is replayable; absence of tools alone is not proof.
      return {
        ok: false,
        text: message,
        failure,
        safeToRetry: session.outcome === "failed" && !!error && !tools && !output && !compacted,
      }
    },
    async cancelSession(sessionID) {
      await context.session.interrupt(
        { sessionID, resume: false },
        { signal: AbortSignal.timeout(10_000) },
      )
      await context.session.wait({ sessionID }, { signal: AbortSignal.timeout(10_000) })
      const session = await context.session.get(
        { sessionID },
        { signal: AbortSignal.timeout(10_000) },
      )
      if (!session.outcome) {
        const fresh = knownCreated.has(sessionID)
        const messages = fresh
          ? await context.session.context({ sessionID }, { signal: AbortSignal.timeout(10_000) })
          : []
        if (
          !fresh ||
          messages.some((message) => message.type === "user" || message.type === "assistant")
        )
          throw new StopUnconfirmedError(sessionID)
      }
      knownCreated.delete(sessionID)
      owned.delete(sessionID)
    },
  }
}
