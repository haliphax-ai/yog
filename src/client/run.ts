/**
 * Network run client — `yog run` as a pure HTTP/SSE client (PLAN.md §7).
 *
 * Flow: (optional) GET /v1/capabilities → POST /v1/sessions →
 * POST /v1/sessions/{id}/turns (SSE) → DELETE /v1/sessions/{id}.
 *
 * If the SSE stream dies mid-turn, the client falls back to
 * GET /v1/sessions/{id}/turns/{turnId} (turnId comes from `turn.started`)
 * to recover the terminal state. No server internals are imported — only
 * contract-shaped types (the `TurnEvent` envelope) — and the daemon is never
 * spawned in-process: an unreachable server is a friendly error telling the
 * user to run `yog serve`.
 */
import type { TurnEvent } from "../turn/sink.ts";
import { createClientLogger } from "../log.ts";
import { readSseStream } from "./sse.ts";

/** Default daemon origin when YOG_SERVER_URL is unset. */
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8111";

/** Writable stream seam (matches `process.stdout` / `process.stderr`). */
export interface WritableLike {
  write(chunk: string): unknown;
}

/** Options for one `yog run` network invocation. */
export interface RunClientOptions {
  /** Server origin (no trailing slash). Defaults to YOG_SERVER_URL or the loopback default. */
  baseUrl?: string;
  /** Model id sent to POST /v1/sessions/{id}/turns. */
  model?: string;
  /** User prompt for the turn. */
  prompt: string;
  /** Assistant text sink (message.delta). Defaults to stdout. */
  stdout?: WritableLike;
  /** Status sink (tool activity, errors). Defaults to stderr. */
  stderr?: WritableLike;
  /** Optional abort signal: cancels in-flight requests (SIGINT handling). */
  signal?: AbortSignal;
  /**
   * When true (default) transport failures reject the promise; when false the
   * failure is reported in the result (exitCode 1) instead.
   */
  throwOnError?: boolean;
}

/** Outcome of one run. `exitCode` is 0 on success, 1 on error. */
export interface RunResult {
  exitCode: number;
  /** Failure message (transport errors, terminal `error` events). */
  error?: string;
  /** Set to "turn-status" when the SSE stream died and was recovered. */
  recoveredVia?: string;
}

/** Default base URL: YOG_SERVER_URL, else the loopback daemon. */
function baseUrlOf(opts: RunClientOptions): string {
  const raw = opts.baseUrl ?? process.env["YOG_SERVER_URL"] ?? DEFAULT_SERVER_URL;
  return raw.replace(/\/+$/, "");
}

/** Default sinks: process.stdout / process.stderr. */
function stdoutOf(opts: RunClientOptions): WritableLike {
  return opts.stdout ?? process.stdout;
}
function stderrOf(opts: RunClientOptions): WritableLike {
  return opts.stderr ?? process.stderr;
}

/** Friendly guidance when the daemon cannot be reached (never auto-spawned). */
function unreachableError(base: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `cannot reach yog server at ${base} (${detail}); ` +
      "start it first with `yog serve` (no server is spawned automatically) " +
      "or point YOG_SERVER_URL at a running daemon",
  );
}

/** HTTP error body → message (tolerates non-JSON/absent bodies). */
async function httpError(res: Response, what: string): Promise<Error> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) detail = `${detail}: ${body.error.message}`;
  } catch {
    /* non-JSON body; keep the status line */
  }
  return new Error(`${what}: ${detail}`);
}

/**
 * True when `fetch` failed to *establish* a connection (ECONNREFUSED & friends).
 *
 * Node's undici wraps fetch failures in `TypeError("fetch failed")` whose
 * `cause` carries the syscall error, so a blanket "TypeError means
 * unreachable" test is wrong: a server that dies *mid-session* (reset socket
 * after connect) must not be reported as "never started". Only
 * connection-establishment codes mark the daemon as unreachable.
 */
function isUnreachable(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** Parse a `data:` JSON envelope (used by the turn-status fallback). */
function parseEnvelope(json: string): TurnEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["type"] !== "string") return undefined;
    return obj as unknown as TurnEvent;
  } catch {
    return undefined;
  }
}

/**
 * Run one turn against a running daemon.
 *
 * Resolves with `{ exitCode: 0 }` on success and `{ exitCode: 1, error }` on
 * a server-reported failure. Transport failures reject by default (friendly
 * `yog serve` guidance) unless `throwOnError: false`, in which case they
 * resolve as exit code 1 instead.
 */
