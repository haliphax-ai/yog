/**
 * Server-layer barrel: re-exports the server modules so consumers can
 * import from a single entry point while individual modules evolve.
 *
 * The daemon assembly (./daemon/) is internal: its boundary surface
 * (createRuntime, Runtime) is re-exported here rather than the modules
 * being reachable past the domain door.
 */

export { SessionStore, openSessionsDb } from "./store/index.ts";
export { WorkerPool } from "./workpool.ts";
export { SessionOrchestrator } from "./orchestrator.ts";
export type { SessionOrchestratorDeps, TurnHandle, TurnRequest } from "./orchestrator.ts";
export { createDaemon } from "./serve.ts";
export type { Daemon, DaemonOptions } from "./serve.ts";
export { MESSAGE_TYPES, MESSAGE_VERSION, parseEnvelope } from "./messages.ts";
export type { MessageEnvelope, MessageType } from "./messages.ts";
export { runCalibrate } from "./calibrate-cli.ts";
export { createRuntime, type Runtime } from "./daemon/index.ts";
