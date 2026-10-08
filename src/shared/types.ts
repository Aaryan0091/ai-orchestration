export const ROUTING_MODES = ["automatic", "guided", "manual"] as const

export type RoutingMode = (typeof ROUTING_MODES)[number]

export const AGENT_IDS = [
  "orchestrator",
  "explorer",
  "planner",
  "builder",
  "debugger",
  "reviewer",
  "verifier",
  "visualizer",
] as const

export type AgentId = (typeof AGENT_IDS)[number]

export interface OrchestratorOptions {
  /** Controls whether the orchestrator may choose agents and models automatically. */
  mode: RoutingMode
  /** Shows a terminal notification when the TUI plugin is loaded. */
  notifyOnLoad: boolean
}

export interface PluginSnapshot {
  agents: readonly AgentId[]
  mode: RoutingMode
  version: 1
}

export function isRoutingMode(value: unknown): value is RoutingMode {
  return typeof value === "string" && ROUTING_MODES.includes(value as RoutingMode)
}

export function parseOptions(value: unknown): OrchestratorOptions {
  if (!value || typeof value !== "object") {
    return { mode: "guided", notifyOnLoad: false }
  }

  const options = value as Record<string, unknown>
  return {
    mode: isRoutingMode(options.mode) ? options.mode : "guided",
    notifyOnLoad: options.notifyOnLoad === true,
  }
}
