/**
 * Live in-flight tool calls, keyed by session id — the abort endpoint's
 * kill target: kill the tool first, then unwind the turn. Entries are
 * stamped when a call is announced (stream) or starts (`onStart`), and
 * cleared when the call settles, the turn settles, or the operator asks.
 */

import type { AnnouncedCall } from "./stream-fold.ts";
import type { TrackedCall } from "./messages.ts";

/** Tool calls currently executing per session (for the abort endpoint). */
export const activeToolCalls = new Map<string, TrackedCall & AnnouncedCall>();

/**
 * The tool call currently executing (or last started without settling) for
 * `sessionId`, for the abort endpoint: kill the tool first, then unwind.
 */
export function activeToolCallFor(
  sessionId: string,
): { id: string; name: string; args: string } | undefined {
  return activeToolCalls.get(sessionId);
}

/** Drop the active-call tracking entry for `sessionId` (turn fully settled). */
export function clearActiveToolCall(sessionId: string): void {
  activeToolCalls.delete(sessionId);
}
