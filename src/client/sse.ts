/**
 * Fetch-based SSE reader.
 *
 * The server adapter frames each event as `event:<type>\ndata:<json>\n\n`
 * (see `src/server/sse.ts`); this reader is the client-side counterpart. It
 * walks the response body incrementally, splits frames on blank lines, and
 * dispatches each parsed envelope to `handlers.onEvent`, signalling `onEnd`
 * when the stream closes cleanly and `onError` when it dies mid-frame.
 *
 * Only the contract-shaped `TurnEvent` envelope type is imported (type-only);
 * this module knows nothing about server internals.
 */
import type { TurnEvent } from "../turn/sink.ts";

/** Callbacks a caller can register for the events of one SSE stream. */
export interface SseHandlers {
  /** Called once per parsed envelope, in arrival order. */
  onEvent?: (ev: TurnEvent) => void;
  /** Called when the server closed the stream cleanly. */
  onEnd?: () => void;
  /** Called when the stream died before a clean end (network failure). */
  onError?: (err: Error) => void;
}

/** One SSE frame, split into its `event:` name and raw `data:` payload(s). */
interface ParsedFrame {
  event: string;
  data: string;
}

/**
 * Parse one raw SSE block (text between blank lines) into its fields.
 * `data:` lines are concatenated with newlines per the SSE spec; unknown
 * fields (id:, retry:, comments) are tolerated and ignored.
 */
function parseFrame(block: string): ParsedFrame | undefined {
  let event = "";
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r\n|\r|\n/)) {
    if (rawLine === "" || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    let value = colon === -1 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (event === "" && dataLines.length === 0) return undefined;
  return { event, data: dataLines.join("\n") };
}

/** Coerce anything into an Error (fetch aborts may hand us non-Errors). */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Decode one parsed frame into a `TurnEvent` envelope, tolerating unknown
 * event names: the payload is authoritative when it is itself an envelope,
 * otherwise the SSE event name fills in the `type`.
 */
function toEnvelope(frame: ParsedFrame): TurnEvent | undefined {
  let payload: unknown;
  try {
    payload = frame.data === "" ? undefined : JSON.parse(frame.data);
  } catch {
    return undefined; // malformed JSON — skip the frame, keep reading
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const obj = payload as Record<string, unknown>;
  if (typeof obj["type"] !== "string") {
    if (frame.event === "") return undefined;
    return { ...obj, type: frame.event } as unknown as TurnEvent;
  }
  if (obj["type"] === frame.event || frame.event === "") {
    return obj as unknown as TurnEvent;
  }
  // Conflicting name vs payload: trust the payload (self-describing).
  return { ...obj, type: obj["type"] } as unknown as TurnEvent;
}

/**
 * Read an SSE stream from a fetch `Response` (or a web-compatible stream)
 * until it ends, dispatching frames to `handlers`.
 *
 * Resolves when the stream is fully consumed (then `onEnd` fires); calls
 * `onError` if the body dies mid-stream. Handler callbacks are invoked as
 * frames arrive, so callers can stream output incrementally. A frame with an
 * unknown event name or an unparseable payload is skipped, not fatal.
 */
export async function readSseStream(res: Response, handlers: SseHandlers): Promise<void> {
  const body = res.body;
  if (!body) {
    handlers.onError?.(new Error("response has no body"));
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.search(/\r\n\r\n|\n\n|\r\r/)) !== -1) {
        const match = buf.slice(sep).match(/^\r\n\r\n|^\n\n|^\r\r/);
        const sepLen = match ? match[0].length : 2;
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + sepLen);
        const frame = parseFrame(block);
        if (!frame) continue;
        const envelope = toEnvelope(frame);
        if (envelope) handlers.onEvent?.(envelope);
      }
    }
    // Flush a trailing frame the server forgot to terminate with a blank line.
    if (buf.trim() !== "") {
      const frame = parseFrame(buf);
      const envelope = frame ? toEnvelope(frame) : undefined;
      if (envelope) handlers.onEvent?.(envelope);
    }
    handlers.onEnd?.();
  } catch (err) {
    handlers.onError?.(toError(err));
  }
}
