import type { CommandStatus, CommandTicket } from "./command-verification-rpc.ts"
import { type DesktopScope, scopeError } from "./gui-controller.ts"
import type { GuidedStep, GuidedWorkflow } from "./guided-rpc.ts"
import { unwrapRoutingReply } from "./rpc.ts"

interface CommandHost {
  prepare(input: { sessionID: string; workflowID: string; stepID: string }): Promise<unknown>
  status(input: { sessionID: string; id: string }): Promise<unknown>
  cancel(input: { sessionID: string; id: string }): Promise<unknown>
  create(input: {
    location: { directory: string }
    cwd: string
    command: string
    timeout: number
    metadata: { orchestrationVerification: string }
  }): Promise<unknown>
  remove(input: { id: string; location: { directory: string } }): Promise<unknown>
}

export function canRunCommandVerification(step: GuidedStep) {
  return (
    step.state === "completed" &&
    !!step.verification?.command &&
    !step.commandResult?.ticketID &&
    (step.verification.summaryEquals === undefined ||
      step.summary === step.verification.summaryEquals)
  )
}

/** Native dispatch is one-shot; only backend shell events establish the verdict. */
export function createGuiCommandActions(
  scope: DesktopScope,
  active: () => boolean,
  host: CommandHost,
) {
  const decisions = new Set<string>()
  const cancellations = new Set<string>()
  const tickets = new Map<string, string>()
  function checkScope() {
    if (!active()) throw scopeError()
  }
  function owns(workflow: GuidedWorkflow, step: GuidedStep) {
    checkScope()
    if (
      workflow.directory !== scope.directory ||
      workflow.sessionID !== scope.sessionID ||
      !workflow.steps.some((candidate) => candidate.id === step.id)
    )
      throw scopeError()
  }
  function key(workflow: GuidedWorkflow, step: GuidedStep) {
    return `${workflow.id}:${step.id}`
  }
  function validateStatus(value: unknown, workflow: GuidedWorkflow, step: GuidedStep, id: string) {
    checkScope()
    const result = unwrapRoutingReply(value) as CommandStatus
    if (
      !result ||
      result.id !== id ||
      result.sessionID !== scope.sessionID ||
      result.directory !== scope.directory ||
      result.workflowID !== workflow.id ||
      result.stepID !== step.id ||
      result.result?.command !== step.verification?.command ||
      result.result?.source !== "native-shell" ||
      result.result?.ticketID !== id ||
      (result.shellID !== undefined && typeof result.shellID !== "string")
    )
      throw new Error("Command status did not match this chat and step. Refresh before continuing.")
    return structuredClone(result)
  }
  function ticketID(workflow: GuidedWorkflow, step: GuidedStep) {
    return step.commandResult?.ticketID ?? tickets.get(key(workflow, step))
  }
  return {
    async run(workflow: GuidedWorkflow, step: GuidedStep, dismissConfirmation?: () => void) {
      owns(workflow, step)
      const command = step.verification?.command
      const decision = key(workflow, step)
      if (
        !command ||
        !canRunCommandVerification(step) ||
        ticketID(workflow, step) ||
        decisions.has(decision)
      )
        throw new Error(
          "This command was already requested, the specialist has not completed, or the required summary did not match. Refresh to inspect its status.",
        )
      // Reserve before permission/transport awaits; an ambiguous reply cannot authorize replay.
      decisions.add(decision)
      // The native permission card is in the originating chat. Do not cover it with our dialog.
      dismissConfirmation?.()
      const ticket = unwrapRoutingReply(
        await host.prepare({
          sessionID: scope.sessionID,
          workflowID: workflow.id,
          stepID: step.id,
        }),
      ) as CommandTicket
      checkScope()
      if (
        !ticket ||
        typeof ticket.id !== "string" ||
        !ticket.id ||
        ticket.sessionID !== scope.sessionID ||
        ticket.directory !== scope.directory ||
        ticket.workflowID !== workflow.id ||
        ticket.stepID !== step.id ||
        ticket.command !== command ||
        ticket.executionCommand !== command ||
        ticket.timeoutMs !== 30000 ||
        !Number.isFinite(ticket.expiresAt) ||
        ticket.permissionSessionID !== scope.sessionID ||
        Date.now() >= ticket.expiresAt ||
        ticket.metadata?.orchestrationVerification !== ticket.id ||
        Object.keys(ticket.metadata).length !== 1
      )
        throw new Error(
          "The command ticket did not match the approved step. Nothing was dispatched.",
        )
      tickets.set(decision, ticket.id)
      await host.create({
        location: { directory: scope.directory },
        cwd: scope.directory,
        command,
        timeout: 30000,
        metadata: { orchestrationVerification: ticket.id },
      })
      checkScope()
      return ticket.id
    },
    async status(workflow: GuidedWorkflow, step: GuidedStep) {
      owns(workflow, step)
      const id = ticketID(workflow, step)
      if (!id) return undefined
      return validateStatus(
        await host.status({ sessionID: scope.sessionID, id }),
        workflow,
        step,
        id,
      )
    },
    async cancel(workflow: GuidedWorkflow, step: GuidedStep) {
      owns(workflow, step)
      const id = ticketID(workflow, step)
      if (!id || cancellations.has(id))
        throw new Error(
          "A stop request is already in flight. Refresh and inspect authoritative command status.",
        )
      cancellations.add(id)
      try {
        const result = validateStatus(
          await host.cancel({ sessionID: scope.sessionID, id }),
          workflow,
          step,
          id,
        )
        if (result.shellID)
          await host.remove({ id: result.shellID, location: { directory: scope.directory } })
        checkScope()
        return result
      } finally {
        // A new explicit confirmation may retry stopping an observed shell; never replay work.
        cancellations.delete(id)
      }
    },
  }
}
