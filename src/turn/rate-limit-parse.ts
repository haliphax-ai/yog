/**
 * Provider rate-limit duration grammars, parsed to milliseconds.
 *
 * `x-ratelimit-reset-*` values are OpenAI-style composite durations
 * ("20ms", "1m20s", "2h0s0ms", or a bare number); `Retry-After` carries
 * either delay-seconds or an HTTP date. Anything unparseable is not a
 * wait (`undefined`) — never guessed.
 */

/**
 * One `<int><unit>` segment of a composite reset duration: the segment
 * count and its unit (h|m|s|ms; the composite grammar is a sequence of
 * these segments).
 */
interface ResetSegment {
  n: number;
  unit: string;
}

/** Milliseconds for one duration segment (h -> ms, m -> ms, s -> ms, ms). */
const SEGMENT_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

/** Milliseconds for one duration segment. */
function resetSegmentMs(segment: ResetSegment): number {
  return segment.n * (SEGMENT_MS[segment.unit] ?? 1);
}

/**
 * Composite form: a sequence of `<int><unit>` tokens (unit h|m|s|ms),
 * e.g. `1m20s` or `2h0s0ms`. Summed; undefined when the shape does not
 * match.
 */
function compositeResetMs(v: string): number | undefined {
  if (!/^(?:\d+(?:ms|h|m|s))+$/.test(v)) return undefined;
  let total = 0;
  for (const m of v.matchAll(/(\d+)(ms|h|m|s)/g)) {
    total += resetSegmentMs({ n: Number(m[1]), unit: m[2] ?? "" });
  }
  return total;
}

/**
 * Bare-number reset values: epoch timestamps are implausibly large for a
 * wait, so huge values are treated as epoch ms/s (a relative wait is
 * derived from now); everything else is seconds.
 */
function bareNumberResetMs(n: number): number {
  if (n > 1e14) return n - Date.now();
  if (n > 1e10) return n * 1000 - Date.now();
  return n * 1_000;
}

/**
 * Parse an OpenAI x-ratelimit-reset-* duration ("20ms", "1m20s",
 * "2h0s0ms", or a bare number) to milliseconds. Composite int+unit
 * sequences are summed; bare numbers are interpreted by magnitude in
 * bareNumberResetMs; anything else is not a wait (undefined).
 */
export function parseRateLimitResetMs(value: string): number | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  const composite = compositeResetMs(v);
  if (composite !== undefined) return composite;
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  return bareNumberResetMs(n);
}

/**
 * Parse a `Retry-After` value (delay-seconds or an HTTP date) to the
 * wait in ms from `now`; unparseable values are not a wait.
 */
export function parseRetryAfterMs(value: string, now: number): number | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  const asSeconds = Number(v);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1_000);
  const asDate = Date.parse(v);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);
  return undefined;
}
