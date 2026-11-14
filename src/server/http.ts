import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { encodeEvent, type SseEnvelope } from "./sse.ts";
import { MESSAGE_TYPES, parseEnvelope, type MessageEnvelope } from "./messages.ts";
import { activeToolCallFor, toolStubMessage, unansweredToolCallIds } from "../turn.ts";
import { logger } from "../log.ts";
import type { CompactionBoundary, CompactionKind } from "./compaction.ts";
import type { ShakeOutcome } from "./shake.ts";
import type { SkillManager } from "../skills/index.ts";
import type { CommandDescriptor } from "./commands.ts";
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

/** Session record tracked by the adapter (in-memory; store remains injectable). */
export interface SessionRecord {
  id: string;
  status: "open" | "dormant";
  created_at: number;
  updated_at: number;
  detached_at?: number | null;
}

/** Minimal store boundary the adapter drives (real `SessionStore`). */
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
  /** Per-turn metrics for the transcript dump (§R1.3). */
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

/** Machine-readable error codes (PLAN §5.5) with HTTP status mapping. */
const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  unknown_model: 400,
  unknown_session: 404,
  unauthorized: 401,
  provider_error: 502,
  rate_limited: 429,
  internal: 500,
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, code: string, message: string): void {
  sendJson(res, ERROR_STATUS[code] ?? 500, { error: { code, message } });
}

function sendErrorWithRequestId(
  res: ServerResponse,
  code: string,
  message: string,
  requestId: string | undefined,
): void {
  const status = ERROR_STATUS[code] ?? 500;
  sendJson(res, status, {
    ...(requestId !== undefined ? { requestId } : {}),
    error: { code, message },
  });
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Split `/v1/...` path into segments (query string stripped). */
function segments(url: string): string[] {
  const path = url.split("?")[0] ?? "";
  return path.split("/").filter(Boolean);
}

/** Coerce a store row (sqlite) into the adapter's session shape. */
function normalizeSession(row: unknown): SessionRecord {
  const rec = (row ?? {}) as Record<string, unknown>;
  const status = rec.status === "dormant" ? "dormant" : "open";
  return {
    ...rec,
    id: String(rec.id ?? ""),
    status,
    created_at: Number(rec.created_at ?? Date.now()),
    updated_at: Number(rec.updated_at ?? Date.now()),
    detached_at: (rec.detached_at as number | null | undefined) ?? null,
  } as SessionRecord;
}

/**
 * §4.6 wire shape for one transcript message: the store's snake_case columns
 * (`tool_call_id`, `tool_calls`) become camelCase (`toolCallId`, `toolCalls`);
 * only the contract's known keys cross the boundary. The store itself stays
 * snake_case — its rows feed the model hydrate (OpenAI message shape) — the
 * conversion is a route-layer concern. Round attribution on tool result rows
 * (`usage`, `promptDelta`) is forwarded when present, matching the live
 * `tool.result` envelope so rehydration renders the same counts.
 */
function toWireMessage(m: unknown): Record<string, unknown> {
  const row = (m ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["seq", "turnId", "ts", "role", "content", "name"] as const) {
    if (key in row) out[key] = row[key];
  }
  if (row.tool_call_id !== undefined) out.toolCallId = row.tool_call_id;
  if (row.tool_calls !== undefined) out.toolCalls = row.tool_calls;
  if (row.usage !== undefined) out.usage = row.usage;
  if (row.promptDelta !== undefined) out.promptDelta = row.promptDelta;
  if (row.resultTokens !== undefined) out.resultTokens = row.resultTokens;
  return out;
}

/** Stored usage columns on a turn row (numeric and finite), or undefined. */
function turnUsageFromRow(row: Record<string, unknown>): Record<string, number> | undefined {
  const usage: Record<string, number> = {};
  let has = false;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const n = row[key];
    if (typeof n === "number" && Number.isFinite(n)) {
      usage[key] = n;
      has = true;
    }
  }
  return has ? usage : undefined;
}

/** Usage embedded in a stored terminal event payload (recovery fallback). */
function turnUsageFromEvents(events: unknown[]): Record<string, number> | undefined {
  for (const raw of events) {
    const ev = raw as { type?: string; data?: unknown };
    if (ev.type !== "turn.finished" && ev.type !== "turn.aborted" && ev.type !== "error") continue;
    const data = ev.data as { usage?: unknown } | undefined;
    const u = data?.usage;
    if (u === null || typeof u !== "object" || Array.isArray(u)) continue;
    const rec = u as Record<string, unknown>;
    const usage: Record<string, number> = {};
    let has = false;
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
      const n = rec[key];
      if (typeof n === "number" && Number.isFinite(n)) {
        usage[key] = n;
        has = true;
      }
    }
    if (has) return usage;
  }
  return undefined;
}
/**
 * Heal a fallback-path transcript in place: stub every tool call the
 * messages announce but never answer, so the batch persisted on error
 * stays hydratable (the engine heals the orchestrator path the same way;
 * providers reject dangling calls). Prior turns are already answered,
 * so this only stubs this turn's dangling calls.
 */
function healFallbackMessages(messages: ChatCompletionMessageParam[]): void {
  const heal: ChatCompletionMessageParam[] = [...unansweredToolCallIds(messages)].map(
    (toolCallId) => toolStubMessage(toolCallId),
  );
  if (heal.length > 0) messages.push(...heal);
}

/**
 * Create the v1 messages/stream adapter (PLAN §5.2–§5.5). All boundaries are
 * injected so tests can fake the store, orchestrator, event bus, model
 * provider and turn-engine factory.
 *
 * HTTP surface (four routes only — everything else is a message `type`):
 *   GET  /v1/capabilities               bootstrap discovery
 *   POST /v1/sessions                   bootstrap session creation
 *   GET  /v1/sessions/{id}/stream       long-lived SSE event channel
 *   POST /v1/sessions/{id}/messages     typed message dispatch
 */
