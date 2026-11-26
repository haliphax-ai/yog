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

/**
 * Slice a settled batch to the per-wake cap (the context-window guard):
 * the first `cap` jobs deliver on this wake; the rest stay pending (in
 * pending order) and ride the next wake turn. Mutates `jobs` in place —
 * the free-function pattern the other ladder rules use (the manager keeps
 * its collections, this keeps its arithmetic).
 */
export function sliceToWakeCap(
  jobs: BackgroundJob[],
  pendingIds: readonly string[],
  cap: number,
): { delivered: BackgroundJob[]; pending: string[] } {
  if (jobs.length <= Math.max(1, cap)) return { delivered: jobs, pending: [...pendingIds] };
  const delivered = jobs.slice(0, Math.max(1, cap));
  const deliveredIds = new Set(delivered.map((j) => j.id));
  const overflow = jobs.filter((j) => !deliveredIds.has(j.id));
  const pending = overflow.map((j) => j.id);
  for (const id of pendingIds) if (!deliveredIds.has(id)) pending.push(id);
  return { delivered, pending };
}
