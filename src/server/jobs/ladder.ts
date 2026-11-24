/**
 * Wake-ladder arithmetic (yog#91), extracted from the manager so each
 * ladder rule stays a small, individually readable predicate:
 *
 * - the effective delay is the rung's ms clamped to the ceiling rung;
 * - the rung advances (toward the ceiling) when a wake fires with nothing
 *   finished since the last wake;
 * - the rung resets to 0 only when the queue clears;
 * - a wake turn that settles with jobs still pending re-arms at the
 *   current rung (hot-loop guard).
 */
import type { BackgroundJob } from "./types.ts";

/** The ladder delay for a rung (clamped to the ceiling rung). */
export function rungDelayMs(ladder: readonly number[], rung: number): number {
  return ladder[Math.min(rung, ladder.length - 1)]!;
}

/** The next rung after a wake with nothing finished (ceiling-clamped). */
export function advanceRung(ladder: readonly number[], rung: number): number {
  return Math.min(rung + 1, ladder.length - 1);
}

/**
 * True when the session's queue is clear: no undelivered job remains
 * (pending or running). The rung resets only on this.
 */
export function queueCleared(jobs: readonly BackgroundJob[], sessionId: string): boolean {
  return !jobs.some((j) => j.sessionId === sessionId && !j.delivered);
}

/** The session's undelivered, settled jobs in pending order. */
export function collectPending(
  lookup: (id: string) => BackgroundJob | undefined,
  pendingIds: readonly string[],
): BackgroundJob[] {
  return pendingIds
    .map((id) => lookup(id))
    .filter((j): j is BackgroundJob => j !== undefined && j.delivered !== true);
}
