import type { AdapterState, MsgCtx, SessionResolvers } from "./types.ts";

import type {
  Capabilities,
  EventBusBoundary,
  HttpDeps,
  OrchestratorBoundary,
  SessionRecord,
  StoreBoundary,
  TurnHandleLike,
} from "./types.ts";
import {
  handleCompactionRun,
  handleJobsGet,
  handleSessionDetach,
  handleSkillsCommand,
  handleTranscriptShake,
} from "./messages.ts";
import { replyTranscriptGet } from "./transcript.ts";
import { replyTurnGet, replyTurnAbort } from "./turn-queries.ts";
import { startTurn } from "./turns.ts";
import { streamSession } from "./stream.ts";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { MESSAGE_TYPES, parseEnvelope } from "../messages.ts";
import type { MessageEnvelope } from "../messages.ts";
import { sendError, sendErrorWithRequestId, sendMessage, checkAuth } from "./reply.ts";
import { handleCapabilities, handleAgentCli, handleSessionCreate } from "./routes.ts";
import { lookupSession, readBody } from "./helpers.ts";
/** Split `/v1/...` path into segments (query string stripped). */
export function segments(url: string): string[] {
  const path = url.split("?")[0] ?? "";
  return path.split("/").filter(Boolean);
}

export function createHttpServer(deps: HttpDeps): Server {
  // Per-daemon configuration injection (see `config.ts`): the bearer token
  // gate. It lives in this factory's closure — concurrent daemons (tests)
  // never share it.
  const apiToken = typeof deps.apiToken === "string" ? deps.apiToken : undefined;

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
  const turnsByStream = new Map<string, Array<{ handle?: TurnHandleLike }>>();
  const st: AdapterState = {
    deps,
    apiToken,
    capabilities,
    sessions,
    store,
    orchestrator,
    bus,
    hasStore,
    hasOrchestrator,
    turnsByStream,
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(st, req, res).catch((err: unknown) => {
      sendError(res, "internal", err instanceof Error ? err.message : String(err));
    });
  });
}

export async function handle(
  st: AdapterState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const segs = segments(req.url ?? "/");

  if (!checkAuth(st, req)) {
    sendError(res, "unauthorized", "missing or invalid bearer token");
    return;
  }

  // GET /v1/capabilities — bootstrap discovery (unchanged).
  if (method === "GET" && segs[0] === "v1" && segs[1] === "capabilities" && segs.length === 2) {
    await handleCapabilities(st, req, res);
  } else if (
    method === "POST" &&
    segs[0] === "v1" &&
    segs[1] === "agent-cli" &&
    segs.length === 2
  ) {
    // POST /v1/agent-cli — CLI command dispatch (agent shim).
    await handleAgentCli(req, res);
  } else if (segs[0] !== "v1") {
    sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
  } else if (method === "POST" && segs.length === 2 && segs[1] === "sessions") {
    // POST /v1/sessions — bootstrap creation (unchanged).
    await handleSessionCreate(st, req, res);
  } else if (segs[1] === "sessions" && segs.length === 4) {
    // /v1/sessions/{id}/stream | /messages
    const id = segs[2] as string;
    const leaf = segs[3] as string;
    if (leaf === "stream" && method === "GET") {
      await streamSession(st, req, res, id);
    } else if (leaf === "messages" && method === "POST") {
      await dispatchMessage(st, req, res, id);
    } else {
      sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
    }
  } else {
    sendError(res, "invalid_request", `unknown route: ${method} ${req.url ?? ""}`);
  }
}

export async function dispatchMessage(
  st: AdapterState,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const session0 = await lookupSession(st, id);
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
  const session = session0;
  const reply = (status: number, payload: unknown): void =>
    sendMessage(res, status, type, payload, requestId);
  const fail = (code: string, message: string): void =>
    sendErrorWithRequestId(res, code, message, requestId);
  const ctx: MsgCtx = { type, id, data, res, requestId, reply, fail };
  const resolvers: SessionResolvers = {
    store: st.store,
    sessions: st.sessions,
    lookupSession: lookupSession.bind(null, st),
  };

  if (type === "session.get") {
    reply(200, { session });
  } else if (type === "session.detach") {
    await handleSessionDetach(st.deps, resolvers, session, ctx);
  } else if (type === "transcript.get") {
    await replyTranscriptGet(st.deps, st.store, session, ctx);
  } else if (type === "turn.get") {
    await replyTurnGet(st.store, ctx);
  } else if (type === "turn.abort") {
    await replyTurnAbort(
      st.deps,
      st.orchestrator,
      st.store,
      { current: session, lookup: resolvers.lookupSession },
      ctx,
    );
  } else if (type === "compaction.run") {
    await handleCompactionRun(st.deps, ctx);
  } else if (type === "transcript.shake") {
    await handleTranscriptShake(st.deps, resolvers, session, ctx);
  } else if (type.startsWith("skills.")) {
    await handleSkillsCommand(st.deps, session, ctx);
  } else if (type === "jobs.get") {
    await handleJobsGet(st.deps, ctx);
  } else if (type === "turn.start") {
    await startTurn(st, res, session, data, requestId);
  } else {
    fail("invalid_request", `unsupported message type: ${type}`);
  }
}
