/**
 * Typed turn events and the transport-agnostic sink seam.
 *
 * The turn engine emits a self-describing envelope per event (see PLAN.md
 * §5.4); the envelope matches the ratified contract exactly, so any future
 * transport adapter (SSE, WebSocket, UDP, …) can forward it verbatim. The
 * engine awaits every `emit`, which is where backpressure falls out: a slow
 * transport throttles the turn. Sink implementations make no assumptions
 * about ordering, reliability, connection state, or latency.
 */

/** Envelope version for the ratified event payloads. */
export const TURN_EVENT_VERSION = 1;

/** Per-event payload shapes, discriminated by the envelope's `type`. */
export type TurnEventDataMap = {
  /** Turn accepted; streaming begins. */
  "turn.started": { turnId: string; model: string; ts: number };
  /** Assistant text chunk — print as it arrives. */
  "message.delta": { text: string };
  /** Model invoked a tool (UIs can show status). */
  "tool.call": { id: string; name: string; args: string };
  /** Tool outcome. */
  "tool.result": {
    id: string;
    name: string;
    ok: boolean;
    result?: unknown;
    error?: string;
  };
  /** Normal end of the turn. */
  "turn.finished": { turnId: string; durationMs: number; stopReason?: string };
  /** Terminal error; the turn stops. */
  error: { code: string; message: string; details?: unknown };
};

/** Every semantic event name the turn engine can emit. */
export type TurnEventType = keyof TurnEventDataMap;

/** One envelope shape per event type, so `ev.type` narrows `ev.data`. */
interface TurnEventOf<T extends TurnEventType> {
  id: number;
  type: T;
  version: number;
  ts: number;
  data: TurnEventDataMap[T];
}

/**
 * Self-describing event envelope. `id` is monotonic within a turn, `version`
 * lets payloads evolve, `ts` is the server timestamp.
 */
export type TurnEvent<T extends TurnEventType = TurnEventType> = {
  [K in TurnEventType]: TurnEventOf<K>;
}[T];

/**
 * Transport-agnostic event sink. Resolves when the adapter has handed the
 * event off; the engine awaits it, so backpressure falls out naturally.
 */
export interface TurnSink {
  emit(ev: TurnEvent): Promise<void>;
}

/**
 * CLI sink: streams `message.delta` text to stdout byte-identically to the
 * engine's pre-sink output and writes the trailing newline when the turn
 * finishes. All other events are ignored (they belong to richer clients).
 */
export class StdoutSink implements TurnSink {
  async emit(ev: TurnEvent): Promise<void> {
    if (ev.type === "message.delta") {
      process.stdout.write(ev.data.text);
    } else if (ev.type === "turn.finished") {
      process.stdout.write("\n");
    }
  }
}

/** Test sink: captures the event sequence in arrival order. */
export class RecordingSink implements TurnSink {
  readonly events: TurnEvent[] = [];

  async emit(ev: TurnEvent): Promise<void> {
    this.events.push(ev);
  }
}
