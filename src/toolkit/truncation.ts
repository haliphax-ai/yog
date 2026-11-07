import { TRUNCATION_IDENTIFIER, type ToolResult } from "./types.ts";

/** Default /shake fallback budget for tools without their own truncators. */
export const FALLBACK_TRUNCATE_CHARS = 500;

/** Default tool-output budget (chars): the model must not crash its context
 *  window by reading an oversized file, fetching a huge webpage, etc. */
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
 * tail, replace the dropped middle with the global truncation marker. Applies
 * to any tool arg/result that lacks a bespoke truncator.
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
  if (json === undefined || json.length <= limit + grace) return result;
  return {
    truncated: middleTruncate(json, limit),
    originalLength: json.length,
  };
}
