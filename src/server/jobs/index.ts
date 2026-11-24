/**
 * Jobs domain barrel — the single public door for the background-jobs
 * manager (yog#91).
 *
 * Internal to the server domain: the composition root (serve.ts) resolves
 * the config-derived options, injects the boundaries, arms the toolkit's
 * detach policy via {@link JobManager.wire}, and tears the manager down at
 * shutdown. Nothing outside `src/server/jobs/` reaches past this barrel
 * (depcruise `domain-entry-only:server` covers the folder; the jobs
 * subdomain is reached only through its own barrel like daemon/ before it).
 */
export { JobManager } from "./manager.ts";
export { buildWakePrompt, jobBlock } from "./wake.ts";
export { advanceRung, collectPending, queueCleared, rungDelayMs } from "./ladder.ts";
export { abortSessionJobs, purgeSessionJobs, type AbortContext } from "./abort.ts";
export {
  NO_ORCHESTRATOR,
  NO_POOL,
  NO_PRELUDE,
  nodeSchedulerLike,
  orchestratorView,
  poolView,
  preludeView,
  schedulerView,
  type OrchestratorLike,
} from "./adapters.ts";
export type {
  BackgroundJob,
  JobState,
  JobTermReason,
  JobSessionState,
  JobManagerDeps,
  JobManagerOptions,
  PreludeSinkLike,
  SchedulerLike,
  WorkerPoolLike,
} from "./types.ts";
