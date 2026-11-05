import { TRUNCATION_IDENTIFIER } from "./types.ts";

/** Default /shake fallback budget for tools without their own truncators. */
export const FALLBACK_TRUNCATE_CHARS = 500;

/** Chars-per-token heuristic for estimating context size (chars / 4). */
export function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
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
