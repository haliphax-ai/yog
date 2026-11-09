/**
 * Message envelope contract for the v1 messages channel.
 *
 * Clients POST one envelope to `POST /v1/sessions/{id}/messages` and the
 * server dispatches on `type` to a handler (see `src/server/http.ts`).
 * Adding a feature means adding a `type` + handler — never a new HTTP route.
 *
 * Request:  `{ type, version?, requestId?, data? }`
 * Response: `{ type, version, requestId?, data }` or the shared
 *           `{ error: { code, message } }` envelope (with `requestId` echoed
 *           when the client supplied one).
 * Streaming types (`turn.start`) return `202 { accepted: true }` at once;
 * progress/terminal events arrive on the session stream
 * (`GET /v1/sessions/{id}/stream`) correlated by their domain ids.
 */

/** Envelope version understood by this server. Omitted means 1. */
export const MESSAGE_VERSION = 1;

/** Every message `type` the messages channel dispatches. */
export const MESSAGE_TYPES = [
  "session.get",
  "session.detach",
  "transcript.get",
  "turn.get",
  "turn.abort",
  "turn.start",
  "compaction.run",
  "transcript.shake",
] as const;

export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Client → server envelope. `data` carries the per-type payload. */
export interface MessageEnvelope {
  type: string;
  version?: number;
  requestId?: string;
  data?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse + validate a raw request body into an envelope.
 * Returns `{ envelope }` or `{ error }` with a stable error code/message.
 */
export function parseEnvelope(
  raw: string,
): { envelope: MessageEnvelope } | { error: { code: string; message: string } } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { error: { code: "invalid_request", message: "message body must be a JSON object" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: { code: "invalid_request", message: "message body must be a JSON object" } };
  }
  if (!isRecord(parsed)) {
    return { error: { code: "invalid_request", message: "message body must be a JSON object" } };
  }
  const type = parsed.type;
  if (typeof type !== "string" || type === "") {
    return {
      error: { code: "invalid_request", message: "message type must be a non-empty string" },
    };
  }
  if (!(MESSAGE_TYPES as readonly string[]).includes(type)) {
    return { error: { code: "invalid_request", message: `unsupported message type: ${type}` } };
  }
  const version = parsed.version;
  if (version !== undefined && version !== MESSAGE_VERSION) {
    return {
      error: {
        code: "invalid_request",
        message: `unsupported message version: ${String(version)}`,
      },
    };
  }
  const requestId = parsed.requestId;
  if (requestId !== undefined && typeof requestId !== "string") {
    return { error: { code: "invalid_request", message: "requestId must be a string" } };
  }
  let data: Record<string, unknown> = {};
  if (parsed.data !== undefined) {
    if (!isRecord(parsed.data)) {
      return { error: { code: "invalid_request", message: "message data must be a JSON object" } };
    }
    data = parsed.data;
  }
  return {
    envelope: {
      type,
      ...(typeof version === "number" ? { version } : {}),
      ...(typeof requestId === "string" ? { requestId } : {}),
      data,
    },
  };
}
