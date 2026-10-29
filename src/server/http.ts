import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { encodeEvent, type SseEnvelope } from "./sse.ts";
import { logger } from "../log.ts";

/** Capabilities advertisement served at GET /v1/capabilities. */
export interface Capabilities {
  contractVersion: string | number;
  models: string[];
  tools: string[];
  features: string[];
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
}

/** Handle returned by `orchestrator.runTurn` (see SessionOrchestrator). */
export interface TurnHandleLike {
  promise: Promise<unknown>;
  abort: (reason?: unknown) => void;
}

/** Minimal orchestrator boundary the adapter drives for a turn. */
export interface OrchestratorBoundary {
  runTurn(sessionId: string, req: Record<string, unknown>): TurnHandleLike;
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
  capabilities?: Capabilities;
  model?: ModelBoundary;
  store?: StoreBoundary | unknown;
  orchestrator?: OrchestratorBoundary | unknown;
  /** Per-daemon event bus: executeTurn publishes, this adapter subscribes. */
  bus?: EventBusBoundary | unknown;
  createTurnEngine?: unknown;
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

function checkAuth(req: IncomingMessage): boolean {
  const token = process.env.YOG_API_TOKEN;
  if (!token) return true;
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${token}`;
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
 * conversion is a route-layer concern.
 */
function toWireMessage(m: unknown): Record<string, unknown> {
  const row = (m ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["seq", "turnId", "ts", "role", "content", "name"] as const) {
    if (key in row) out[key] = row[key];
  }
  if (row.tool_call_id !== undefined) out.toolCallId = row.tool_call_id;
  if (row.tool_calls !== undefined) out.toolCalls = row.tool_calls;
  return out;
}

/**
 * Create the v1 HTTP/SSE adapter (PLAN §5.2–§5.5). All boundaries are
 * injected so tests can fake the store, orchestrator, event bus, model
 * provider and turn-engine factory.
 */
export function createHttpServer(deps: HttpDeps): Server {
  // Last-resort advertisement (injected capabilities win). The adapter
  // implements SSE streaming and the transcript rehydration dump, so the
  // default advertises both (§4.6); the composition root (serve.ts) passes
  // the same set explicitly.
  const capabilities: Capabilities = deps.capabilities ?? {
    contractVersion: "v1",
    models: [],
    tools: [],
    features: ["sse", "transcript"],
  };
  const sessions = new Map<string, SessionRecord>();
  const store = deps.store as StoreBoundary | undefined;
  const orchestrator = deps.orchestrator as OrchestratorBoundary | undefined;
  const bus = deps.bus as EventBusBoundary | undefined;
  const hasStore = !!store && typeof store.createSession === "function";
  const hasOrchestrator = !!orchestrator && typeof orchestrator.runTurn === "function";

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

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const segs = segments(req.url ?? "/");

    if (!checkAuth(req)) {
      sendError(res, "unauthorized", "missing or invalid bearer token");
      return;
    }

    // GET /v1/capabilities
    if (method === "GET" && segs[0] === "v1" && segs[1] === "capabilities") {
      sendJson(res, 200, capabilities);
      return;
    }

    if (segs[0] !== "v1") {
      sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
      return;
    }

    // POST /v1/sessions
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

    // /v1/sessions/{id}[/turns...|transcript...]
    if (segs[1] === "sessions" && segs.length >= 3) {
      const id = segs[2] as string;
      let session = await lookupSession(id);

      if (segs.length === 3) {
        if (method === "GET") {
          if (!session) {
            sendError(res, "unknown_session", `session ${id} not found`);
            return;
          }
          sendJson(res, 200, { session });
          return;
        }
        if (method === "DELETE") {
          if (!session) {
            sendError(res, "unknown_session", `session ${id} not found`);
            return;
          }
          const purge =
            new URL(req.url ?? "", "http://localhost").searchParams.get("purge") === "true";
          if (purge) {
            // Immediate irreversible delete (§4.5). After this the session
            // row is gone: subsequent GET session/transcript/POST turn all
            // hit the 404 unknown_session path.
            if (hasStore && typeof store!.purgeSession === "function") {
              const deleted = await store!.purgeSession(id);
              if (deleted === 0) {
                sendError(res, "unknown_session", `session ${id} not found`);
                return;
              }
              sendJson(res, 200, { ok: true, deleted: true, id });
              return;
            }
            // In-memory fallback: purge is a hard delete.
            sessions.delete(id);
            sendJson(res, 200, { ok: true, deleted: true, id });
            return;
          }
          // Detach (§4.5): status open → dormant, detached_at stamped,
          // nothing forfeited. Idempotent — a second DELETE on an already
          // dormant session is a no-op and still returns 200.
          if (session.status === "open") {
            if (hasStore && typeof store!.detachSession === "function") {
              await store!.detachSession(id, Date.now());
              const detached = await lookupSession(id);
              sendJson(res, 200, { session: detached ?? { ...session, status: "dormant" } });
              return;
            }
            session.status = "dormant";
            session.detached_at = Date.now();
            session.updated_at = session.detached_at;
          }
          sendJson(res, 200, { session });
          return;
        }
      }

      // GET /v1/sessions/{id}/transcript — the rehydration dump (§4.6).
      // Readable while the row exists, including dormant sessions within the
      // 30-day retention window; dormancy never blocks reads.
      if (method === "GET" && segs.length === 4 && segs[3] === "transcript") {
        if (!session) {
          sendError(res, "unknown_session", `session ${id} not found`);
          return;
        }
        if (hasStore && typeof store!.getTranscript === "function") {
          const params = new URL(req.url ?? "", "http://localhost").searchParams;
          const afterSeq = params.get("after") ? Number(params.get("after")) : undefined;
          const limit = params.get("limit") ? Number(params.get("limit")) : undefined;
          const messages = (
            await store!.getTranscript(id, {
              ...(afterSeq !== undefined && Number.isFinite(afterSeq)
                ? { afterSeq: afterSeq }
                : {}),
              ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
            })
          ).map(toWireMessage);
          sendJson(res, 200, { session, messages });
          return;
        }
        // Store-less fallback (test mode): documented minimal response — an
        // empty transcript rather than a crash (§4.8).
        sendJson(res, 200, { session, messages: [] });
        return;
      }

      // GET /v1/sessions/{id}/turns/{turnId} — terminal turn state.
      if (method === "GET" && segs.length === 5 && segs[3] === "turns") {
        if (!session) {
          sendError(res, "unknown_session", `session ${id} not found`);
          return;
        }
        const turnId = segs[4] as string;
        if (hasStore && typeof store!.listTurns === "function") {
          // Recovery contract: rebuild the turn from sqlite. The wire turnId
          // (string, from turn.started) usually differs from the row id, so
          // match numerically and fall back to the session's latest turn.
          const rows = ((await store!.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
          const wanted = Number(turnId);
          const row =
            (Number.isFinite(wanted) ? rows.find((r) => Number(r.id) === wanted) : undefined) ??
            rows[rows.length - 1] ??
            undefined;
          if (!row) {
            sendJson(res, 404, {
              error: { code: "invalid_request", message: `turn ${turnId} not found` },
            });
            return;
          }
          const events: unknown[] = [];
          if (typeof store!.listEvents === "function") {
            for (const ev of ((await store!.listEvents(id)) ?? []) as Array<
              Record<string, unknown>
            >) {
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
          sendJson(res, 200, {
            turn: {
              id: turnId,
              status: events.some((e) => (e as { type?: string }).type === "turn.finished")
                ? "finished"
                : row.status,
              model: row.model,
              created_at: row.created_at,
              finished_at: row.finished_at ?? null,
              duration_ms: row.duration_ms ?? null,
              events,
            },
          });
          return;
        }
        sendJson(res, 404, {
          error: { code: "invalid_request", message: `turn ${turnId} not found` },
        });
        return;
      }

      // POST /v1/sessions/{id}/turns — stream SSE.
      if (method === "POST" && segs.length === 4 && segs[3] === "turns") {
        if (!session) {
          sendError(res, "unknown_session", `session ${id} not found`);
          return;
        }
        // Revive (§4.5): a turn on a dormant session implicitly reopens it —
        // status → open, detached_at cleared, retention clock reset. The
        // session_closed (409) error code is gone: nothing about dormancy
        // rejects a turn. The mutation is best-effort; the stream still runs
        // if the store write fails.
        if (session.status === "dormant") {
          if (hasStore && typeof store!.reviveSession === "function") {
            try {
              await store!.reviveSession(id);
              const revived = await lookupSession(id);
              if (revived) session = revived;
            } catch {
              // revival is best effort; proceed with the turn
            }
          } else {
            session.status = "open";
            session.detached_at = null;
          }
        }
        await streamTurn(req, res, session);
        return;
      }
    }

    sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
  }

  async function streamTurn(
    req: IncomingMessage,
    res: ServerResponse,
    session: SessionRecord,
  ): Promise<void> {
    // The caller revives dormant sessions before reaching here, so the only
    // non-open status left is a genuine internal inconsistency. The
    // `session_closed` (409) error code is gone (§4.6): nothing about
    // dormancy rejects a turn.
    if (session.status !== "open") {
      sendError(res, "internal", `session ${session.id} is not open (status=${session.status})`);
      return;
    }

    let body: Record<string, unknown>;
    try {
      const raw = await readBody(req);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      sendError(res, "invalid_request", "request body must be a JSON object");
      return;
    }

    if (typeof body.prompt !== "string" || body.prompt.length === 0) {
      sendError(res, "invalid_request", "prompt must be a non-empty string");
      return;
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      sendError(res, "invalid_request", "model must be a string");
      return;
    }

    const model = deps.model;
    if (!hasOrchestrator && (!model || typeof model.runTurn !== "function")) {
      sendError(res, "internal", "no model provider configured");
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders?.();

    const controller = new AbortController();
    let closed = false;
    let handle: TurnHandleLike | undefined;
    const onClose = (): void => {
      if (closed) return;
      closed = true;
      controller.abort(new Error("client disconnected"));
      // Fan the abort out to the orchestrator (queued turns are dropped,
      // in-flight turns get their handle promise rejected).
      try {
        handle?.abort(new Error("client disconnected"));
      } catch {
        // abort is best effort
      }
    };
    req.on("close", onClose);
    res.on("close", onClose);

    let sawError = false;
    const turnLog = logger.child({ sessionId: session.id });
    const emit = async (ev: SseEnvelope): Promise<void> => {
      if (closed || res.writableEnded || res.destroyed) return;
      if (ev.type === "error") sawError = true;
      turnLog.debug({ event: ev }, "turn event");
      res.write(encodeEvent(ev));
    };

    // Record the turn row up front (best effort: persistence never fails the
    // stream); every emitted event below is persisted alongside it. The row
    // id is stamped on the transcript rows this turn produces (§4.8).
    let turnRowId: number | null = null;
    if (store?.addTurn) {
      try {
        const row = await store.addTurn(session.id, {
          role: "user",
          content: typeof body.prompt === "string" ? body.prompt : "",
          status: "running",
          ...(typeof body.model === "string" ? { model: body.model } : {}),
        });
        turnRowId =
          row && typeof (row as { id?: number }).id === "number"
            ? ((row as { id?: number }).id as number)
            : null;
      } catch {
        // persistence is best effort
      }
    }
    const persistEvent = async (ev: SseEnvelope): Promise<void> => {
      if (!store?.addEvent) return;
      try {
        const data = (ev as { data?: unknown }).data;
        await store.addEvent(session.id, {
          type: ev.type,
          payload: JSON.stringify(data),
          version: typeof ev.version === "number" ? ev.version : 1,
        });
      } catch {
        // persistence is best effort
      }
    };

    const channel = `session:${session.id}`;
    // Event-persistence dedup (§4.8): on the orchestrator path, the composed
    // `executeTurn` in serve.ts publishes each envelope to the bus *and*
    // persists it through its own sink (`store.addEvent`). The bus
    // subscriber's only job here is to deliver the envelope to SSE — it
    // must NOT persist again, or every event lands in `turn_events`
    // twice. On the fallback path (no orchestrator) there is no sink, so
    // `persistEvent` is the sole writer and stays.
    const onBusEvent = (ev: SseEnvelope): void => {
      void emit(ev);
    };

    try {
      if (hasOrchestrator) {
        // Orchestrator path: the composed executeTurn publishes envelopes to
        // the per-daemon bus; we subscribe for this session and frame them.
        bus?.on(channel, onBusEvent);
        handle = orchestrator!.runTurn(session.id, body);
        controller.signal.addEventListener("abort", () => handle?.abort(), { once: true });
        try {
          await handle.promise;
        } catch (err) {
          if (!sawError && !closed && !res.writableEnded) {
            const e = err as { code?: string; message?: string };
            await emit({
              id: 0,
              type: "error",
              version: 1,
              ts: Date.now(),
              code: e.code ?? "provider_error",
              data: { code: e.code ?? "provider_error", message: e.message ?? String(err) },
            } as SseEnvelope);
          }
        }
      } else {
        // Fallback path (no orchestrator): drive the model provider directly,
        // persisting each event so terminal state stays recoverable. Hydrate
        // the prior transcript (§4.4) and pass the full message list to the
        // model so context carries across turns. On success, append this
        // turn's messages to the canonical transcript; a failed turn
        // persists nothing (the catch is a no-op for the transcript).
        const fallbackPrior = (await (store?.getTranscript
          ? store.getTranscript(session.id)
          : [])) as ChatCompletionMessageParam[];
        const fallbackMessages: ChatCompletionMessageParam[] = [
          ...fallbackPrior,
          { role: "user", content: typeof body.prompt === "string" ? body.prompt : "" },
        ];
        const fallbackStartLen = fallbackPrior.length;
        const fallbackReq = { ...body, messages: fallbackMessages };
        try {
          await model!.runTurn(session.id, fallbackReq, {
            emit: async (ev) => {
              await persistEvent(ev);
              await emit(ev);
            },
            signal: controller.signal,
          });
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
        } catch {
          // Failed turn persists nothing (except its event log, which is
          // diagnostic). The transcript stays at the last turn boundary.
        }
      }
    } catch (err) {
      if (!sawError && !closed && !res.writableEnded) {
        const e = err as { code?: string; message?: string };
        await emit({
          id: 0,
          type: "error",
          version: 1,
          ts: Date.now(),
          code: e.code ?? "provider_error",
          data: { code: e.code ?? "provider_error", message: e.message ?? String(err) },
        } as SseEnvelope);
      }
    } finally {
      bus?.off(channel, onBusEvent);
      req.off("close", onClose);
      res.off("close", onClose);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }
}
