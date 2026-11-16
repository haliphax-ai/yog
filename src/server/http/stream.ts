import type { AdapterState } from "./types.ts";

import type { StoreBoundary, TurnHandleLike } from "./types.ts";
import { channelFor, lookupSession } from "./transport.ts";
import { sendError } from "./reply.ts";
import { parseEventPayload } from "./transcript.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { encodeEvent } from "../sse.ts";
import type { SseEnvelope } from "../sse.ts";
import { randomUUID } from "node:crypto";

/**
 * Replay any running turn's persisted events onto a freshly opened stream
 * (best effort: a failure leaves the client with live events only), so a
 * client that connects mid-turn sees turn.started + deltas instead of a
 * cold stream.
 */
export async function replayRunningTurnEvents(
  store: StoreBoundary | undefined,
  id: string,
  res: ServerResponse,
): Promise<void> {
  if (!store || typeof store.listTurns !== "function" || typeof store.listEvents !== "function") {
    return;
  }
  try {
    const rows = ((await store.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
    const running = new Set(rows.filter((r) => r.status === "running").map((r) => Number(r.id)));
    if (running.size === 0) return;
    const events = ((await store.listEvents(id)) ?? []) as Array<Record<string, unknown>>;
    for (const ev of events) {
      if (!running.has(Number(ev.turn_id))) continue;
      const payload = parseEventPayload(ev);
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
  } catch {
    // replay is best effort; live events still flow
  }
}

/** GET /v1/sessions/{id}/stream — the long-lived SSE event channel. */

/** GET /v1/sessions/{id}/stream — the long-lived SSE event channel. */
export async function streamSession(
  st: AdapterState,
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
): Promise<void> {
  const session = await lookupSession(st, id);
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
  await replayRunningTurnEvents(st.store, id, res);

  const bound = streamBoundTurns(st, res, channel, streamId);
  req.on("close", () => bound());
  res.on("close", () => bound());
}

/** Abort every turn bound to a closed stream (best effort per entry). */

/** Abort every turn bound to a closed stream (best effort per entry). */
export function abortBoundTurns(
  bound: Array<{ handle?: TurnHandleLike; controller?: AbortController }>,
): void {
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

/**
 * Wire the stream's live-event plumbing: the bus subscription (dropping
 * writes to a dead socket), the 15s heartbeat, and the close handler that
 * unsubscribes and aborts bound turns. Returns the close handler so the
 * request and response sockets can both register it.
 */

/**
 * Wire the stream's live-event plumbing: the bus subscription (dropping
 * writes to a dead socket), the 15s heartbeat, and the close handler that
 * unsubscribes and aborts bound turns. Returns the close handler so the
 * request and response sockets can both register it.
 */
export function streamBoundTurns(
  st: AdapterState,
  res: ServerResponse,
  channel: string,
  streamId: string,
): () => void {
  let closed = false;
  const onBus = (ev: SseEnvelope): void => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(encodeEvent(ev));
    } catch {
      // dead socket; the close handler prunes it
    }
  };
  st.bus?.on(channel, onBus);

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded || res.destroyed) return;
    try {
      res.write(": heartbeat\n\n");
    } catch {
      // dead socket
    }
  }, 15_000);
  heartbeat.unref?.();

  return (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    st.bus?.off(channel, onBus);
    // abortOnDisconnect binding: turns that opted in and named this
    // stream are aborted when the stream goes away. The default linger
    // policy leaves the turn running (turns are wire-independent).
    const bound = st.turnsByStream.get(streamId);
    if (!bound) return;
    st.turnsByStream.delete(streamId);
    abortBoundTurns(bound);
  };
}
