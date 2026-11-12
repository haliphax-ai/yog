import { TRUNCATION_IDENTIFIER, type ToolResult } from "./types.ts";

/** Default /shake fallback budget for tools without their own truncators. */
export const FALLBACK_TRUNCATE_CHARS = 500;

/** Default tool-output budget (serialized chars): the model must not crash
 *  its context window by reading an oversized file, fetching a huge webpage,
 *  etc. */
export const TOOL_OUTPUT_LIMIT_CHARS = 50_000;

/** Extra chars allowed beyond the output budget for the JSON structure that
 *  wraps a result (keys, braces, exitCode/runtimeMs numbers, …). */
export const TOOL_OUTPUT_GRACE_CHARS = 1_000;

/**
 * Token heuristic for estimating context size, calibrated against real
 * provider `prompt_tokens` (nemotron-3.5 via OpenRouter, agentic transcript
 * mix): alphanumeric characters count as ~1 token per 4 chars, everything
 * else (punctuation, whitespace, symbols) as ~1 per 2 — dense code and JSON
 * dominate agent transcripts, and plain chars/4 under-counts those by ~2x.
 */
export function estimateTokenCount(text: string): number {
  let alnum = 0;
  let other = 0;
  for (const ch of text) {
    if (/[A-Za-z0-9]/.test(ch)) alnum += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(alnum / 4 + other / 2));
}

/**
 * Serialized length of `s` exactly as `JSON.stringify` would emit it — the
 * wrapping quotes included — without building the escaped string. Tool
 * budgets are measured in these units because raw `.length` is a strict
 * lower bound of what the transcript actually stores: a newline, tab, quote,
 * or backslash doubles, an ANSI escape (or any U+0000–U+001F outside the
 * short escapes, or a lone surrogate) expands 6x.
 *
 * The counting mirrors the ES spec's QuoteJSONString + this engine's
 * encoding choices (C0 controls outside the short escapes, U+2028/2029, and
 * lone surrogates are \u-escaped; DEL, C1 controls, U+FEFF pass through
 * raw). test/tools.test.ts pins this against real `JSON.stringify` over a
 * battery so an engine drift fails loudly instead of silently over/under-
 * capping.
 */
export function jsonEscapedLen(s: string): number {
  let n = 2; // wrapping quotes
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20) {
      n += c === 0x09 || c === 0x0a || c === 0x0d || c === 0x08 || c === 0x0c ? 2 : 6;
    } else if (c === 0x22 || c === 0x5c) {
      n += 2; // "  \
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        n += 2; // valid pair, emitted raw
        i++;
      } else {
        n += 6; // lone high surrogate → \uXXXX
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      n += 6; // lone low surrogate → \uXXXX
    } else {
      n += 1;
    }
  }
  return n;
}

/** Escaped length of the string content (wrapping quotes excluded). */
function escapedLen(s: string): number {
  return jsonEscapedLen(s) - 2;
}

/** The truncation marker's own escaped footprint (it must survive the cut,
 *  so it counts against every budget). */
const MARKER_ESCAPED = jsonEscapedLen(TRUNCATION_IDENTIFIER) - 2;

/**
 * Middle-truncate against an ESCAPED-char budget: keep head and tail, drop
 * the middle, and insert the marker where content was cut — same shape as
 * {@link middleTruncate}, but the cap applies to what the string will cost
 * once JSON-serialized (for plain ASCII the two agree exactly; for
 * escape-dense content this is the only honest measure). The cut length is
 * binary-searched: escaped length is monotone in `keep`, and a slice can
 * split a surrogate pair (counting the resulting lones at 6), so no closed
 * form exists.
 *
 * Used by the live tool-output caps, where the serialized form is what gets
 * stored/streamed; /shake's soft raw-char budgets keep using
 * {@link middleTruncate}.
 */
