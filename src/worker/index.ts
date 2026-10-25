/**
 * Worker layer barrel: the daemon-side client plus its shutdown helper, and
 * the wire protocol types for anything that needs to talk to a worker.
 */
export { shutdownAllWorkers, WorkerClient } from "./client.ts";
export type {
  BashRunErr,
  BashRunOk,
  BashRunRequest,
  WorkerRequest,
  WorkerResponse,
} from "./protocol.ts";
