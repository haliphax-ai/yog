/**
 * Worker layer barrel: the daemon-side client plus its shutdown helper, the
 * wire protocol framing helpers, and all request/response/snapshot types.
 *
 * Nothing outside `src/worker/` may import these internals directly
 * (depcruise `worker-entry-only`).
 */
export {
  agentSpawnOptions,
  onAgentSpawn,
  shutdownAllWorkers,
  WorkerClient,
  type AgentSpawnOptions,
} from "./client.ts";
export { decodeFrame, encodeFrame } from "./protocol.ts";
export type {
  BashRunErr,
  BashRunOk,
  BashRunRequest,
  BashPidRequest,
  BashPidOk,
  ShellSnapshot,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.ts";
