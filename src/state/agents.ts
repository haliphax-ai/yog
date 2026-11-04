/**
 * Agent identity and state-path derivation.
 *
 * keyed by an explicit agent id (a value threaded through the runtime) —
 * never by a configuration file. The configuration contributes only the
 * system-wide storage root (injected; default `/var/lib/yog`).
 */

/** Opaque agent identifier. */
export type AgentId = string;

/** The single agent this bootstrap harness runs (multi-agent orchestration will pass others). */
export const DEFAULT_AGENT_ID: AgentId = "agent";

/** Storage root for all agent state (injected by the composition root). */
export function stateRoot(root: string = "/var/lib/yog"): string {
  return root;
}

/** Derive the state database path for an agent under `root`. */
export function stateDbPath(agentId: AgentId, root: string = "/var/lib/yog"): string {
  return `${root}/agentfs/${agentId}.db`;
}
