/**
 * The engine's 429 retry cycle: structured warn, `rate_limited` event,
 * and an abort-aware backoff wait. The caller's `onRetry` hook counts
 * the retry for the terminal `turn.finished` payload.
 */

import type { TurnEventDataMap, TurnEventType } from "./sink.ts";

import { logger } from "../log.ts";
import { rateLimitDelayMs, rateLimitHints, type RateLimitPolicy } from "./rate-limit.ts";

/** Inputs for one 429 retry cycle (warn + event + backoff). */
export interface RateLimitedCycle {
  /** 0-based tool-loop round whose request was rejected. */
  round: number;
  /** 1-based ordinal of this failed attempt. */
  attempt: number;
  /** The resolved retry policy. */
  policy: RateLimitPolicy;
  /** The provider error. */
  err: unknown;
}

/**
 * One 429 retry cycle: structured warn, `rate_limited` event, backoff
 * wait (abort-aware). The caller's `onRetry` hook counts the retry for
 * the terminal `turn.finished` payload.
 */
export async function emitRateLimited(
  emit: <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>,
  checkAbort: () => void,
  cycle: RateLimitedCycle,
  onRetry: () => void,
): Promise<void> {
  const { round, attempt, policy, err } = cycle;
  const hints = rateLimitHints(err);
  const delayMs = rateLimitDelayMs(err, attempt, policy);
  onRetry();
  logger.warn(
    { round, attempt, maxAttempts: policy.maxAttempts, delayMs, ...hints },
    `[rate-limit] provider 429 on round ${round} (attempt ${attempt}/${policy.maxAttempts}); backing off ${delayMs}ms`,
  );
  await emit("rate_limited", {
    attempt,
    maxAttempts: policy.maxAttempts,
    delayMs,
    ...(hints.retryAfterMs !== undefined ? { retryAfterMs: hints.retryAfterMs } : {}),
    ...(hints.resetMs !== undefined ? { resetMs: hints.resetMs } : {}),
    round,
    status: 429,
    ...(err instanceof Error && err.message ? { providerMessage: err.message } : {}),
  });
  await sleepBackoff(delayMs, checkAbort, policy.sleep);
}

/**
 * Abortable backoff wait: wakes promptly when `checkAbort` would throw.
 * The wait is sliced (50ms probes) so a long timer still notices an
 * abort that fires mid-wait — the engine cannot sit out a six-second
 * backoff when the operator aborts at second one.
 */
export async function sleepBackoff(
  ms: number,
  checkAbort: () => void,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  const wait = sleep ?? defaultSleep;
  const deadline = Date.now() + Math.max(0, ms);
  while (true) {
    checkAbort();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await wait(Math.min(remaining, 50));
  }
}

/** Slice-based timer wait (the non-injected default). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
