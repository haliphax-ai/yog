import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdapterState, SessionRecord } from "./types.ts";
import { readBody } from "./transport.ts";
import { normalizeSession } from "./transport.ts";
import { randomUUID } from "node:crypto";
import { sendJson, sendError } from "./reply.ts";
/**
 * GET /v1/capabilities — bootstrap discovery. The client may name the model
 * it will use (`?model=`); the server resolves that model's context window
 * from the models.dev cache. A request without `?model=` gets the plain
 * advertisement.
 */
export async function handleCapabilities(
  st: AdapterState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // The client names the model it will use (`?model=`); the server
  // resolves that model's context window from the models.dev cache. A
  // request without `?model=` gets the plain advertisement.
  const model = new URL(req.url ?? "", "http://localhost").searchParams.get("model");
  if (typeof model === "string" && model !== "" && typeof st.deps.contextWindowFor === "function") {
    const cw = st.deps.contextWindowFor(model);
    sendJson(res, 200, {
      ...st.capabilities,
      contextWindowSizes: cw === undefined ? {} : { [model]: cw },
    });
    return;
  }
  sendJson(res, 200, st.capabilities);
}

/**
 * POST /v1/agent-cli — CLI command dispatch for the agent shim: parse a
 * `{ command, args }` body, resolve the command through the CLI registry,
 * and answer in plain text (400 invalid, 404 unknown, 200 output, 500
 * execution failure).
 */
export async function handleAgentCli(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
  const { getCommand } = await import("../cli.ts");
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
}

/**
 * POST /v1/sessions — bootstrap creation. The body is optional:
 * `{ title?, system? }` — `system` seeds the first transcript
 * message (role `system`) so it is part of every turn's hydrate. Store
 * backed when available, in-memory fallback otherwise.
 */
export async function handleSessionCreate(
  st: AdapterState,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
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

  if (st.hasStore) {
    const row = await st.store!.createSession({
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
  st.sessions.set(session.id, session);
  sendJson(res, 201, { session });
}
