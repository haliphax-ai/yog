/**
 * Job-lifecycle stream events (yog#100 client track): the drawer computes
 * runtime from `startedAt` and stamps the real duration at settle — no
 * polling against an open stream. Free functions over the injected
 * boundary (the manager stays a coordinator; events stay plumbing).
 */
import type { BackgroundJob } from "./types.ts";

/** The boundary that fans an event out onto the session's stream channel. */
export type JobEventsSink = (
  sessionId: string,
  envelope: { type: string; data: Record<string, unknown> },
) => void;

/** `job.started` — detach time, the fields a drawer row renders. */
export function jobStartedEvent(job: BackgroundJob): {
  type: string;
  data: Record<string, unknown>;
} {
  return {
    type: "job.started",
    data: { id: job.id, tool: job.tool, startedAt: job.startedAt },
  };
}

/** `job.settled` — the terminal stamp: state, reason, real duration. */
export function jobSettledEvent(job: BackgroundJob): {
  type: string;
  data: Record<string, unknown>;
} {
  return {
    type: "job.settled",
    data: {
      id: job.id,
      state: job.state,
      ...(job.termReason !== undefined ? { reason: job.termReason } : {}),
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      durationMs: Math.max(0, (job.endedAt ?? 0) - job.startedAt),
      result: job.result,
    },
  };
}