export async function runClient(opts: RunClientOptions): Promise<RunResult> {
  const base = baseUrlOf(opts);
  const stdout = stdoutOf(opts);
  const stderr = stderrOf(opts);

  try {
    return await execute(opts, base, stdout, stderr);
  } catch (err) {
    const friendly = isUnreachable(err)
      ? unreachableError(base, err)
      : err instanceof Error
        ? err
        : new Error(String(err));
    if (opts.throwOnError === false) {
      stderr.write(`${friendly.message}\n`);
      return { exitCode: 1, error: friendly.message };
    }
    throw friendly;
  }
}

/** Body of the flow proper (transport failures propagate to `runClient`). */
async function execute(
  opts: RunClientOptions,
  base: string,
  stdout: WritableLike,
  stderr: WritableLike,
): Promise<RunResult> {
  const token = process.env["YOG_API_TOKEN"];
  const auth = token ? { authorization: `Bearer ${token}` } : undefined;
  const log = createClientLogger(stderr as unknown as NodeJS.WritableStream);

  // 1. Optional capabilities probe — establishes reachability with a friendly
  //    error before any session is created.
  const capsRes = await fetch(`${base}/v1/capabilities`, {
    headers: auth,
    signal: opts.signal,
  });
  if (!capsRes.ok) throw await httpError(capsRes, "capabilities request failed");

  // 2. Create the session.
  const createRes = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: auth,
    signal: opts.signal,
  });
  if (!createRes.ok) throw await httpError(createRes, "creating session failed");
  const created = (await createRes.json()) as { session?: { id?: string } };
  const sessionId = created?.session?.id;
  if (!sessionId || typeof sessionId !== "string") {
    throw new Error("creating session failed: response has no session id");
  }

  // Track turn state across the stream and its fallback.
  let turnId: string | undefined;
  let sawFinished = false;
  let sawError: string | undefined;
  let streamDied = false;

  const handleEvent = (ev: TurnEvent): void => {
    if (ev.type === "turn.started") {
      turnId = ev.data.turnId;
      return;
    }
    if (ev.type === "message.delta") {
      stdout.write(ev.data.text);
      return;
    }
    if (ev.type === "tool.call" || ev.type === "tool.result") {
      log.info({ event: ev }, "turn event");
      return;
    }
    if (ev.type === "turn.finished") {
      sawFinished = true;
      return;
    }
    if (ev.type === "error") {
      sawError = ev.data.message;
      return;
    }
    // Unknown events are tolerated (forward compatibility).
  };

  let result: RunResult;
  try {
    // 3. Stream the turn over SSE.
    const turnRes = await fetch(`${base}/v1/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", ...auth },
      body: JSON.stringify({ ...(opts.model ? { model: opts.model } : {}), prompt: opts.prompt }),
      signal: opts.signal,
    });
    if (!turnRes.ok) throw await httpError(turnRes, "running turn failed");

    let streamError: Error | undefined;
    await readSseStream(turnRes, {
      onEvent: handleEvent,
      onError: (err) => {
        streamError = err;
      },
    });
    streamDied = streamError !== undefined;

    if (streamDied) {
      // 3b. Fallback: recover terminal state from the turn-status endpoint.
      if (turnId === undefined) {
        throw new Error(
          `turn stream interrupted (${streamError?.message ?? "unknown error"}) before a turnId was announced`,
        );
      }
      const statusRes = await fetch(`${base}/v1/sessions/${sessionId}/turns/${turnId}`, {
        headers: auth,
      });
      if (!statusRes.ok) throw await httpError(statusRes, "recovering turn status failed");
      const body = (await statusRes.json()) as {
        turn?: { events?: { type?: unknown; data?: unknown }[] };
      };
      for (const row of body?.turn?.events ?? []) {
        // Stored rows are `{ type, data }` envelopes; rebuild the wire shape.
        const env =
          typeof row.type === "string"
            ? ({ type: row.type, data: row.data } as unknown as TurnEvent)
            : parseEnvelope(JSON.stringify(row.data));
        if (env) handleEvent(env);
      }
      result = {
        exitCode: sawError === undefined ? 0 : 1,
        ...(sawError !== undefined ? { error: sawError } : {}),
        recoveredVia: "turn-status",
      };
    } else {
      if (sawError !== undefined) {
        result = { exitCode: 1, error: sawError };
      } else if (!sawFinished) {
        result = { exitCode: 1, error: "turn stream ended without a terminal event" };
      } else {
        result = { exitCode: 0 };
      }
    }
    if (result.exitCode !== 0 && result.error !== undefined) {
      stderr.write(`${result.error}\n`);
    }
  } finally {
    // 4. Close the session (best effort — never masks the turn outcome).
    await fetch(`${base}/v1/sessions/${sessionId}`, { method: "DELETE", headers: auth }).catch(
      () => undefined,
    );
  }
  return result;
}
