/**
 * Message envelope contract for the v1 messages channel.
 *
 * Clients POST one envelope to `POST /v1/sessions/{id}/messages` and the
 * server dispatches on `type` to a handler (see the `src/server/http/`
 * transport).
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
  "skills.list",
  "skills.load",
  "skills.unload",
  "skills.status",
  "jobs.get",
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

/** The shared failure shape every validation step returns. */
type EnvelopeError = { code: string; message: string };

/** Parse the body, rejecting blanks, bad JSON, and non-objects. */
function parseBodyObject(raw: string): Record<string, unknown> | EnvelopeError {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { code: "invalid_request", message: "message body must be a JSON object" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { code: "invalid_request", message: "message body must be a JSON object" };
  }
  if (!isRecord(parsed)) {
    return { code: "invalid_request", message: "message body must be a JSON object" };
  }
  return parsed;
}

/** Validate the envelope `type` field against the known message types. */
function envelopeTypeError(parsed: Record<string, unknown>): EnvelopeError | undefined {
  const type = parsed.type;
  if (typeof type !== "string" || type === "") {
    return { code: "invalid_request", message: "message type must be a non-empty string" };
  }
  if (!(MESSAGE_TYPES as readonly string[]).includes(type)) {
    return { code: "invalid_request", message: `unsupported message type: ${type}` };
  }
  return undefined;
}

/** Validate the optional `version` field (omitted means the server version). */
function envelopeVersionError(parsed: Record<string, unknown>): EnvelopeError | undefined {
  const version = parsed.version;
  if (version !== undefined && version !== MESSAGE_VERSION) {
    return {
      code: "invalid_request",
      message: `unsupported message version: ${String(version)}`,
    };
  }
  return undefined;
}

/** Validate the optional `requestId` field. */
function envelopeRequestIdError(parsed: Record<string, unknown>): EnvelopeError | undefined {
  const requestId = parsed.requestId;
  if (requestId !== undefined && typeof requestId !== "string") {
    return { code: "invalid_request", message: "requestId must be a string" };
  }
  return undefined;
}

/** Normalize the optional `data` field into a (possibly empty) record. */
function envelopeData(parsed: Record<string, unknown>): Record<string, unknown> | EnvelopeError {
  if (parsed.data === undefined) return {};
  if (!isRecord(parsed.data)) {
    return { code: "invalid_request", message: "message data must be a JSON object" };
  }
  return parsed.data;
}

export function parseEnvelope(
  raw: string,
): { envelope: MessageEnvelope } | { error: EnvelopeError } {
  const body = parseBodyObject(raw);
  if (!isRecord(body)) return { error: body };
  const parsed: Record<string, unknown> = body;
  const error =
    envelopeTypeError(parsed) ?? envelopeVersionError(parsed) ?? envelopeRequestIdError(parsed);
  if (error !== undefined) return { error };
  const data = envelopeData(parsed);
  return {
    envelope: {
      type: parsed.type as string,
      ...(parsed.version !== undefined ? { version: parsed.version as number } : {}),
      ...(typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {}),
      data,
    },
  };
}
