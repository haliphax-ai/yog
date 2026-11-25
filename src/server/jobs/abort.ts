/**
 * Idle-abort + purge semantics (yog#91), extracted from the manager so the
 * terminate/deliver core stays small. Free functions over an explicit
 * context (the manager's collections), because both operators mutate the
 * same maps the delivery loop reads — a separate class would duplicate the
 * state rather than share it.
 */
import type { BackgroundJob, JobSessionState, JobTermReason } from "./types.ts";
import type { PreludeSinkLike, SchedulerLike, WorkerPoolLike } from "./types.ts";

/** Everything the abort/purge operators touch (the manager's own state). */
export interface AbortContext {
  readonly jobs: Map<string, BackgroundJob>;
  readonly sessions: Map<string, JobSessionState>;
  readonly capTimers: Map<string, { readonly active: boolean; readonly dueAt: number }>;
  readonly idleSubs: Map<string, () => void>;
  readonly sched: SchedulerLike;
  readonly poolView: WorkerPoolLike;
  readonly preludeView: PreludeSinkLike;
  readonly recordAudit: (job: BackgroundJob) => void;
}

/** Stamp a running job terminated + release its slot/cap (no delivery). */
function stampTerminated(
  ctx: AbortContext,
  jobId: string,
  reason: JobTermReason,
): BackgroundJob | undefined {
  const job = ctx.jobs.get(jobId);
  if (job === undefined || job.state !== "running") return undefined;
  job.state = "terminated";
  job.termReason = reason;
  job.endedAt = ctx.sched.now();
  const st = ctx.sessions.get(job.sessionId);
  if (st !== undefined) st.running = Math.max(0, st.running - 1);
  const cap = ctx.capTimers.get(jobId);
  if (cap !== undefined) {
    ctx.sched.cancel(cap);
    ctx.capTimers.delete(jobId);
  }
  return job;
}

/** Kill one job for an idle abort (running: pool kill; settled: silent). */
function abortJob(ctx: AbortContext, job: BackgroundJob): void {
  if (job.state === "running") {
    const stamped = stampTerminated(ctx, job.id, "operator abort");
    if (stamped !== undefined) {
      void ctx.poolView.abortRun(`bg:${job.id}`).catch(() => undefined);
      ctx.recordAudit(stamped);
    }
  } else {
    // Settled but undelivered: drop it silently (no wake turn).
    job.state = "terminated";
    job.termReason = "operator abort";
    job.endedAt = job.endedAt ?? ctx.sched.now();
  }
  job.delivered = true;
}

/** Drop a session's ladder timer, rung, pending set, and idle sub. */
function wipeSessionState(ctx: AbortContext, sessionId: string): void {
  const st = ctx.sessions.get(sessionId);
  if (st !== undefined) {
    if (st.ladderTimer !== undefined) {
      ctx.sched.cancel(st.ladderTimer);
      st.ladderTimer = undefined;
    }
    st.rung = 0;
    st.pending = [];
  }
  const unsub = ctx.idleSubs.get(sessionId);
  if (unsub !== undefined) {
    unsub();
    ctx.idleSubs.delete(sessionId);
  }
}

/**
 * Kill every job for the session (idle abort): terminate, wipe timers,
 * reset the rung, and queue the prelude notice — no wake turn. Returns
 * the number of jobs terminated (the reply's `aborted.backgroundJobs`).
 */
export function abortSessionJobs(ctx: AbortContext, sessionId: string): number {
  const jobs = [...ctx.jobs.values()].filter((j) => j.sessionId === sessionId && !j.delivered);
  for (const job of jobs) abortJob(ctx, job);
  wipeSessionState(ctx, sessionId);
  if (jobs.length > 0) {
    const ids = jobs.map((j) => j.id).join(", ");
    ctx.preludeView.push(sessionId, "background-jobs", `background jobs terminated: ${ids}`);
  }
  return jobs.length;
}

/**
 * Stop the session's wake machinery (operator turn.abort): cancel the
 * ladder timer, drop undelivered pendings, clear idle subscriptions.
 * RUNNING jobs are untouched — they keep executing and surface through
 * `jobs.get`/the drawer. This exists because a wake turn aborted by the
 * operator must not be re-spawned by the ladder 30m later: the user
 * said stop, and the session should go (and stay) idle.
 */
export function stopSessionWakes(ctx: AbortContext, sessionId: string): void {
  const st = ctx.sessions.get(sessionId);
  if (st !== undefined) {
    if (st.ladderTimer !== undefined) {
      ctx.sched.cancel(st.ladderTimer);
      st.ladderTimer = undefined;
    }
    st.rung = 0;
    for (const id of st.pending) {
      const job = ctx.jobs.get(id);
      if (job !== undefined) job.delivered = true;
    }
    st.pending = [];
  }
  const unsub = ctx.idleSubs.get(sessionId);
  if (unsub !== undefined) {
    unsub();
    ctx.idleSubs.delete(sessionId);
  }
}

/**
 * Purge the session's jobs + timers + records (session.detach purge):
 * kills like an idle abort but clears the prelude instead of queueing it
 * (no zombie wakes against a purged session).
 */
export function purgeSessionJobs(ctx: AbortContext, sessionId: string): void {
  abortSessionJobs(ctx, sessionId);
  ctx.preludeView.clear(sessionId);
  const doomed = [...ctx.jobs.values()]
    .filter((job) => job.sessionId === sessionId)
    .map((job) => job.id);
  for (const id of doomed) ctx.jobs.delete(id);
  ctx.sessions.delete(sessionId);
}
