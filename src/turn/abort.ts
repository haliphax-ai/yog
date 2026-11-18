/**
 * The engine's abort error shape, shared by the drain driver (mid-stream
 * tear-down) and the unwind path. Mirrors the orchestrator's normalization:
 * an `Error` reason passes through; anything else becomes an `AbortError`
 * (the caller's terminal-abort framing keys off the name).
 */

/** Make an abort-shaped error (mirrors the orchestrator's normalization). */
export function makeAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined || reason === null ? "turn aborted" : String(reason));
  err.name = "AbortError";
  return err;
}
