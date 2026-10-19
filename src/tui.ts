import { Plugin } from "@opencode/plugin/tui"

import { parseTuiOptions } from "./shared/types.ts"
import { commandArguments, RoutingApplicationError, routingRpc, unwrapRoutingReply } from "./rpc.ts"

export default Plugin.define({
  id: "ai-orchestration.tui",
  setup(context) {
    const options = parseTuiOptions(context.options)

    // https://opencode.ai/v2/docs/build/plugins/cli/ — terminal commands and dialogs.
    // node_modules/@opencode/plugin/dist/tui/context.d.ts: raw slash input; dialog.alert is local.
    context.keymap.layer(() => ({
      commands: (["models", "route", "run", "policy"] as const).map((method) => {
        const name = `orchestration-${method}`
        return {
          id: `ai-orchestration.${method}`,
          title: {
            models: "Configure routing models",
            route: "Preview task routing",
            run: "Run or inspect a routed task",
            policy: "Configure optional routing controls",
          }[method],
          slash: { name, arguments: true as const },
          async run(input?: string) {
            try {
              const route = context.ui.router.current()
              const location =
                route.type === "session"
                  ? context.data.session.get(route.sessionID)?.location
                  : context.location
              if (!location)
                throw new RoutingApplicationError("Open a project before configuring routing.")
              const client = context.client.rpc(routingRpc)
              const args = commandArguments(name, input)
              const requestOptions = {
                location: { directory: location.directory },
                signal: AbortSignal.timeout(15_000),
              }
              let result: unknown
              if (method === "run" && !/^(status|cancel)(\s|$)/.test(args)) {
                const plan = unwrapRoutingReply(await client.prepare(args, requestOptions))
                if (
                  !plan ||
                  typeof plan !== "object" ||
                  !("id" in plan) ||
                  !("message" in plan) ||
                  typeof plan.id !== "string" ||
                  typeof plan.message !== "string"
                )
                  throw new Error("Invalid execution preview.")
                const approved = await context.ui.dialog.confirm({
                  title: "Approve routed task?",
                  message: plan.message,
                  label: { confirm: "Run task", cancel: "Cancel" },
                })
                result =
                  approved === true
                    ? await client.start(plan.id, {
                        ...requestOptions,
                        signal: AbortSignal.timeout(15_000),
                      })
                    : await client.discard(plan.id, {
                        ...requestOptions,
                        signal: AbortSignal.timeout(15_000),
                      })
              } else result = await client[method](args, requestOptions)
              result = unwrapRoutingReply(result)
              if (typeof result !== "string") throw new Error("Invalid routing response.")
              await context.ui.dialog.alert({ title: "AI Orchestration", message: result })
            } catch (error) {
              await context.ui.dialog.alert({
                title:
                  error instanceof RoutingApplicationError
                    ? "Routing error"
                    : "Routing unavailable",
                message:
                  error instanceof RoutingApplicationError
                    ? error.message
                    : "Could not complete the routing RPC request. Check that the server plugin is loaded for this project. A start request may have reached the server; check its status before retrying.",
              })
            }
          },
        }
      }),
    }))

    if (options.notifyOnLoad) {
      context.ui.toast.show({
        message: "AI Orchestration ready",
        variant: "success",
      })
    }
  },
})
