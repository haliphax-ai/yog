import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { encodeEvent, type SseEnvelope } from "./sse.ts";

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
  status: "open" | "closed";
  created_at: number;
  updated_at: number;
  closed_at?: number | null;
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
  store?: unknown;
  orchestrator?: unknown;
  createTurnEngine?: unknown;
  [key: string]: unknown;
}

/** Machine-readable error codes (PLAN §5.5) with HTTP status mapping. */
const ERROR_STATUS: Record<string, number> = {
  invalid_request: 400,
  unknown_model: 400,
  unknown_session: 404,
  session_closed: 409,
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

/**
 * Create the v1 HTTP/SSE adapter (PLAN §5.2–§5.5). All boundaries are
 * injected so tests can fake the store, orchestrator, model provider and
 * turn-engine factory.
 */
export function createHttpServer(deps: HttpDeps): Server {
  const capabilities: Capabilities = deps.capabilities ?? {
    contractVersion: "v1",
    models: [],
    tools: [],
    features: [],
  };
  const sessions = new Map<string, SessionRecord>();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((err: unknown) => {
      sendError(res, "internal", err instanceof Error ? err.message : String(err));
    });
  });

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
      const now = Date.now();
      const session: SessionRecord = {
        id: randomUUID(),
        status: "open",
        created_at: now,
        updated_at: now,
      };
      sessions.set(session.id, session);
      sendJson(res, 201, { session });
      return;
    }

    // /v1/sessions/{id}[/turns...]
    if (segs[1] === "sessions" && segs.length >= 3) {
      const id = segs[2] as string;
      const session = sessions.get(id);

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
          if (session.status === "open") {
            session.status = "closed";
            session.closed_at = Date.now();
            session.updated_at = session.closed_at;
          }
          sendJson(res, 200, { session });
          return;
        }
      }

      // GET /v1/sessions/{id}/turns/{turnId} — terminal turn state.
      if (method === "GET" && segs.length === 5 && segs[3] === "turns") {
        if (!session) {
          sendError(res, "unknown_session", `session ${id} not found`);
          return;
        }
        sendJson(res, 404, {
          error: { code: "invalid_request", message: `turn ${segs[4]} not found` },
        });
        return;
      }

      // POST /v1/sessions/{id}/turns — stream SSE.
      if (method === "POST" && segs.length === 4 && segs[3] === "turns") {
        if (!session) {
          sendError(res, "unknown_session", `session ${id} not found`);
          return;
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
    if (session.status !== "open") {
      sendError(res, "session_closed", `session ${session.id} is closed`);
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
    if (!model || typeof model.runTurn !== "function") {
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
    const onClose = (): void => {
      closed = true;
      controller.abort(new Error("client disconnected"));
    };
    req.on("close", onClose);
    res.on("close", onClose);

    let sawError = false;
    const emit = async (ev: SseEnvelope): Promise<void> => {
      if (closed || res.writableEnded || res.destroyed) return;
      if (ev.type === "error") sawError = true;
      res.write(encodeEvent(ev));
    };

    try {
      await model.runTurn(session.id, body, { emit, signal: controller.signal });
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
      req.off("close", onClose);
      res.off("close", onClose);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  }
}