export function createHttpServer(deps: HttpDeps): Server {
  // Per-daemon configuration injection (see `config.ts`): the bearer token
  // gate. It lives in this factory's closure — concurrent daemons (tests)
  // never share it.
  const apiToken = typeof deps.apiToken === "string" ? deps.apiToken : undefined;

  /** Bearer-token gate for the contract; unset = auth disabled. */
  const checkAuth = (req: IncomingMessage): boolean => {
    if (!apiToken) return true;
    const header = req.headers.authorization ?? "";
    return header === `Bearer ${apiToken}`;
  };
  // Injected capabilities (models/tools) win, but the transport contract
  // (`messages` + `stream` features and the `messageTypes` list) is owned
  // here — it is always advertised so clients can discover the dispatch
  // table. The composition root (serve.ts) passes the same set explicitly.
  // `commands` defaults to an empty list, never undefined, so a client can
  // always iterate the user-facing projection.
  const baseCapabilities: Capabilities = {
    commands: [],
    ...(deps.capabilities ?? {
      contractVersion: "v1",
      models: [],
      tools: [],
      features: [],
    }),
  };
  const features = [...new Set(["messages", "stream", ...baseCapabilities.features])];
  const messageTypes = [...new Set([...MESSAGE_TYPES, ...(baseCapabilities.messageTypes ?? [])])];
  const capabilities: Capabilities = { ...baseCapabilities, features, messageTypes };
  const sessions = new Map<string, SessionRecord>();
  const store = deps.store as StoreBoundary | undefined;
  const orchestrator = deps.orchestrator as OrchestratorBoundary | undefined;
  // Fall back to a local bus when none is injected (store-less fakes):
  // the fallback turn path publishes here and streams subscribe here, so
  // delivery works without serve.ts's composed bus.
  const bus =
    (deps.bus as EventBusBoundary | undefined) ??
    ((): EventEmitter => {
      const ee = new EventEmitter();
      ee.setMaxListeners(0);
      return ee;
    })();
  const hasStore = !!store && typeof store.createSession === "function";
  const hasOrchestrator = !!orchestrator && typeof orchestrator.runTurn === "function";

  /** Turns started with `abortOnDisconnect: true`, keyed by stream id. */
  const turnsByStream = new Map<
    string,
    Array<{ handle?: TurnHandleLike; controller?: AbortController }>
  >();
  const channelFor = (id: string): string => `session:${id}`;
  const publish = (sessionId: string, ev: SseEnvelope): void => {
    // The bus boundary only exposes on/off; EventEmitter-style emit is used
    // when the injected bus is an EventEmitter (serve.ts/tests). No bus
    // (store-less fakes) means no stream delivery — turns still settle.
    (bus as unknown as { emit?: (ch: string, ev: SseEnvelope) => void } | undefined)?.emit?.(
      channelFor(sessionId),
      ev,
    );
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      sendError(res, "internal", err instanceof Error ? err.message : String(err));
    });
  });

  /** Look a session up in the store (preferred) or the in-memory fallback. */
  async function lookupSession(id: string): Promise<SessionRecord | null> {
    if (hasStore) {
      const row = await store!.getSession(id);
      return row ? normalizeSession(row) : null;
    }
    return sessions.get(id) ?? null;
  }

  function sendMessage(
    res: ServerResponse,
    status: number,
    type: string,
    data: unknown,
    requestId: string | undefined,
  ): void {
    sendJson(res, status, {
      type,
      version: 1,
      ...(requestId !== undefined ? { requestId } : {}),
      data,
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const segs = segments(req.url ?? "/");

    if (!checkAuth(req)) {
      sendError(res, "unauthorized", "missing or invalid bearer token");
      return;
    }

    // GET /v1/capabilities — bootstrap discovery (unchanged).
    if (method === "GET" && segs[0] === "v1" && segs[1] === "capabilities" && segs.length === 2) {
      // The client names the model it will use (`?model=`); the server
      // resolves that model's context window from the models.dev cache. A
      // request without `?model=` gets the plain advertisement.
      const model = new URL(req.url ?? "", "http://localhost").searchParams.get("model");
      if (
        typeof model === "string" &&
        model !== "" &&
        typeof deps.contextWindowFor === "function"
      ) {
        const cw = deps.contextWindowFor(model);
        sendJson(res, 200, {
          ...capabilities,
          contextWindowSizes: cw === undefined ? {} : { [model]: cw },
        });
        return;
      }
      sendJson(res, 200, capabilities);
      return;
    }

    // POST /v1/agent-cli — CLI command dispatch (agent shim).
    if (method === "POST" && segs[0] === "v1" && segs[1] === "agent-cli" && segs.length === 2) {
      let body: Record<string, unknown> = {};
      try {
        const raw = await readBody(req);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain");
        res.end("invalid request body: must be a JSON object");
        return;
      }
      const cmd = body.command;
      const args = body.args;
      if (typeof cmd !== "string" || !cmd) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain");
        res.end("invalid request: command must be a non-empty string");
        return;
      }
      if (args !== undefined && !Array.isArray(args)) {
        res.statusCode = 400;
        res.setHeader("content-type", "text/plain");
        res.end("invalid request: args must be an array");
        return;
      }
      const { getCommand } = await import("../server/cli.ts");
      const command = getCommand(cmd);
      if (!command) {
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain");
        res.end(`unknown command: ${cmd}\n`);
        return;
      }
      try {
        const output = await command.execute((args as string[]) ?? []);
        res.statusCode = 200;
        res.setHeader("content-type", "text/plain");
        res.end(output);
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("content-type", "text/plain");
        res.end(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      }

      return;
    }

    if (segs[0] !== "v1") {
      sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
      return;
    }

    // POST /v1/sessions — bootstrap creation (unchanged).
    if (method === "POST" && segs.length === 2 && segs[1] === "sessions") {
      // Body is optional: `{ title?, system? }` (§4.6). `system` seeds the
      // first transcript message (role `system`) so it is part of every
      // turn's hydrate. Read it up front so the store path can honor it.
      let body: Record<string, unknown> = {};
      try {
        const raw = await readBody(req);
        const parsed: unknown = raw ? JSON.parse(raw) : {};
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        sendError(res, "invalid_request", "request body must be a JSON object");
        return;
      }
      if (body.title !== undefined && typeof body.title !== "string") {
        sendError(res, "invalid_request", "title must be a string");
        return;
      }
      if (body.system !== undefined && typeof body.system !== "string") {
        sendError(res, "invalid_request", "system must be a string");
        return;
      }

      if (hasStore) {
        const row = await store!.createSession({
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.system === "string" ? { system: body.system } : {}),
        });
        if (!row) {
          sendError(res, "internal", "session store failed to create a session");
          return;
        }
        sendJson(res, 201, { session: normalizeSession(row) });
        return;
      }
      const now = Date.now();
      const session: SessionRecord = {
        id: randomUUID(),
        status: "open",
        created_at: now,
        updated_at: now,
        ...(typeof body.title === "string" ? { title: body.title } : {}),
      };
      sessions.set(session.id, session);
      sendJson(res, 201, { session });
      return;
    }

    // /v1/sessions/{id}/stream | /messages
    if (segs[1] === "sessions" && segs.length === 4) {
      const id = segs[2] as string;
      const leaf = segs[3] as string;
      if (leaf === "stream" && method === "GET") {
        await streamSession(req, res, id);
        return;
      }
      if (leaf === "messages" && method === "POST") {
        await dispatchMessage(req, res, id);
        return;
      }
      sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
      return;
    }

    sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
  }

  /** POST /v1/sessions/{id}/messages — typed dispatch. */
  async function dispatchMessage(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const session0 = await lookupSession(id);
    if (!session0) {
      sendError(res, "unknown_session", `session ${id} not found`);
      return;
    }
    let envelope: MessageEnvelope;
    try {
      const raw = await readBody(req);
      const parsed = parseEnvelope(raw);
      if ("error" in parsed) {
        sendError(res, parsed.error.code, parsed.error.message);
        return;
      }
      envelope = parsed.envelope;
    } catch {
      sendError(res, "invalid_request", "request body must be a JSON object");
      return;
    }
    const { type, requestId } = envelope;
    const data = envelope.data ?? {};
    // Handlers below mirror the former per-feature routes. `session` is a
    // `let` so turn.start's implicit revive can refresh it.
    let session = session0;
    const reply = (status: number, payload: unknown): void =>
      sendMessage(res, status, type, payload, requestId);
    const fail = (code: string, message: string): void =>
      sendErrorWithRequestId(res, code, message, requestId);

    if (type === "session.get") {
      reply(200, { session });
      return;
    }

    if (type === "session.detach") {
      if (data.purge !== undefined && typeof data.purge !== "boolean") {
        fail("invalid_request", "purge must be a boolean");
        return;
      }
      const purge = data.purge === true;
      if (purge) {
        // Immediate irreversible delete (§4.5). After this the session
        // row is gone: subsequent messages all hit 404 unknown_session.
        if (hasStore && typeof store!.purgeSession === "function") {
          const deleted = await store!.purgeSession(id);
          if (deleted === 0) {
            fail("unknown_session", `session ${id} not found`);
            return;
          }
          reply(200, { ok: true, deleted: true, id });
          return;
        }
        // In-memory fallback: purge is a hard delete.
        sessions.delete(id);
        reply(200, { ok: true, deleted: true, id });
        return;
      }
      // Detach (§4.5): status open → dormant, detached_at stamped,
      // nothing forfeited. Idempotent — a second detach on an already
      // dormant session is a no-op and still returns success.
      if (session.status === "open") {
        if (hasStore && typeof store!.detachSession === "function") {
          await store!.detachSession(id, Date.now());
          const detached = await lookupSession(id);
          reply(200, { session: detached ?? { ...session, status: "dormant" } });
          return;
        }
        session.status = "dormant";
        session.detached_at = Date.now();
        session.updated_at = session.detached_at;
      }
      reply(200, { session });
      return;
    }

    if (type === "transcript.get") {
      // transcript.get — the rehydration dump (§4.6). Readable while the
      // row exists, including dormant sessions within the 30-day
      // retention window; dormancy never blocks reads.
      if (hasStore && typeof store!.getTranscript === "function") {
        const afterRaw = (data.afterSeq ?? data.after) as unknown;
        const limitRaw = data.limit as unknown;
        const afterSeq = afterRaw !== undefined ? Number(afterRaw) : undefined;
        const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
        // Round attribution for tool result rows comes from the turns'
        // persisted tool.result events (the live envelope data), so the
        // dump carries the same usage/promptDelta the stream did. One
        // attribution round per turn: all results of a round share it.
        // Per-call resultTokens are keyed by tool call id instead — each
        // result's own estimate rides its own row.
        const attribution = new Map<number, { usage?: unknown; promptDelta?: number }>();
        const resultTokensByCall = new Map<string, number>();
        if (typeof store!.listEvents === "function") {
          for (const ev of ((await store!.listEvents(id)) ?? []) as Array<
            Record<string, unknown>
          >) {
            if (ev.type !== "tool.result") continue;
            const turnId = Number(ev.turn_id);
            let data: any = ev.payload;
            if (typeof data === "string") {
              try {
                data = JSON.parse(data);
              } catch {
                continue; // skip unparseable rows
              }
            }
            if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
            const usage = (data as any).usage;
            const promptDelta = (data as any).promptDelta;
            const resultTokens = (data as any).resultTokens;
            const round: { usage?: unknown; promptDelta?: number } = {};
            if (usage !== undefined) round.usage = usage;
            if (typeof promptDelta === "number" && Number.isFinite(promptDelta)) {
              round.promptDelta = promptDelta;
            }
            if (Object.keys(round).length > 0) attribution.set(turnId, round);
            if (
              typeof resultTokens === "number" &&
              Number.isFinite(resultTokens) &&
              resultTokens > 0
            ) {
              resultTokensByCall.set(String(data.id), resultTokens);
            }
          }
        }
        const messages = (
          await store!.getTranscript(id, {
            ...(afterSeq !== undefined && Number.isFinite(afterSeq) ? { afterSeq: afterSeq } : {}),
            ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
            ...(attribution.size > 0 ? { roundAttribution: attribution } : {}),
            ...(resultTokensByCall.size > 0 ? { resultTokensByCall } : {}),
          })
        ).map(toWireMessage);
        // In-flight (running) turns have no canonical transcript rows yet:
        // serve.ts only appends `messages.slice(startLen)` at settle time.
        // A reconnecting client polling this dump would therefore see only
        // the previous turn while the in-flight turn generates, and the
        // poll gate on usage meant nothing landed even after settle for
        // the duplicate adapter row. Reconstruct the running turn's
        // completed rounds from its persisted `turn_events` (the sink
        // records every event incrementally) and append them as synthetic
        // transcript rows so a poll rehydrates the in-flight turn
        // progressively. Settled turns use the real rows above and get
        // no synthetic duplicates.
        if (typeof store!.listTurns === "function") {
          const rowsForSynthetic = ((await store!.listTurns(id)) ?? []) as Array<
            Record<string, unknown>
          >;
          const runningRows = rowsForSynthetic.filter((r) => r.status === "running");
          if (runningRows.length > 0 && typeof store!.listEvents === "function") {
            const allEvents = ((await store!.listEvents(id)) ?? []) as Array<
              Record<string, unknown>
            >;
            const eventsByTurn = new Map<number, Array<Record<string, unknown>>>();
            for (const ev of allEvents) {
              const tid = Number(ev.turn_id);
              if (!Number.isFinite(tid)) continue;
              const list = eventsByTurn.get(tid) ?? [];
              list.push(ev);
              eventsByTurn.set(tid, list);
            }
            let nextSeq =
              messages.reduce((max, m) => Math.max(max, typeof m.seq === "number" ? m.seq : 0), 0) +
              1;
            for (const r of runningRows) {
              const turnId = Number(r.id);
              const evs = eventsByTurn.get(turnId) ?? [];
              if (evs.length === 0) continue;
              const synth: Array<Record<string, unknown>> = [];
              const parsePayload = (ev: Record<string, unknown>): Record<string, unknown> => {
                let data: unknown = ev.payload;
                if (typeof data === "string") {
                  try {
                    data = JSON.parse(data);
                  } catch {
                    return {};
                  }
                }
                return data !== null && typeof data === "object" && !Array.isArray(data)
                  ? (data as Record<string, unknown>)
                  : {};
              };
              // User prompt from the turn row itself.
              const promptText =
                typeof r.prompt === "string"
                  ? r.prompt
                  : typeof (r.request as any)?.prompt === "string"
                    ? (r.request as any).prompt
                    : "";
              if (promptText) {
                synth.push({ seq: nextSeq++, turnId, role: "user", content: promptText });
              }
              let assistantText = "";
              let pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];
              const flushAssistant = (): void => {
                if (assistantText) {
                  synth.push({
                    seq: nextSeq++,
                    turnId,
                    role: "assistant",
                    content: assistantText,
                  });
                  assistantText = "";
                }
                if (pendingCalls.length > 0) {
                  synth.push({
                    seq: nextSeq++,
                    turnId,
                    role: "assistant",
                    content: null,
                    toolCalls: pendingCalls.map((c) => ({
                      id: c.id,
                      type: "function",
                      function: { name: c.name, arguments: c.arguments },
                    })),
                  });
                  pendingCalls = [];
                }
              };
              for (const ev of evs) {
                const data = parsePayload(ev);
                if (ev.type === "message.delta" && typeof data.text === "string") {
                  assistantText += data.text;
                } else if (ev.type === "tool.call") {
                  // A tool call closes the open prose segment (mirrors the
                  // engine: text streamed in a tool round is discarded, but
                  // completed prose before the call is part of the turn).
                  if (assistantText) {
                    synth.push({
                      seq: nextSeq++,
                      turnId,
                      role: "assistant",
                      content: assistantText,
                    });
                    assistantText = "";
                  }
                  pendingCalls.push({
                    id: typeof data.id === "string" ? data.id : "",
                    name: typeof data.name === "string" ? data.name : "",
                    arguments:
                      typeof data.args === "string" ? data.args : JSON.stringify(data.args ?? {}),
                  });
                } else if (ev.type === "tool.result") {
                  flushAssistant();
                  const resultPayload =
                    data.result !== undefined
                      ? data.result
                      : data.error
                        ? { error: data.error }
                        : null;
                  synth.push({
                    seq: nextSeq++,
                    turnId,
                    role: "tool",
                    content:
                      typeof resultPayload === "string"
                        ? resultPayload
                        : JSON.stringify(resultPayload ?? null),
                    toolCallId: typeof data.id === "string" ? data.id : undefined,
                    name: typeof data.name === "string" ? data.name : undefined,
                    ...(typeof data.resultTokens === "number"
                      ? { resultTokens: data.resultTokens }
                      : {}),
                    ...(data.usage !== undefined ? { usage: data.usage } : {}),
                    ...(typeof data.promptDelta === "number"
                      ? { promptDelta: data.promptDelta }
                      : {}),
                  } as Record<string, unknown>);
                }
              }
              flushAssistant();
              messages.push(...synth);
            }
          }
        }
        // Per-turn metrics (usage/duration) ride alongside the dump so a
        // client can rebuild per-turn summaries without replaying events.
        // Each row also carries its settle status — `running` for an
        // in-flight (typically lingered) turn, then `finished` /
        // `aborted` / `error` / `interrupted` — so a reconnecting client
        // can tell the session still has an active turn and behave
        // accordingly (busy gate, poll-to-settle), and can mark a
        // failed (provider-error) turn distinctly from an aborted one
        // on rehydrate. A running row has no stored usage/duration yet
        // (both are stamped at settle time), so the snapshot from
        // `onUsageFor` fills the usage in: the client's "last known
        // context total" then stays live instead of showing the pre-turn
        // figure until the row settles.
        let turns: unknown[] = [];
        if (typeof store!.listTurns === "function") {
          const rows = ((await store!.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
          const usageById = new Map<number, { usage?: unknown; durationMs?: number }>();
          if (typeof store!.listTurnUsages === "function") {
            for (const m of ((await store!.listTurnUsages(id)) ?? []) as Array<{
              turnId: number;
              usage?: unknown;
              durationMs?: number;
            }>) {
              usageById.set(m.turnId, {
                ...(m.usage !== undefined ? { usage: m.usage } : {}),
                ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
              });
            }
          }
          const liveUsage = deps.onUsageFor?.(id);
          turns = rows.map((r) => {
            const turnId = Number(r.id);
            const status = typeof r.status === "string" ? r.status : "finished";
            const stored = usageById.get(turnId) ?? {};
            const running = status === "running";
            return {
              turnId,
              status,
              ...(running && liveUsage !== undefined ? { usage: liveUsage } : stored),
              ...(typeof r.duration_ms === "number" ? { durationMs: r.duration_ms } : {}),
            };
          });
        }
        reply(200, {
          session,
          messages,
          ...(turns.length > 0 ? { turns } : {}),
        });
        return;
      }
      // Store-less fallback (test mode): documented minimal response — an
      // empty transcript rather than a crash (§4.8).
      reply(200, { session, messages: [] });

      return;
    }

    if (type === "turn.get") {
      const turnId = typeof data.turnId === "string" ? data.turnId : String(data.turnId ?? "");
      if (turnId === "") {
        fail("invalid_request", "turnId must be a non-empty string");
        return;
      }
      if (hasStore && typeof store!.listTurns === "function") {
        // Recovery contract: rebuild the turn from sqlite. The wire turnId
        // (string, from turn.started) usually differs from the row id, so
        // match numerically and fall back to the session's latest turn.
        const rows = ((await store!.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
        // Match the wire turnId (string from turn.started) to a row: numeric
        // row id first, then the turn.started payload's turnId, then the
        // latest turn (recovery fallback).
        let wantedRow: Record<string, unknown> | undefined;
        const wanted = Number(turnId);
        if (Number.isFinite(wanted)) {
          wantedRow = rows.find((r) => Number(r.id) === wanted);
        }
        if (!wantedRow && typeof store!.listEvents === "function") {
          for (const ev of ((await store!.listEvents(id)) ?? []) as Array<
            Record<string, unknown>
          >) {
            if (ev.type !== "turn.started") continue;
            let payload: unknown = ev.payload;
            if (typeof payload === "string") {
              try {
                payload = JSON.parse(payload);
              } catch {
                continue;
              }
            }
            if (
              payload !== null &&
              typeof payload === "object" &&
              !Array.isArray(payload) &&
              (payload as { turnId?: unknown }).turnId === turnId
            ) {
              wantedRow = rows.find((r) => Number(r.id) === Number(ev.turn_id));
              if (wantedRow) break;
            }
          }
        }
        const row = wantedRow ?? rows[rows.length - 1] ?? undefined;
        if (!row) {
          sendJson(res, 404, {
            ...(requestId !== undefined ? { requestId } : {}),
            error: { code: "invalid_request", message: `turn ${turnId} not found` },
          });
          return;
        }
        const events: unknown[] = [];
        if (typeof store!.listEvents === "function") {
          for (const ev of ((await store!.listEvents(id)) ?? []) as Array<
            Record<string, unknown>
          >) {
            // Only this turn's events: listEvents returns every turn's
            // events for the session, and replaying all of them would
            // re-render prior turns as if they were this one.
            if (Number(ev.turn_id) !== Number(row.id)) continue;
            const payload = ev.payload;
            let data: unknown;
            if (typeof payload === "string") {
              try {
                data = JSON.parse(payload);
              } catch {
                continue; // skip unparseable rows
              }
            } else if (payload !== null && typeof payload === "object") {
              data = payload; // store returns parsed payloads
            } else {
              continue;
            }
            events.push({ id: ev.seq, type: ev.type, version: ev.version, ts: ev.ts, data });
          }
        }
        const usage = turnUsageFromRow(row) ?? turnUsageFromEvents(events);
        reply(200, {
          turn: {
            id: turnId,
            status: events.some((e) => (e as { type?: string }).type === "turn.finished")
              ? "finished"
              : row.status,
            model: row.model,
            created_at: row.created_at,
            finished_at: row.finished_at ?? null,
            duration_ms: row.duration_ms ?? null,
            ...(usage !== undefined ? { usage } : {}),
            events,
          },
        });
        return;
      }
      sendJson(res, 404, {
        ...(requestId !== undefined ? { requestId } : {}),
        error: { code: "invalid_request", message: `turn ${turnId} not found` },
      });

      return;
    }

    if (type === "turn.abort") {
      if (hasOrchestrator && typeof orchestrator!.abortTurn === "function") {
        const kill = deps.onAbortKillTool as
          | ((sessionId: string) => Promise<boolean> | boolean)
          | undefined;
        // Capture the in-flight call before unwinding: the tracker clears
        // as the turn settles, and the response reports what *was* killed.
        const inFlight = activeToolCallFor(id) ?? null;
        const aborted = await orchestrator!.abortTurn(id, (sid) => (kill ? kill(sid) : false));
        const after = await lookupSession(id);
        reply(200, {
          ok: true,
          status: aborted ? "aborted" : "idle",
          aborted: {
            requested: aborted,
            sessionId: id,
            activeToolCall: inFlight,
          },
          session: after ?? session,
        });
        return;
      }
      // No orchestrator (model-provider fallback): there is no live
      // turn handle to heal — nothing to abort.
      reply(200, {
        ok: true,
        status: "idle",
        aborted: { requested: false, sessionId: id, activeToolCall: null },
        session,
      });

      return;
    }

    if (type === "compaction.run") {
      const compaction = deps.compaction;
      if (typeof compaction !== "function") {
        fail("internal", "compaction is not configured on this server");
        return;
      }
      if (data.kind !== "compact" && data.kind !== "handoff") {
        fail("invalid_request", 'kind must be "compact" or "handoff"');
        return;
      }
      if (data.guidance !== undefined && typeof data.guidance !== "string") {
        fail("invalid_request", "guidance must be a string");
        return;
      }
      const kind = data.kind as CompactionKind;
      const guidance = typeof data.guidance === "string" ? data.guidance : undefined;
      try {
        const result = await compaction(id, kind, guidance);
        const targetId = typeof result.sessionId === "string" ? result.sessionId : id;
        reply(200, {
          ok: true,
          kind,
          summary: result.summary,
          model: result.model,
          truncated: result.truncated === true,
          sessionId: targetId,
        });
      } catch (err) {
        const code =
          (err as { code?: string }).code === "unknown_session"
            ? "unknown_session"
            : "provider_error";
        fail(code, err instanceof Error ? err.message : String(err));
      }

      return;
    }

    if (type === "transcript.shake") {
      const shake = deps.shake;
      if (typeof shake !== "function") {
        fail("internal", "shake is not configured on this server");
        return;
      }
      try {
        const outcome = await shake(id);
        const after = await lookupSession(id);
        reply(200, {
          ok: true,
          ...outcome,
          session: after ?? session,
        });
      } catch (err) {
        fail("internal", err instanceof Error ? err.message : String(err));
      }

      return;
    }

    if (type.startsWith("skills.")) {
      const manager = deps.skills as SkillManager | undefined;
      if (
        !manager ||
        typeof manager.list !== "function" ||
        typeof manager.load !== "function" ||
        typeof manager.unload !== "function"
      ) {
        fail("internal", "skills system is not configured on this server");
        return;
      }
      const sessionId = typeof deps.skillsSessionId === "string" ? deps.skillsSessionId : id;
      const sub = type.slice("skills.".length);
      if (sub === "list") {
        reply(200, { skills: await manager.list(sessionId) });
        return;
      }
      if (sub === "status") {
        reply(200, { skills: manager.status(sessionId) });
        return;
      }
      if (sub === "load" || sub === "unload") {
        const name = data.name;
        if (typeof name !== "string" || name.trim() === "") {
          fail("invalid_request", `"name" must be a non-empty string`);
          return;
        }
        const result =
          sub === "load"
            ? await manager.load(name, sessionId)
            : await manager.unload(name, sessionId);
        reply(result.ok ? 200 : 404, result);
        return;
      }
      fail("invalid_request", `unsupported skills command: ${sub}`);
      return;
    }

    if (type === "turn.start") {
      await startTurn(res, session, data, requestId);
      return;
    }

    fail("invalid_request", `unsupported message type: ${type}`);
    return;
  }

  /**
   * Start a turn in the background: the messages POST returns 202 at once
   * and progress/terminal events arrive on the session stream. The server
   * owns the turn — a stream disconnect detaches, never aborts, unless the
   * turn opted into `abortOnDisconnect` bound to a specific `streamId`
   * (the `stream.hello` id emitted on that stream).
   */
  async function startTurn(
    res: ServerResponse,
    session: SessionRecord,
    data: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<void> {
    // Revive (§4.5): a turn on a dormant session implicitly reopens it.
    if (session.status === "dormant") {
      if (hasStore && typeof store!.reviveSession === "function") {
        try {
          await store!.reviveSession(session.id);
          const revived = await lookupSession(session.id);
          if (revived) session = revived;
        } catch {
          // revival is best effort; proceed with the turn
        }
      } else {
        session.status = "open";
        session.detached_at = null;
      }
    }
    // The caller revives dormant sessions before reaching here, so the only
    // non-open status left is a genuine internal inconsistency.
    if (session.status !== "open") {
      sendErrorWithRequestId(
        res,
        "internal",
        `session ${session.id} is not open (status=${session.status})`,
        requestId,
      );
      return;
    }
    if (typeof data.prompt !== "string" || data.prompt.length === 0) {
      sendErrorWithRequestId(
        res,
        "invalid_request",
        "prompt must be a non-empty string",
        requestId,
      );
      return;
    }
    if (data.model !== undefined && typeof data.model !== "string") {
      sendErrorWithRequestId(res, "invalid_request", "model must be a string", requestId);
      return;
    }
    if (data.abortOnDisconnect !== undefined && typeof data.abortOnDisconnect !== "boolean") {
      sendErrorWithRequestId(
        res,
        "invalid_request",
        "abortOnDisconnect must be a boolean",
        requestId,
      );
      return;
    }
    if (data.streamId !== undefined && typeof data.streamId !== "string") {
      sendErrorWithRequestId(res, "invalid_request", "streamId must be a string", requestId);
      return;
    }

    const model = deps.model;
    if (!hasOrchestrator && (!model || typeof model.runTurn !== "function")) {
      sendErrorWithRequestId(res, "internal", "no model provider configured", requestId);
      return;
    }

    // Usage as of a terminal cut (abort/error), when the model reported any.
    const cutUsage = (): unknown => {
      const f = deps.onUsageFor;
      return typeof f === "function" ? f(session.id) : undefined;
    };
    const turnLog = logger.child({ sessionId: session.id });
    const persistEvent = async (ev: SseEnvelope): Promise<void> => {
      if (!store?.addEvent) return;
      try {
        const payload = (ev as { data?: unknown }).data;
        await store.addEvent(session.id, {
          type: ev.type,
          payload: JSON.stringify(payload),
          version: typeof ev.version === "number" ? ev.version : 1,
        });
      } catch {
        // persistence is best effort
      }
    };
    // Track turn.started/error for the terminal synthesis below: on the
    // orchestrator path the engine emits no terminal event on abort, so
    // the adapter frames `turn.aborted` itself (and persists it — the row
    // turn.get replays for an aborted turn).
    let turnStarted = false;
    let sawError = false;
    const track = (ev: SseEnvelope): void => {
      if (ev.type === "turn.started") turnStarted = true;
      if (ev.type === "error") sawError = true;
    };
    const channel = channelFor(session.id);
    bus?.on(channel, track);
    const untrack = (): void => {
      bus?.off(channel, track);
    };
    const emitToStream = async (ev: SseEnvelope): Promise<void> => {
      turnLog.debug({ event: ev }, "turn event");
      publish(session.id, ev);
    };

    // Record the turn row up front on the fallback path only (best effort).
    // On the orchestrator path the composed executeTurn in serve.ts owns the
    // turn row — creating a second adapter row here would leave a duplicate
    // `running` row (see the former streamTurn comment).
    let turnRowId: number | null = null;
    if (store?.addTurn && !hasOrchestrator) {
      try {
        const row = await store.addTurn(session.id, {
          role: "user",
          content: typeof data.prompt === "string" ? data.prompt : "",
          status: "running",
          ...(typeof data.model === "string" ? { model: data.model } : {}),
        });
        turnRowId =
          row && typeof (row as { id?: number }).id === "number"
            ? ((row as { id?: number }).id as number)
            : null;
      } catch {
        // persistence is best effort
      }
    }

    const linger = data.abortOnDisconnect !== true;
    const boundStreamId = !linger && typeof data.streamId === "string" ? data.streamId : undefined;

    if (hasOrchestrator) {
      const handle = orchestrator!.runTurn(session.id, data);
      if (boundStreamId !== undefined) {
        const list = turnsByStream.get(boundStreamId) ?? [];
        list.push({ handle });
        turnsByStream.set(boundStreamId, list);
      }
      const finishError = async (err: unknown): Promise<void> => {
        untrack();
        const isAbort = (err as Error | undefined)?.name === "AbortError";
        if (isAbort && turnStarted) {
          const envelope = {
            id: 0,
            type: "turn.aborted",
            version: 1,
            ts: Date.now(),
            data: {
              reason: (err as Error).message || "turn aborted",
              ...(cutUsage() !== undefined ? { usage: cutUsage() } : {}),
            },
          } as SseEnvelope;
          await persistEvent(envelope);
          await emitToStream(envelope);
          if (store !== undefined && store.finishTurn !== undefined) {
            try {
              await store.finishTurn(session.id, turnRowId, "aborted");
            } catch {
              // settle-sync is best effort
            }
          }
          return;
        }
        if (!isAbort && !sawError) {
          const e = err as { code?: string; message?: string };
          const envelope = {
            id: 0,
            type: "error",
            version: 1,
            ts: Date.now(),
            code: e.code ?? "provider_error",
            data: {
              code: e.code ?? "provider_error",
              message: e.message ?? String(err),
              ...(cutUsage() !== undefined ? { usage: cutUsage() } : {}),
            },
          } as SseEnvelope;
          // Persist the synthesized terminal event (like `turn.aborted`)
          // so `turn.get` replays it even when the engine never emitted.
          await persistEvent(envelope);
          await emitToStream(envelope);
        }
        if (!isAbort && store !== undefined && store.finishTurn !== undefined) {
          try {
            await store.finishTurn(session.id, turnRowId, "error");
          } catch {
            // settle-sync is best effort
          }
        }
      };
      void handle.promise.then(
        async () => {
          untrack();
          if (store !== undefined && store.finishTurn !== undefined) {
            try {
              await store.finishTurn(session.id, turnRowId, "finished");
            } catch {
              // settle-sync is best effort
            }
          }
        },
        (err: unknown) => void finishError(err),
      );
    } else {
      // Fallback path (no orchestrator): drive the model provider directly
      // in the background, persisting each event so terminal state stays
      // recoverable. Hydrate the prior transcript (§4.4) and pass the full
      // message list to the model so context carries across turns.
      const controller = new AbortController();
      if (boundStreamId !== undefined) {
        const list = turnsByStream.get(boundStreamId) ?? [];
        list.push({ controller });
        turnsByStream.set(boundStreamId, list);
      }
      void (async (): Promise<void> => {
        try {
          const fallbackPrior = (await (store?.getTranscript
            ? store.getTranscript(session.id)
            : [])) as ChatCompletionMessageParam[];
          const fallbackMessages: ChatCompletionMessageParam[] = [
            ...fallbackPrior,
            { role: "user", content: typeof data.prompt === "string" ? data.prompt : "" },
          ];
          const fallbackStartLen = fallbackPrior.length;
          const fallbackReq = { ...data, messages: fallbackMessages };
          try {
            await model!.runTurn(session.id, fallbackReq, {
              emit: async (ev) => {
                track(ev);
                await persistEvent(ev);
                await emitToStream(ev);
              },
              signal: controller.signal,
            });
            // A model that emits a terminal `error` but returns normally
            // (the engine always rethrows instead) still failed: settle
            // as `error`, not `finished`, so the row never contradicts
            // its stored terminal event.
            healFallbackMessages(fallbackMessages);
            if (store?.appendMessages && fallbackMessages.length > fallbackStartLen) {
              try {
                await store.appendMessages(
                  session.id,
                  fallbackMessages.slice(fallbackStartLen),
                  turnRowId,
                );
              } catch {
                // persistence is best effort
              }
            }
            // Settle-sync the adapter's turn row (best effort): with no
            // orchestrator nothing else settles this row.
            if (store !== undefined && store.finishTurn !== undefined) {
              try {
                await store.finishTurn(session.id, turnRowId, sawError ? "error" : "finished");
              } catch {
                // settle-sync is best effort
              }
            }
          } catch (err) {
            // Any failure persists the partial batch exactly like an abort
            // (yog#42, fallback parity with serve.ts): heal dangling tool
            // calls, then persist the user prompt and every completed
            // round so `transcript.get` shows the turn instead of
            // rewinding. Abort settles as `aborted`, provider failure as
            // `error`.
            const isAbort =
              controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
            healFallbackMessages(fallbackMessages);
            if (store?.appendMessages && fallbackMessages.length > fallbackStartLen) {
              try {
                await store.appendMessages(
                  session.id,
                  fallbackMessages.slice(fallbackStartLen),
                  turnRowId,
                );
              } catch {
                // persistence is best effort
              }
            }
            if (store !== undefined && store.finishTurn !== undefined) {
              try {
                await store.finishTurn(session.id, turnRowId, isAbort ? "aborted" : "error");
              } catch {
                // settle-sync is best effort
              }
            }
            if (!sawError && !controller.signal.aborted) {
              const e = err as { code?: string; message?: string };
              const envelope = {
                id: 0,
                type: "error",
                version: 1,
                ts: Date.now(),
                code: e.code ?? "provider_error",
                data: {
                  code: e.code ?? "provider_error",
                  message: e.message ?? String(err),
                  ...(cutUsage() !== undefined ? { usage: cutUsage() } : {}),
                },
              } as SseEnvelope;
              // Persist the synthesized terminal event (like `turn.aborted`)
              // so `turn.get` replays it even when no `error` was emitted.
              await persistEvent(envelope);
              await emitToStream(envelope);
            }
            if (controller.signal.aborted && turnStarted) {
              const envelope = {
                id: 0,
                type: "turn.aborted",
                version: 1,
                ts: Date.now(),
                data: {
                  reason: "client disconnected",
                  ...(cutUsage() !== undefined ? { usage: cutUsage() } : {}),
                },
              } as SseEnvelope;
              await persistEvent(envelope);
              await emitToStream(envelope);
            }
          }
        } finally {
          untrack();
        }
      })();
    }

    sendMessage(res, 202, "turn.start", { accepted: true }, requestId);
  }

  /** GET /v1/sessions/{id}/stream — the long-lived SSE event channel. */
  async function streamSession(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
  ): Promise<void> {
    const session = await lookupSession(id);
    if (!session) {
      sendError(res, "unknown_session", `session ${id} not found`);
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    const streamId = randomUUID();
    const channel = channelFor(id);
    const hello = {
      id: 0,
      type: "stream.hello",
      version: 1,
      ts: Date.now(),
      data: { streamId, sessionId: id },
    } as SseEnvelope;
    res.write(encodeEvent(hello));

    // Replay any running turn's persisted events so a client that connects
    // mid-turn sees turn.started + deltas instead of a cold stream.
    if (
      hasStore &&
      typeof store!.listTurns === "function" &&
      typeof store!.listEvents === "function"
    ) {
      try {
        const rows = ((await store!.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
        const running = new Set(
          rows.filter((r) => r.status === "running").map((r) => Number(r.id)),
        );
        if (running.size > 0) {
          const events = ((await store!.listEvents(id)) ?? []) as Array<Record<string, unknown>>;
          for (const ev of events) {
            if (!running.has(Number(ev.turn_id))) continue;
            let payload: unknown = ev.payload;
            if (typeof payload === "string") {
              try {
                payload = JSON.parse(payload);
              } catch {
                continue;
              }
            }
            res.write(
              encodeEvent({
                id: typeof ev.seq === "number" ? ev.seq : 0,
                type: String(ev.type),
                version: typeof ev.version === "number" ? ev.version : 1,
                ts: typeof ev.ts === "number" ? ev.ts : Date.now(),
                data: payload,
              } as SseEnvelope),
            );
          }
        }
      } catch {
        // replay is best effort; live events still flow
      }
    }

    let closed = false;
    const onBus = (ev: SseEnvelope): void => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(encodeEvent(ev));
      } catch {
        // dead socket; the close handler prunes it
      }
    };
    bus?.on(channel, onBus);

    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(": heartbeat\n\n");
      } catch {
        // dead socket
      }
    }, 15_000);
    heartbeat.unref?.();

    const onClose = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      bus?.off(channel, onBus);
      // abortOnDisconnect binding: turns that opted in and named this
      // stream are aborted when the stream goes away. The default linger
      // policy leaves the turn running (turns are wire-independent).
      const bound = turnsByStream.get(streamId);
      if (bound) {
        turnsByStream.delete(streamId);
        for (const entry of bound) {
          try {
            entry.controller?.abort(new Error("client disconnected"));
          } catch {
            // best effort
          }
          setTimeout(() => {
            try {
              entry.handle?.abort(new Error("client disconnected"));
            } catch {
              // best effort
            }
          }, 0);
        }
      }
    };
    req.on("close", onClose);
    res.on("close", onClose);
  }
}
