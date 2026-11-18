/**
 * Provider 429 (rate-limit) handling: the bounded retry policy, error
 * recognition, server wait hints, and the backoff delay computation.
 *
 * A 429 from `chat.completions.create()` means the request was rejected
 * before any chunk was produced: `messages` is unchanged, no assistant
 * text was emitted, and no tool from *this* round has run (tools belong
 * to earlier, already-appended rounds). The engine therefore resubmits
 * the identical `messages` array after a backoff — no synthetic user
 * message, no transcript "healing", no tool re-execution.
 *
 * Only failures of the initial `create()` call are retried. A failure
 * after streaming has begun cannot be transparently retried (deltas
 * were already emitted and tool calls may have been announced); it
 * unwinds to the terminal/heal path exactly as before.
 */

import { parseRateLimitResetMs, parseRetryAfterMs } from "./rate-limit-parse.ts";
import { headerGetterFrom, type HeaderGetter } from "./rate-limit-headers.ts";

/**
 * Bounded retry policy for provider 429s at the *start* of a round.
 */
export interface RateLimitPolicy {
  /**
   * Total requests allowed per round, initial try included
   * (default 6 = 1 initial try + 5 retries). `1` disables retrying.
   */
  maxAttempts: number;
  /** First exponential wait in ms (default 1000). */
  baseDelayMs: number;
  /**
   * Cap for any single wait in ms (default 60_000). Server hints
   * (`Retry-After`, `x-ratelimit-reset-*`) are clamped to this cap; a
   * hint above the cap simply trades for another 429 + retry until
   * `maxAttempts` is exhausted.
   */
  maxDelayMs: number;
  /** Exponential multiplier per failed attempt (default 2). */
  backoffFactor: number;
  /**
   * Jitter fraction in [0, 1): the exponential delay is scaled by
   * `1 - random() * jitterRatio` (default 0.25, matching the SDK).
   * Server-hinted delays are *not* jittered — the server's wait is
   * authoritative.
   */
  jitterRatio?: number;
  /** Injectable timer for tests (defaults to real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness in [0, 1) for tests (defaults to `Math.random`). */
  random?: () => number;
}

/** The always-present core of a resolved {@link RateLimitPolicy}. */
export type ResolvedRateLimitPolicy = Required<
  Pick<
    RateLimitPolicy,
    "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "backoffFactor" | "jitterRatio"
  >
> &
  Pick<RateLimitPolicy, "sleep" | "random">;

/** Default 429 retry policy (see {@link RateLimitPolicy}). */
export const DEFAULT_RATE_LIMIT_POLICY: Required<
  Pick<RateLimitPolicy, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "backoffFactor">
> = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffFactor: 2,
};

/** Resolve a partial policy against the defaults (invalid values fall back). */
export function resolveRateLimitPolicy(policy?: Partial<RateLimitPolicy>): ResolvedRateLimitPolicy {
  const num = (v: unknown, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : dflt;
  const maxAttempts = Math.max(
    1,
    Math.floor(num(policy?.maxAttempts, DEFAULT_RATE_LIMIT_POLICY.maxAttempts)),
  );
  const baseDelayMs = Math.max(0, num(policy?.baseDelayMs, DEFAULT_RATE_LIMIT_POLICY.baseDelayMs));
  const maxDelayMs = Math.max(0, num(policy?.maxDelayMs, DEFAULT_RATE_LIMIT_POLICY.maxDelayMs));
  const backoffFactor = Math.max(
    1,
    num(policy?.backoffFactor, DEFAULT_RATE_LIMIT_POLICY.backoffFactor),
  );
  const jitterRatio =
    policy?.jitterRatio === undefined ? 0.25 : Math.min(1, Math.max(0, policy.jitterRatio));
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs: Math.max(maxDelayMs, 0),
    backoffFactor,
    jitterRatio,
    ...(policy?.sleep ? { sleep: policy.sleep } : {}),
    ...(policy?.random ? { random: policy.random } : {}),
  };
}

/** `true` when `code` names a provider rate limit. */
function isRateLimitCode(code: string | undefined): boolean {
  return code === "rate_limit_exceeded" || code === "rate_limited";
}

/** The top-level `code` field (string) or undefined. */
function topLevelCodeOf(rec: Record<string, unknown>): string | undefined {
  return typeof rec.code === "string" ? rec.code : undefined;
}

