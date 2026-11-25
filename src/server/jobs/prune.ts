/**
 * Settled-job TTL sweep (yog#91), extracted from the manager (same shape
 * as `abort.ts`): free functions over the manager's collections, because
 * the sweep mutates the same maps the delivery loop reads.
 */
import type { BackgroundJob, JobSessionState } from "./types.ts";
import type { SchedulerLike } from "./types.ts";

/** Everything the sweep touches (the manager's own state). */
export interface PruneContext {
  readonly jobs: Map<string, BackgroundJob>;
  readonly sessions: Map<string, JobSessionState>;
  readonly idleSubs: Map<string, () => void>;
  readonly sched: SchedulerLike;
}

/** The fixed sweep cadence (one hour); the TTL itself is configurable. */
export const PRUNE_SWEEP_MS = 60 * 60 * 1000;

/**
 * Drop settled jobs older than `ttlMs`. Undelivered results are dropped
 * with their row — pending entries scrubbed, emptied session state torn
 * down (ladder timer canceled, idle sub unsubscribed) — so the sweep
 * bounds the session-state maps too instead of chasing its own tail.
 * Running jobs are never pruned: their cap timer and pool run are live.
 * The agentfs audit rows survive in the store; only the in-memory row is
 * lost.
 */
export function pruneExpiredJobs(ctx: PruneContext, ttlMs: number): number {
  const cutoff = ctx.sched.now() - ttlMs;
  const pruned = [...ctx.jobs.entries()].filter(([, job]) => expired(job, cutoff));
  for (const [id, job] of pruned) {
    ctx.jobs.delete(id);
    scrubPending(ctx, job);
  }
  for (const sessionId of new Set(pruned.map(([, job]) => job.sessionId))) {
    teardownIfEmpty(ctx, sessionId);
  }
  return pruned.length;
}

/** True when the row is settled AND its settle time is past the cutoff. */
function expired(job: BackgroundJob, cutoff: number): boolean {
  return job.state !== "running" && (job.endedAt ?? 0) <= cutoff;
}

/** Drop the id from the owning session's undelivered queue. */
function scrubPending(ctx: PruneContext, job: BackgroundJob): void {
  const st = ctx.sessions.get(job.sessionId);
  if (st === undefined) return;
  st.pending = st.pending.filter((pendingId) => pendingId !== job.id);
}

/** Tear the session down when the sweep removed its last job row. */
function teardownIfEmpty(ctx: PruneContext, sessionId: string): void {
  const st = ctx.sessions.get(sessionId);
  if (st === undefined || sessionHasJobs(ctx, sessionId)) return;
  if (st.ladderTimer !== undefined) ctx.sched.cancel(st.ladderTimer);
  ctx.idleSubs.get(sessionId)?.();
  ctx.idleSubs.delete(sessionId);
  ctx.sessions.delete(sessionId);
}

/** True when the session still owns at least one job row. */
function sessionHasJobs(ctx: PruneContext, sessionId: string): boolean {
  for (const job of ctx.jobs.values()) {
    if (job.sessionId === sessionId) return true;
  }
  return false;
}
