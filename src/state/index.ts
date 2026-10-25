/**
 * State layer barrel: the agentfs-backed home/state wrapper and the session
 * id generator. Only this layer may import the agentfs SDK (depcruise rule
 * `agentfs-only-in-state`).
 */
export { AgentFSState, type ToolCallRecord } from "./agentfs.ts";
export { newSessionId } from "./session.ts";
