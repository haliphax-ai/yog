/**
 * Typed turn events and the transport-agnostic sink seam.
 *
 * The turn engine emits a self-describing envelope per event; the envelope
 * matches the ratified contract exactly, so any future transport adapter
 * (SSE, WebSocket, UDP, …) can forward it verbatim. The
 * engine awaits every `emit`, which is where backpressure falls out: a slow
 * transport throttles the turn. Sink implementations make no assumptions
 * about ordering, reliability, connection state, or latency.
 */

/** Envelope version for the ratified event payloads. Additive, optional fields
 * (e.g. `turn.finished.usage`) keep the version at 1 — older consumers ignore
 * them, and clients tolerate absent/malformed values. */
export const TURN_EVENT_VERSION = 1;
/**
 * Token usage reported by the model for a finished turn (OpenAI-compatible
 * `usage` shape). Absent when the provider sends none (or doesn't support
 * `include_usage`).
 */
export interface TurnUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Context window size for the session model (from models.dev). */
  context_window?: number;
  /**
   * Provider generation/request id for the round that reported this usage
   * (OpenRouter `gen-…`, OpenAI `req_…` when present). Captured verbatim so
   * post-hoc reconciliation (OpenRouter /generation) can audit the native
   * counts without any protocol-specific parsing here.
   */
  requestId?: string;
  /**
   * Native usage detail blocks, captured verbatim from the provider when
   * present. `prompt_tokens_details.cached_tokens` is the calibration
   * filter: reported counts on cache-warm rounds exclude the cached prefix,
   * so a naive fit against them under-counts ~2.5x. Capture-first:
   * interpretation lives in the calibrate script, not here.
   */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /**
   * Provider-reported cost (OpenRouter credits, dollars when present).
   * Absent on providers that do not report it; never computed locally.
   */
  cost?: number;
}

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
    /**
     * This round's real usage from the provider (present when the provider
     * reported usage for the round). Identical on every tool.result within a
     * round — the API does not segment tokens per call, so this is round
     * attribution, not per-call attribution. Supersedes the old equal-split
     * `tokens` estimate.
     */
    usage?: TurnUsage;
    /**
     * Context growth caused by this result: this round's prompt_tokens minus
     * the previous round's (i.e. what this round's call+result added to the
     * next request). Absent for the first round of a turn.
     */
    promptDelta?: number;
    /**
     * Estimated tokens this result adds to the conversation context (tokenx
     * estimate of the serialized tool message). Present on every result;
     * differs per call even inside a batch, unlike `usage`.
     */
    resultTokens?: number;
  };
  /** Normal end of the turn. */
  "turn.finished": {
    turnId: string;
    durationMs: number;
    stopReason?: string;
    usage?: TurnUsage;
    /**
     * Number of 429-triggered backoffs this turn went through before
     * finishing (one per `rate_limited` event). Absent when the provider
     * never rate-limited the turn.
     */
    rateLimitRetries?: number;
  };
  /**
   * Non-terminal: the provider returned 429 for the current round's
   * request and the engine is backing off before resubmitting the *same*
   * transcript. Emitted before each wait, so clients can show a
   * "rate limited, retrying in ..." notice instead of a silent stall.
   * The turn does not end here — `turn.finished` (or a terminal
   * `error` with code `rate_limited` after exhaustion) follows.
   */
  rate_limited: {
    /** 1-based ordinal of the failed request (1 = first try failed). */
    attempt: number;
    /** Total requests allowed for this round, initial try included. */
    maxAttempts: number;
    /** Upcoming backoff wait in milliseconds (server hint or exponential). */
    delayMs: number;
    /** Server-provided wait hint in ms (`Retry-After` / `retry-after-ms`), when sent. */
    retryAfterMs?: number;
    /** Server-provided reset hint in ms (`x-ratelimit-reset-*`), when sent. */
    resetMs?: number;
    /** 0-based tool-loop round whose request was rate-limited. */
    round: number;
    /** HTTP status from the provider (429). */
    status: number;
    /** Provider error message, when present. */
    providerMessage?: string;
  };
  /** Terminal error; the turn stops. `code` is `provider_error`, or
   * `rate_limited` when a 429 exhausted the retry policy. */
  error: {
    code: string;
    message: string;
    details?: unknown;
    /**
     * Last known turn usage when the turn died in an error
     * (error-path capture). A rejected request never produces a usage chunk
     * of its own, so this final anchor is what calibration and post-mortems
     * have — including the details blocks that separate cache-warm from
     * cache-cold counts. Absent when the provider never reported usage.
     */
    usage?: TurnUsage;
  };
  /** Terminal abort: the operator ended the turn (transcript was healed). */
  "turn.aborted": { reason: string };
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
