import type { IncomingMessage } from "node:http";
import type { AdapterState, SessionRecord } from "./types.ts";
import type { SseEnvelope } from "../sse.ts";

/** Session channel name on the event bus. */
export function channelFor(id: string): string {
  return `session:${id}`;
}

/**
 * Publish an event for a session: the bus boundary only exposes on/off;
 * EventEmitter-style emit is used when the injected bus is an EventEmitter
 * (serve.ts/tests). No emit capability means no stream delivery — turns
 * still settle.
 */
export function publish(st: AdapterState, sessionId: string, ev: SseEnvelope): void {
  (st.bus as unknown as { emit?: (ch: string, ev: SseEnvelope) => void } | undefined)?.emit?.(
    channelFor(sessionId),
    ev,
  );
}

/** Look a session up in the store (preferred) or the in-memory fallback. */
export async function lookupSession(st: AdapterState, id: string): Promise<SessionRecord | null> {
  if (st.hasStore) {
    const row = await st.store!.getSession(id);
    return row ? normalizeSession(row) : null;
  }
  return st.sessions.get(id) ?? null;
}

/** Coerce a store row (sqlite) into the adapter's session shape. */
export function normalizeSession(row: unknown): SessionRecord {
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

/** Read a request body into a string, rejecting payloads over `limit` bytes. */
export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a persisted event payload row into an object ({} when unparseable). */
export function parseEventPayload(ev: Record<string, unknown>): Record<string, unknown> {
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
}
