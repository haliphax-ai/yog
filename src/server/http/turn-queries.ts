import { turnUsageFromRow, turnUsageFromEvents } from "./wire.ts";
import { activeToolCallFor } from "../../turn.ts";
import { parseEventPayload } from "./transcript.ts";
import { sendErrorWithRequestId, sendJson } from "./reply.ts";
import type {
  HttpDeps,
  MsgCtx,
  OrchestratorBoundary,
  SessionRecord,
  StoreBoundary,
} from "./types.ts";

/** Whether this persisted row is the `turn.started` for the wire turnId. */
export function eventNamesTurn(ev: Record<string, unknown>, turnId: string): boolean {
  if (ev.type !== "turn.started") return false;
  const payload = parseEventPayload(ev);
  return (payload as { turnId?: unknown }).turnId === turnId;
}

/**
 * Recovery match for `turn.get`: the wire turnId (string, from turn.started)
 * usually differs from the row id, so match numerically first, then via the
 * turn.started payload's turnId, then fall back to the session's latest turn.
 */
export async function findTurnRow(
  store: StoreBoundary | undefined,
  id: string,
  turnId: string,
): Promise<Record<string, unknown> | undefined> {
  if (!store || typeof store.listTurns !== "function") return undefined;
  const rows = ((await store.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
  const wanted = Number(turnId);
  if (Number.isFinite(wanted)) {
    const numeric = rows.find((r) => Number(r.id) === wanted);
    if (numeric) return numeric;
  }
  if (typeof store.listEvents === "function") {
    for (const ev of ((await store.listEvents(id)) ?? []) as Array<Record<string, unknown>>) {
      if (eventNamesTurn(ev, turnId)) {
        const matched = rows.find((r) => Number(r.id) === Number(ev.turn_id));
        if (matched) return matched;
      }
    }
  }
  return rows[rows.length - 1] ?? undefined;
}

/**
 * One turn's events for the `turn.get` replay: listEvents returns every
 * turn's events for the session, and replaying all of them would re-render
 * prior turns as if they were this one.
 */
export async function collectTurnEvents(
  store: StoreBoundary | undefined,
  id: string,
  turnRowId: number,
): Promise<unknown[]> {
  if (!store || typeof store.listEvents !== "function") return [];
  const events: unknown[] = [];
  for (const ev of ((await store.listEvents(id)) ?? []) as Array<Record<string, unknown>>) {
    if (Number(ev.turn_id) !== turnRowId) continue;
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
  return events;
}

/**
 * Reply to `turn.get`: rebuild the turn from the store (recovery contract).
 * The wire turnId (string, from turn.started) usually differs from the row
 * id, so match numerically and fall back to the session's latest turn;
 * store-less fakes get a 404 (nothing to rebuild from).
 */
export async function replyTurnGet(store: StoreBoundary | undefined, ctx: MsgCtx): Promise<void> {
  const { id, data, res, requestId } = ctx;
  const fail = (code: string, message: string): void =>
    sendErrorWithRequestId(res, code, message, requestId);
  const turnId = typeof data.turnId === "string" ? data.turnId : String(data.turnId ?? "");
  if (turnId === "") {
    fail("invalid_request", "turnId must be a non-empty string");
    return;
  }
  const row = await findTurnRow(store, id, turnId);
  if (!row) {
    sendJson(res, 404, {
      ...(requestId !== undefined ? { requestId } : {}),
      error: { code: "invalid_request", message: `turn ${turnId} not found` },
    });
    return;
  }
  const events = await collectTurnEvents(store, id, Number(row.id));
  const usage = turnUsageFromRow(row) ?? turnUsageFromEvents(events);
  ctx.reply(200, {
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
}

/**
 * Reply to `turn.abort`: route through the orchestrator when one is wired,
 * reporting what *was* killed (captured before unwind); with only a model
 * provider there is no live turn handle — nothing to abort.
 */
export async function replyTurnAbort(
  deps: HttpDeps,
  orchestrator: OrchestratorBoundary | undefined,
  store: StoreBoundary | undefined,
  sess: { current: SessionRecord; lookup: (id: string) => Promise<SessionRecord | null> },
  ctx: MsgCtx,
): Promise<void> {
  const { id } = ctx;
  const { current: session, lookup: lookupSession } = sess;
  const hasOrchestrator = !!orchestrator && typeof orchestrator.runTurn === "function";
  if (hasOrchestrator && typeof orchestrator!.abortTurn === "function") {
    const kill = deps.onAbortKillTool as
      | ((sessionId: string) => Promise<boolean> | boolean)
      | undefined;
    // Capture the in-flight call before unwinding: the tracker clears
    // as the turn settles, and the response reports what *was* killed.
    const inFlight = activeToolCallFor(id) ?? null;
    const aborted = await orchestrator!.abortTurn(id, (sid) => (kill ? kill(sid) : false));
    const after = await lookupSession(id);
    ctx.reply(200, {
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
  ctx.reply(200, {
    ok: true,
    status: "idle",
    aborted: { requested: false, sessionId: id, activeToolCall: null },
    session,
  });

  return;
}
