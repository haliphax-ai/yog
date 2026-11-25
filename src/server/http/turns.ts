import type { AdapterState, TurnEmitCtx } from "./types.ts";

import type { HttpDeps, SessionRecord } from "./types.ts";
import { channelFor, publish } from "./helpers.ts";
import { sendErrorWithRequestId, sendMessage } from "./reply.ts";
import { providerErrorEnvelope } from "./wire.ts";
import { emitTurnAbortedEvent, reviveSessionForTurn, validateTurnInput } from "./turn-setup.ts";

import type { ServerResponse } from "node:http";
import type { SseEnvelope } from "../sse.ts";
import { logger } from "../../log.ts";

export async function finishTurnError(
  st: AdapterState,
  emit: TurnEmitCtx,
  turnRowId: number | null,
  err: unknown,
): Promise<void> {
  const isAbort = (err as Error | undefined)?.name === "AbortError";
  if (isAbort && emit.turnStarted()) {
    await emit.emitTurnAborted(err, emit.cutUsage());
    await emit.settleTurn("aborted");
    return;
  }
  if (!isAbort && !emit.sawError()) {
    const envelope = providerErrorEnvelope(err, emit.cutUsage());
    await emit.persistEvent(envelope);
    await emit.emitToStream(envelope);
  }
  await emit.settleTurn("error");
}

export function cutUsageFor(deps: HttpDeps, sessionId: string): unknown {
  const f = deps.onUsageFor;
  return typeof f === "function" ? f(sessionId) : undefined;
}

/** Settle-sync the adapter's turn row (best effort). */
export async function settleTurnRow(
  st: AdapterState,
  sessionId: string,
  turnRowId: number | null,
  status: string,
): Promise<void> {
  if (st.store === undefined || st.store.finishTurn === undefined) return;
  try {
    await st.store.finishTurn(sessionId, turnRowId, status);
  } catch {
    // settle-sync is best effort
  }
}

/** Persist one turn event row (best effort). */
export async function persistTurnEvent(
  st: AdapterState,
  sessionId: string,
  ev: SseEnvelope,
): Promise<void> {
  if (!st.store?.addEvent) return;
  try {
    const payload = (ev as { data?: unknown }).data;
    await st.store.addEvent(sessionId, {
      type: ev.type,
      payload: JSON.stringify(payload),
      version: typeof ev.version === "number" ? ev.version : 1,
    });
  } catch {
    // persistence is best effort
  }
}

/**
 * Run one turn through the orchestrator and settle the adapter-side row:
 * the orchestrator's executeTurn (serve.ts) owns the turn row and
 * transcript persistence; the adapter only frames terminal states on the
 * wire (the engine emits no terminal event on abort) and never writes a
 * second `running` row.
 */
export async function runOrchestratorTurn(
  st: AdapterState,
  turn: {
    session: SessionRecord;
    data: Record<string, unknown>;
    turnRowId: number | null;
    boundStreamId: string | undefined;
  },
  emit: TurnEmitCtx & { untrack: () => void },
): Promise<void> {
  const { session, data, turnRowId, boundStreamId } = turn;
  const handle = st.orchestrator!.runTurn(session.id, data);
  if (boundStreamId !== undefined) {
    const list = st.turnsByStream.get(boundStreamId) ?? [];
    list.push({ handle });
    st.turnsByStream.set(boundStreamId, list);
  }
  void handle.promise.then(
    async () => {
      emit.untrack();
      await emit.settleTurn("finished");
    },
    (err: unknown) => void finishTurnError(st, emit, turnRowId, err),
  );
}

/** `turn.start`: revive, validate, then hand the turn to the orchestrator. */
export async function startTurn(
  st: AdapterState,
  res: ServerResponse,
  session: SessionRecord,
  data: Record<string, unknown>,
  requestId: string | undefined,
): Promise<void> {
  // Revive: a turn on a dormant session implicitly reopens it.
  session = await reviveSessionForTurn(st, session);
  const invalid = validateTurnInput(st, session, data);
  if (invalid !== null) {
    sendErrorWithRequestId(res, invalid.code, invalid.message, requestId);
    return;
  }

  // Usage as of a terminal cut (abort/error), when the model reported any.
  const cutUsage = (): unknown => cutUsageFor(st.deps, session.id);
  const turnLog = logger.child({ sessionId: session.id });
  const persistEvent = (ev: SseEnvelope): Promise<void> => persistTurnEvent(st, session.id, ev);
  // Track turn.started/error for the terminal synthesis below: on the
  // st.orchestrator path the engine emits no terminal event on abort, so
  // the adapter frames `turn.aborted` itself (and persists it — the row
  // turn.get replays for an aborted turn).
  let turnStarted = false;
  let sawError = false;
  const track = (ev: SseEnvelope): void => {
    if (ev.type === "turn.started") turnStarted = true;
    if (ev.type === "error") sawError = true;
  };
  const channel = channelFor(session.id);
  st.bus?.on(channel, track);
  const untrack = (): void => {
    st.bus?.off(channel, track);
  };
  const emitToStream = async (ev: SseEnvelope): Promise<void> => {
    turnLog.debug({ event: ev }, "turn event");
    publish(st, session.id, ev);
  };

  const settleTurn = (status: string): Promise<void> => settleTurnRow(st, session.id, null, status);
  const emitTurnAborted = (err: unknown, usage: unknown): Promise<void> =>
    emitTurnAbortedEvent(persistEvent, emitToStream, err, usage);

  const linger = data.abortOnDisconnect !== true;
  const boundStreamId = !linger && typeof data.streamId === "string" ? data.streamId : undefined;

  // `queued` tells the client its turn is waiting behind an earlier one
  // on this session (a wake turn mid-flight, or a burst of submits): the
  // spinner alone can't distinguish "running" from "queued behind".
  // Captured BEFORE runOrchestratorTurn registers the new handle — the
  // registration makes isBusy(answer-yes) self-fulfilling otherwise.
  const busyBefore =
    typeof st.orchestrator?.isBusy === "function" && st.orchestrator.isBusy(session.id);

  await runOrchestratorTurn(
    st,
    { session, data, turnRowId: null, boundStreamId },
    {
      persistEvent,
      emitToStream,
      settleTurn,
      emitTurnAborted,
      cutUsage,
      sawError: () => sawError,
      turnStarted: () => turnStarted,
      untrack,
    },
  );

  sendMessage(res, 202, "turn.start", { accepted: true, queued: busyBefore }, requestId);
}

/**
 * Replay any running turn's persisted events onto a freshly opened stream
 * (best effort: a failure leaves the client with live events only), so a
 * client that connects mid-turn sees turn.started + deltas instead of a
 * cold stream.
 */
