/**
 * The HTTP adapter's JobsBoundary, composed over the manager's operator
 * view (the free abort/purge/wake-stop functions). The manager stays
 * lean: the boundary is the adapter-facing projection, not new state.
 */
import {
  abortSessionJobs,
  purgeSessionJobs,
  stopSessionWakes,
  type AbortContext,
} from "./abort.ts";
import type { JobManager } from "./manager.ts";

export function jobsBoundary(jobs: JobManager): {
  abortSessionJobs(sessionId: string): number;
  stopSessionWakes(sessionId: string): void;
  purgeSession(sessionId: string): void;
  job(jobId: string): ReturnType<JobManager["job"]>;
  jobsFor(sessionId: string): ReturnType<JobManager["jobsFor"]>;
} {
  return {
    abortSessionJobs: (sessionId) => abortSessionJobs(jobs.operator(), sessionId),
    stopSessionWakes: (sessionId) => stopSessionWakes(jobs.operator(), sessionId),
    purgeSession: (sessionId) => purgeSessionJobs(jobs.operator(), sessionId),
    job: (jobId) => jobs.job(jobId),
    jobsFor: (sessionId) => jobs.jobsFor(sessionId),
  };
}
