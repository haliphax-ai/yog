/**
 * SSE framing helpers for the v0 HTTP/SSE wire format.
 *
 * Each event envelope is emitted as a two-line frame followed by a blank
 * line:
 *
 * ```
 * event:<type>
 * data:<envelope-json>
 *
 * ```
 *
 * These helpers only serialize — the HTTP adapter owns writing to the
 * socket, so framing stays independently testable.
 */

/** Anything envelope-shaped: must carry a `type` used as the SSE event name. */
export interface SseEnvelope {
  type: string;
  [key: string]: unknown;
}

/**
 * Frame a single event envelope as an SSE block:
 * `event:<type>\ndata:<json>\n\n`. The full envelope (including `type`) is
 * serialized as the data payload so clients can recover from either the SSE
 * event name or the payload itself.
 */
export function encodeEvent(ev: SseEnvelope): string {
  return `event:${ev.type}\ndata:${JSON.stringify(ev)}\n\n`;
}

/**
 * Frame an event from a pre-serialized type + JSON payload string.
 * Lower-level sibling of {@link encodeEvent} for callers that already hold
 * the payload as JSON text (e.g. replaying persisted rows verbatim).
 */
export function encodeFrame(type: string, dataJson: string): string {
  return `event:${type}\ndata:${dataJson}\n\n`;
}

/** Frame an event from a type plus an arbitrary JSON-serializable payload. */
export function encodeFrameOf(type: string, data: unknown): string {
  return encodeFrame(type, JSON.stringify(data));
}
