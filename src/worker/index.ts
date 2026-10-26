/**
 * Worker layer barrel: the daemon-side client plus its shutdown helper, the
 * wire protocol framing helpers, and all request/response/snapshot types.
 *
 * Nothing outside `src/worker/` may import these internals directly
 * (depcruise `worker-entry-only`).
 */
export { shutdownAllWorkers, WorkerClient } from "./client.ts";
export { decodeFrame, encodeFrame } from "./protocol.ts";
export type {
  BashRunErr,
  BashRunOk,
  BashRunRequest,
  ShellSnapshot,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.ts";