/** `true` when the error record carries a 429 in any known shape. */
function hasRateLimitStatus(rec: Record<string, unknown>): boolean {
  return rec.status === 429 || rec.statusCode === 429;
}

/**
 * The rate-limit code nested inside a provider body (`error.code`), when
 * the body exists and carries a string code; undefined otherwise.
 */
function innerCodeOf(rec: Record<string, unknown>): string | undefined {
  const inner = rec.error;
  if (inner === null || typeof inner !== "object") return undefined;
  const code = (inner as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Whether `err` is a provider rate-limit (429) failure. Recognises the
 * OpenAI SDK's `RateLimitError` shape (`status: 429`), an explicit
 * `code` of `rate_limit_exceeded` / `rate_limited`, and the class name.
 * A bare message mentioning "429" is deliberately *not* enough: plain
 * `Error("429 rate limited")` values are also used for mid-stream
 * failures, which must stay terminal rather than retry.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  if (hasRateLimitStatus(rec)) return true;
  if (isRateLimitCode(topLevelCodeOf(rec))) return true;
  if (err instanceof Error && err.name === "RateLimitError") return true;
  return isRateLimitCode(innerCodeOf(rec));
}

/** Server wait hints carried by a 429 error, in ms. */
export interface RateLimitHints {
  /** From `retry-after-ms` / `Retry-After` (precise ms), when sent. */
  retryAfterMs?: number;
  /** The largest `x-ratelimit-reset-*` window (ms), when sent. */
  resetMs?: number;
}

/** `retry-after-ms` (precise ms), falling back to `Retry-After` parsing. */
function retryAfterHint(get: HeaderGetter, now: number): number | undefined {
  const rawMs = get("retry-after-ms");
  if (rawMs !== undefined) {
    const n = Number(rawMs);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  const raw = get("retry-after");
  return raw === undefined ? undefined : parseRetryAfterMs(raw, now);
}

/** The largest `x-ratelimit-reset-*` hint (ms), when any header parses. */
function resetHint(get: HeaderGetter): number | undefined {
  let resetMs: number | undefined;
  for (const name of [
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset",
  ]) {
    const raw = get(name);
    if (raw === undefined) continue;
    const ms = parseRateLimitResetMs(raw);
    if (ms !== undefined) resetMs = resetMs === undefined ? ms : Math.max(resetMs, ms);
  }
  return resetMs;
}

/**
 * Server wait hints carried by a 429 error, in ms. `retryAfterMs` comes
 * from `retry-after-ms` / `Retry-After`; `resetMs` is the largest
 * `x-ratelimit-reset-*` window (tokens and requests must both refill,
 * so the larger governs). Both are undefined when the provider sent
 * no usable hint.
 */
export function rateLimitHints(err: unknown, now = Date.now()): RateLimitHints {
  const get = headerGetterFrom(err);
  if (!get) return {};
  const hints: RateLimitHints = {};
  const retryAfterMs = retryAfterHint(get, now);
  const resetMs = resetHint(get);
  if (retryAfterMs !== undefined) hints.retryAfterMs = retryAfterMs;
  if (resetMs !== undefined) hints.resetMs = resetMs;
  return hints;
}

/**
 * Backoff wait (ms) before the next try after failed attempt `attempt`
 * (1-based): the largest server hint when present (clamped to
 * `maxDelayMs`), otherwise exponential `baseDelayMs * factor^(attempt-1)`
 * with jitter, also clamped.
 */
export function rateLimitDelayMs(
  err: unknown,
  attempt: number,
  policy: RateLimitPolicy,
  now = Date.now(),
): number {
  const resolved = resolveRateLimitPolicy(policy);
  const hints = rateLimitHints(err, now);
  const hinted = [hints.retryAfterMs, hints.resetMs].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (hinted.length > 0) {
    return Math.min(resolved.maxDelayMs, Math.max(0, Math.max(...hinted)));
  }
  const exponential =
    resolved.baseDelayMs * Math.pow(resolved.backoffFactor, Math.max(0, attempt - 1));
  const jittered = exponential * (1 - resolved.jitterRatio * (policy.random?.() ?? Math.random()));
  return Math.min(resolved.maxDelayMs, Math.max(0, jittered));
}
