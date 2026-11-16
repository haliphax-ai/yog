import type { IncomingMessage } from "node:http";
import type { SseEnvelope } from "../sse.ts";
import type { AdapterState, SessionRecord } from "./types.ts";
import { lookupSession } from "./transport.ts";
/**
 * Validate a `turn.start` request beyond the session lookup: an open
 * session, a non-empty string `prompt`, string `model`/`streamId` and
 * boolean `abortOnDisconnect` when present, and a turn driver (orchestrator
 * or model provider) wired in. Returns the mapped error to send, or null
 * when the turn may proceed.
 */
export function validateTurnInput(
  st: AdapterState,
  session: SessionRecord,
  data: Record<string, unknown>,
): { code: string; message: string } | null {
  // The caller revives dormant sessions before reaching here, so the only
  // non-open status left is a genuine internal inconsistency.
  const checks: Array<[boolean, { code: string; message: string }]> = [
    [
      session.status !== "open",
      {
        code: "internal",
        message: `session ${session.id} is not open (status=${session.status})`,
      },
    ],
    [
      typeof data.prompt !== "string" || data.prompt.length === 0,
      { code: "invalid_request", message: "prompt must be a non-empty string" },
    ],
    [
      data.model !== undefined && typeof data.model !== "string",
      { code: "invalid_request", message: "model must be a string" },
    ],
    [
      data.abortOnDisconnect !== undefined && typeof data.abortOnDisconnect !== "boolean",
      { code: "invalid_request", message: "abortOnDisconnect must be a boolean" },
    ],
    [
      data.streamId !== undefined && typeof data.streamId !== "string",
      { code: "invalid_request", message: "streamId must be a string" },
    ],
    [
      !st.hasOrchestrator && (!st.deps.model || typeof st.deps.model.runTurn !== "function"),
      { code: "internal", message: "no model provider configured" },
    ],
  ];
  const bad = checks.find(([invalid]) => invalid);
  return bad === undefined ? null : bad[1];
}

/** Revive: a turn on a dormant session implicitly reopens it. */
export async function reviveSessionForTurn(
  st: AdapterState,
  session: SessionRecord,
): Promise<SessionRecord> {
  if (session.status !== "dormant") return session;
  if (st.hasStore && typeof st.store!.reviveSession === "function") {
    try {
      await st.store!.reviveSession(session.id);
      return (await lookupSession(st, session.id)) ?? session;
    } catch {
      return session; // revival is best effort; proceed with the turn
    }
  }
  session.status = "open";
  session.detached_at = null;
  return session;
}

/** Frame + fan out the adapter-synthesized `turn.aborted` terminal. */
export async function emitTurnAbortedEvent(
  persistEvent: (ev: SseEnvelope) => Promise<void>,
  emitToStream: (ev: SseEnvelope) => Promise<void>,
  err: unknown,
  usage: unknown,
): Promise<void> {
  const envelope = {
    id: 0,
    type: "turn.aborted",
    version: 1,
    ts: Date.now(),
    data: {
      reason: (err as Error).message || "turn aborted",
      ...(usage !== undefined ? { usage } : {}),
    },
  } as SseEnvelope;
  await persistEvent(envelope);
  await emitToStream(envelope);
}
