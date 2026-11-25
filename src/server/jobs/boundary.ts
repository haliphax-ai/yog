/**
 * The HTTP adapter's JobsBoundary, composed over the manager's operator
 * view (the free abort/purge/wake-stop functions). The manager stays
 * lean: the boundary is the adapter-facing projection, not new state.
 */
import type { JobManager } from "./manager.ts";
import { abortSessionJobs, purgeSessionJobs, stopSessionWakes } from "./abort.ts";
import type { JobsBoundary } from "../http/types.ts";

export function jobsBoundary(jobs: JobManager): JobsBoundary {
  return {
    abortSessionJobs: (sessionId) => abortSessionJobs(jobs.operator(), sessionId),
    stopSessionWakes: (sessionId) => stopSessionWakes(jobs.operator(), sessionId),
    purgeSession: (sessionId) => purgeSessionJobs(jobs.operator(), sessionId),
    job: (jobId) => jobs.job(jobId),
    jobsFor: (sessionId) => jobs.jobsFor(sessionId),
  };
}
