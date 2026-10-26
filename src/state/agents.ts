/**
 * Agent identity and state-path derivation.
 *
 * The harness will eventually orchestrate multiple agents, so agent state is
 * keyed by an explicit agent id (a value threaded through the runtime) —
 * never by an environment variable. The environment contributes only the
 * system-wide storage root (`YOG_STATE_ROOT`, default `/var/lib/yog`).
 */

/** Opaque agent identifier. */
export type AgentId = string;

/** The single agent this bootstrap harness runs (multi-agent orchestration will pass others). */
export const DEFAULT_AGENT_ID: AgentId = "agent";

/** Storage root for all agent state (env is only the system-wide root). */
export function stateRoot(root = process.env["YOG_STATE_ROOT"] ?? "/var/lib/yog"): string {
  return root;
}

/** Derive the state database path for an agent. */
export function stateDbPath(
  agentId: AgentId,
  root = process.env["YOG_STATE_ROOT"] ?? "/var/lib/yog",
): string {
  return `${root}/agentfs/${agentId}.db`;
}
