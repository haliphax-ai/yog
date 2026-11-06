import { TRUNCATION_IDENTIFIER } from "./types.ts";

/** Default /shake fallback budget for tools without their own truncators. */
export const FALLBACK_TRUNCATE_CHARS = 500;

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
