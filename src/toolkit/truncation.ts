import { TRUNCATION_IDENTIFIER } from "./types.ts";

/** Default /shake fallback budget for tools without their own truncators. */
export const FALLBACK_TRUNCATE_CHARS = 500;

/**
 * Middle-truncate `text` to at most `max` characters: keep the head and the
 * tail, replace the dropped middle with the global truncation marker. Applies
 * to any tool arg/result that lacks a bespoke truncator.
 */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const markerLen = TRUNCATION_IDENTIFIER.length;
  const keep = Math.max(1, max - markerLen);
  const half = Math.floor(keep / 2);
  const headLen = half;
  const tailLen = keep - half;
  return text.slice(0, headLen) + TRUNCATION_IDENTIFIER + text.slice(text.length - tailLen);
}
