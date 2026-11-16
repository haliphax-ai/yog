import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { CommandDescriptor } from "../commands.ts";
import type { CompactionBoundary } from "../compaction.ts";
import type { ServerResponse } from "node:http";
import type { ShakeOutcome } from "../shake.ts";
import type { SseEnvelope } from "../sse.ts";

/** Capabilities advertisement served at GET /v1/capabilities. */
export interface Capabilities {
  contractVersion: string | number;
  models: string[];
  tools: string[];
  features: string[];
  messageTypes?: string[];
  /** Slash commands a client may surface for this daemon (what a human
   *  would type after "/"); presence here IS availability — no separate
   *  feature flags for invocable commands. */
  commands?: CommandDescriptor[];
  [key: string]: unknown;
}

export interface SessionRecord {
  id: string;
  status: "open" | "dormant";
  created_at: number;
  updated_at: number;
  detached_at?: number | null;
}

export interface StoreBoundary {
  createSession(opts?: { title?: string; system?: string }): unknown;
  getSession(id: string): unknown;
  detachSession(id: string, detachedAt?: string | number): unknown;
  reviveSession?(id: string): unknown;
  purgeSession?(id: string): number;
  addTurn?(
    sessionId: string,
    turn: { role: string; content: string; status: string; model?: string },
  ): unknown;
  addEvent?(sessionId: string, event: { type: string; payload: string; version?: number }): unknown;
  listTurns?(sessionId: string): unknown[];
  listEvents?(sessionId: string): unknown[];
  getTranscript?(
    sessionId: string,
    opts?: { afterSeq?: number; limit?: number },
  ): Array<ChatCompletionMessageParam & { seq: number; turnId: number | null; ts: number }>;
  appendMessages?(
    sessionId: string,
    msgs: ChatCompletionMessageParam[],
    turnId?: number | null,
  ): unknown[];
  /** Settle a turn row (status + finished_at + duration). */
  finishTurn?(sessionId: string, turnId: number | null, status?: string, usage?: unknown): unknown;
  /** Per-turn metrics for the transcript dump. */
  listTurnUsages?(
    sessionId: string,
  ): Promise<Array<{ turnId: number; usage?: unknown; durationMs?: number }>>;
  /** The session's live usage snapshot (as-of-the-last-known-point). */
  onUsageFor?(sessionId: string): unknown;
}

/** Handle returned by `orchestrator.runTurn` (see SessionOrchestrator). */
export interface TurnHandleLike {
  promise: Promise<unknown>;
  abort: (reason?: unknown) => void;
}

/** Minimal orchestrator boundary the adapter drives for a turn. */
export interface OrchestratorBoundary {
  runTurn(sessionId: string, req: Record<string, unknown>): TurnHandleLike;
  /** Abort the session's current turn; false when no turn is live. */
  abortTurn?(
    sessionId: string,
    killTool?: (sessionId: string) => Promise<boolean> | boolean,
  ): Promise<boolean>;
}

/** Minimal per-daemon event bus boundary (a Node `EventEmitter`). */
export interface EventBusBoundary {
  on(event: string, listener: (ev: SseEnvelope) => void): unknown;
  off(event: string, listener: (ev: SseEnvelope) => void): unknown;
}

/** Minimal model-provider boundary the adapter drives for a turn. */
export interface ModelBoundary {
  runTurn(
    sessionId: string,
    req: Record<string, unknown>,
    ctx: { emit: (ev: SseEnvelope) => Promise<void>; signal?: AbortSignal },
  ): Promise<unknown>;
}

/**
 * Injected dependencies. Fields are optional so tests can fake any boundary;
 * the index signature keeps the seam open for store/orchestrator/factory deps.
 */

