/**
 * Terminal `turn.finished` emission for the engine's two stop paths: the
 * natural no-tool finish (stop reason omitted, context window attached)
 * and the max-rounds exhaustion (transcript already hydratable).
 */

import type { TurnEventDataMap, TurnEventType, TurnUsage } from "./sink.ts";

/** Everything the terminal emission needs (identity + accounting). */
export interface TurnTerminal {
  turnId: string;
  durationMs: number;
  usage: TurnUsage | undefined;
  rateLimitRetries: number;
}

/** Emit the natural-finish terminal (context window attached for clients). */
export function emitTurnFinished(
  emit: <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>,
  terminal: TurnTerminal,
  contextWindow: number | undefined,
): Promise<void> {
  return emit("turn.finished", {
    turnId: terminal.turnId,
    durationMs: terminal.durationMs,
    ...(terminal.usage !== undefined
      ? { usage: { ...terminal.usage, context_window: contextWindow } }
      : {}),
    ...(terminal.rateLimitRetries > 0 ? { rateLimitRetries: terminal.rateLimitRetries } : {}),
  });
}

/** Emit the max-rounds terminal (clean exhaustion: transcript stays hydratable). */
export function emitTurnMaxRounds(
  emit: <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>,
  terminal: TurnTerminal,
): Promise<void> {
  return emit("turn.finished", {
    turnId: terminal.turnId,
    durationMs: terminal.durationMs,
    ...(terminal.usage !== undefined ? { usage: terminal.usage } : {}),
    stopReason: "max_rounds",
    ...(terminal.rateLimitRetries > 0 ? { rateLimitRetries: terminal.rateLimitRetries } : {}),
  });
}