export function middleTruncateEscaped(text: string, max: number): string {
  if (escapedLen(text) <= max) return text;
  // When the value contained newlines, put the marker on a line of its own
  // (flanked by newlines); the flanking counts against the cap (2x2 escaped).
  const hasNewlines = /[\r\n]/.test(text);
  const flank = hasNewlines ? 4 : 0;
  let lo = 1;
  let hi = text.length;
  const cost = (keep: number): number => {
    const half = keep >> 1;
    return (
      escapedLen(text.slice(0, half)) +
      MARKER_ESCAPED +
      flank +
      escapedLen(text.slice(text.length - (keep - half)))
    );
  };
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cost(mid) <= max) lo = mid;
    else hi = mid - 1;
  }
  const keep = Math.max(1, lo);
  const half = keep >> 1;
  const head = text.slice(0, half);
  const tail = text.slice(text.length - (keep - half));
  if (!hasNewlines) return head + TRUNCATION_IDENTIFIER + tail;
  return head + "\n" + TRUNCATION_IDENTIFIER + "\n" + tail;
}

/**
 * Split the output budget fairly between stdout and stderr (both middle-
 * truncated in serialized space — see {@link middleTruncateEscaped}). Each
 * stream's base share is half the budget; any unused share from one stream
 * is offered to the other. Shares are measured on escaped lengths so
 * escape-dense streams cannot claim headroom they will not actually use.
 */
export function fairTruncate(stdout: string, stderr: string, budget: number): [string, string] {
  const capStream = (text: string, max: number): string =>
    escapedLen(text) <= max ? text : middleTruncateEscaped(text, max);
  const half = Math.floor(budget / 2);
  const outLen = escapedLen(stdout);
  const retainedOut = Math.min(outLen, half);
  let remaining = budget - retainedOut;
  const errLen = escapedLen(stderr);
  const retainedErr = Math.min(errLen, remaining);
  remaining -= retainedErr;
  // Unused portion of the second stream flows back to the first.
  const extraOut = Math.min(outLen - retainedOut, remaining);
  return [capStream(stdout, retainedOut + extraOut), capStream(stderr, retainedErr)];
}

/**
 * Middle-truncate against a RAW-char budget: keep head and tail, replace the
 * dropped middle with the global truncation marker. Applies to any tool
 * arg/result that lacks a bespoke truncator (/shake's soft budgets).
 */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const markerLen = TRUNCATION_IDENTIFIER.length;
  // When the value contained newlines, put the marker on a line of its own
  // (flanked by newlines); the flanking counts against the cap.
  const hasNewlines = /[\r\n]/.test(text);
  const flank = hasNewlines ? 2 : 0;
  const keep = Math.max(1, max - markerLen - flank);
  const half = Math.floor(keep / 2);
  const headLen = half;
  const tailLen = keep - half;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  if (!hasNewlines) return head + TRUNCATION_IDENTIFIER + tail;
  return head + "\n" + TRUNCATION_IDENTIFIER + "\n" + tail;
}

/**
 * Fallback cap for any tool result: when the serialized JSON payload is
 * longer than the budget plus the grace window, the WHOLE serialized payload
 * (the string exactly as /shake treats a fallback result) is middle-truncated
 * to the budget and wrapped in a single-field `{"truncated": …}` envelope —
 * extra result structure does not survive the cut, matching /shake's generic
 * fallback. `originalLength` preserves the payload's true size for clients.
 *
 * The measurement is on the serialized form — the only sound unit, since raw
 * `.length` under-counts escaped content arbitrarily (a colored build log of
 * 25k raw chars can serialize to 78k). The envelope's `truncated` field is
 * itself cut in serialized space, so the shipped envelope stays within
 * `limit + grace` even for adversarial payloads.
 *
 * The budgets live at module level so the registry fallback reads the same
 * values the composition root configured; defaults hold until
 * `setToolOutputBudgets` is called (tests, CLI paths).
 */
let outputLimitChars = TOOL_OUTPUT_LIMIT_CHARS;
let outputGraceChars = TOOL_OUTPUT_GRACE_CHARS;

/** Inject the live tool-output budgets (owned by the composition root). */
export function setToolOutputBudgets(limit: number, grace: number): void {
  outputLimitChars = limit;
  outputGraceChars = grace;
}

/** The live tool-output budgets (`limit` chars, plus `grace` for the JSON wrapper). */
export function toolOutputBudgets(): { limit: number; grace: number } {
  return { limit: outputLimitChars, grace: outputGraceChars };
}

export function capToolResult(
  result: ToolResult,
  limit: number = outputLimitChars,
  grace: number = outputGraceChars,
): ToolResult {
  const json = JSON.stringify(result);
  if (json.length <= limit + grace) return result;
  return {
    truncated: middleTruncateEscaped(json, limit),
    originalLength: json.length,
  };
}