export interface HttpDeps {
  /** Resolve the context window for an arbitrary model id (models.dev cache). */
  contextWindowFor?: (model: string) => number | undefined;
  capabilities?: Capabilities;
  model?: ModelBoundary;
  store?: StoreBoundary | unknown;
  orchestrator?: OrchestratorBoundary | unknown;
  /** Usage captured as of a terminal cut, keyed by session id. */
  onUsageFor?: (sessionId: string) => unknown;
  /** Per-daemon event bus: executeTurn publishes, this adapter subscribes. */
  bus?: EventBusBoundary | unknown;
  createTurnEngine?: unknown;
  /** Bearer token gate (config `apiToken`); unset = auth disabled. */
  apiToken?: string;
  /** Compaction/handoff runner (see `compaction.ts`). */
  compaction?: CompactionBoundary;
  /** Transcript shake runner (see `shake.ts`). */
  shake?: (sessionId: string) => Promise<ShakeOutcome>;
  /**
   * Session used for skills commands when the request does not name one
   * (defaults to the manager's `"daemon"` session). The daemon injects the
   * session id from the URL (`/v1/sessions/{id}/messages`).
   */
  skillsSessionId?: string;
  [key: string]: unknown;
}

/**
 * Per-daemon session resolvers for the extracted message handlers: the
 * optional store, the in-memory fallback map, and a bound session lookup
 * (store-preferred, map-fallback) — the state `dispatchMessage` reads and
 * mutates on the handlers' behalf.
 */
export interface SessionResolvers {
  store: StoreBoundary | undefined;
  sessions: Map<string, SessionRecord>;
  lookupSession: (id: string) => Promise<SessionRecord | null>;
}

/**
 * Per-request reply context for the extracted message handlers: the raw
 * response plus the pre-bound success (`reply`) and failure (`fail`) senders
 * of `dispatchMessage`, so helpers never touch the envelope framing.
 */
export interface MsgCtx {
  type: string;
  id: string;
  data: Record<string, unknown>;
  res: ServerResponse;
  requestId: string | undefined;
  reply(status: number, payload: unknown): void;
  fail(code: string, message: string): void;
}

/** Per-turn round attribution carried into the transcript dump. */
export interface RoundAttribution {
  usage?: unknown;
  promptDelta?: number;
}

/**
 * Everything the module-level adapter handlers share from the factory
 * closure: injected boundaries, the derived capability projection, and the
 * per-daemon mutable state (in-memory sessions, bound streams). Handlers
 * take `st` as their first parameter so the transport logic stays
 * module-level and independently smell-checkable.
 */
export interface AdapterState {
  readonly deps: HttpDeps;
  readonly apiToken: string | undefined;
  readonly capabilities: Capabilities;
  readonly sessions: Map<string, SessionRecord>;
  readonly store: StoreBoundary | undefined;
  readonly orchestrator: OrchestratorBoundary | undefined;
  readonly bus: EventBusBoundary;
  readonly hasStore: boolean;
  readonly hasOrchestrator: boolean;
  readonly turnsByStream: Map<
    string,
    Array<{ handle?: TurnHandleLike; controller?: AbortController }>
  >;
}

/**
 * Terminal-synthesis context for `finishTurnError`: the pre-bound persist
 * and stream emitters, the settle hook, the abort frame, and the usage
 * cut. Built by `startTurn` per turn.
 */
export interface TurnEmitCtx {
  readonly persistEvent: (ev: SseEnvelope) => Promise<void>;
  readonly emitToStream: (ev: SseEnvelope) => Promise<void>;
  readonly settleTurn: (status: string) => Promise<void>;
  readonly emitTurnAborted: (err: unknown, usage: unknown) => Promise<void>;
  readonly cutUsage: () => unknown;
  readonly sawError: () => boolean;
  readonly turnStarted: () => boolean;
}

/**
 * Settle a failed orchestrator turn: frame the adapter-synthesized terminal
 * (`turn.aborted` on abort, `provider_error` error otherwise) so
 * `turn.get` replays it even when the engine never emitted, and settle the
 * row as `aborted` / `error`.
 */
