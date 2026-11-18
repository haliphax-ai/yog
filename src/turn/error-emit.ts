/**
 * Terminal `error` emission for the engine's unwind path: the transcript
 * was healed by the caller; this frames the failure for transports (the
 * composition root keeps its exit-code handling by rethrowing after).
 */

import type { TurnEventDataMap, TurnEventType, TurnUsage } from "./sink.ts";

/**
 * Emit the terminal `error` event: `rate_limited` when a 429 exhausted
 * the retry policy, `provider_error` otherwise, with the last known
 * usage attached (capture-first on the error path too: the last known
 * round usage is the freshest native anchor a failed turn has — rejected
 * requests never yield a usage chunk of their own).
 */
export function emitTurnError(
  emit: <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>,
  err: unknown,
  isRateLimitError: (e: unknown) => boolean,
  lastUsage: TurnUsage | undefined,
): Promise<void> {
  return emit("error", {
    code: isRateLimitError(err) ? "rate_limited" : "provider_error",
    message: err instanceof Error ? err.message : String(err),
    ...(err instanceof Error ? { details: { name: err.name, stack: err.stack } } : {}),
    ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
  });
}
