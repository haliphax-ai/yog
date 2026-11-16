import type { AdapterState, TurnEmitCtx } from "./types.ts";

import type { HttpDeps, SessionRecord } from "./types.ts";
import { channelFor, publish } from "./helpers.ts";
import { sendErrorWithRequestId, sendMessage } from "./reply.ts";
import { healFallbackMessages, providerErrorEnvelope } from "./wire.ts";
import { reviveSessionForTurn, validateTurnInput, emitTurnAbortedEvent } from "./turn-setup.ts";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { ServerResponse } from "node:http";
import type { SseEnvelope } from "../sse.ts";
import { logger } from "../../log.ts";

/**
 * Record the fallback path's turn row up front (best effort), returning the
 * row id (or null). The orchestrator path's executeTurn in serve.ts owns
 * its own row — creating a second adapter row there would leave a
 * duplicate `running` row (see the former streamTurn comment).
 */
export async function recordFallbackTurnRow(
  st: AdapterState,
  session: SessionRecord,
  data: Record<string, unknown>,
): Promise<number | null> {
  if (!st.store?.addTurn || st.hasOrchestrator) return null;
  try {
    const row = await st.store.addTurn(session.id, {
      role: "user",
      content: typeof data.prompt === "string" ? data.prompt : "",
      status: "running",
      ...(typeof data.model === "string" ? { model: data.model } : {}),
    });
    return row && typeof (row as { id?: number }).id === "number"
      ? ((row as { id?: number }).id as number)
      : null;
  } catch {
    return null; // persistence is best effort
  }
}

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

/** Frame + fan out the fallback path's client-disconnect terminal. */
export function emitClientDisconnected(ctx: {
  cutUsage: () => unknown;
  persistEvent: (ev: SseEnvelope) => Promise<void>;
  emitToStream: (ev: SseEnvelope) => Promise<void>;
}): Promise<void> {
  const envelope = {
    id: 0,
    type: "turn.aborted",
    version: 1,
    ts: Date.now(),
    data: {
      reason: "client disconnected",
      ...(ctx.cutUsage() !== undefined ? { usage: ctx.cutUsage() } : {}),
    },
  } as SseEnvelope;
  return Promise.all([ctx.persistEvent(envelope), ctx.emitToStream(envelope)]).then(
    () => undefined,
  );
}

/** Persist the fallback turn's partial batch after healing (best effort). */

export async function persistFallbackBatch(
  st: AdapterState,
  sessionId: string,
  fallbackMessages: ChatCompletionMessageParam[],
  fallbackStartLen: number,
  turnRowId: number | null,
): Promise<void> {
  if (!st.store?.appendMessages || fallbackMessages.length <= fallbackStartLen) return;
  try {
    await st.store.appendMessages(sessionId, fallbackMessages.slice(fallbackStartLen), turnRowId);
  } catch {
    // persistence is best effort
  }
}

export async function runFallbackTurn(
  st: AdapterState,
  turn: {
    session: SessionRecord;
    data: Record<string, unknown>;
    turnRowId: number | null;
    boundStreamId: string | undefined;
  },
  ctx: {
    track: (ev: SseEnvelope) => void;
    persistEvent: (ev: SseEnvelope) => Promise<void>;
    emitToStream: (ev: SseEnvelope) => Promise<void>;
    settleTurn: (status: string) => Promise<void>;
    cutUsage: () => unknown;
    sawError: () => boolean;
    turnStarted: () => boolean;
  },
): Promise<void> {
  const { session, data, turnRowId, boundStreamId } = turn;
  // Fallback path (no orchestrator): drive the model provider directly
  // in the background, persisting each event so terminal state stays
  // recoverable. Hydrate the prior transcript and pass the full
  // message list to the model so context carries across turns.
  const controller = new AbortController();
  if (boundStreamId !== undefined) {
    const list = st.turnsByStream.get(boundStreamId) ?? [];
    list.push({ controller });
    st.turnsByStream.set(boundStreamId, list);
  }
  // Any failure persists the partial batch exactly like an abort
  // (yog#42, fallback parity with serve.ts): heal dangling tool
  // calls, then persist the user prompt and every completed round so
  // `transcript.get` shows the turn instead of rewinding. Abort
  // settles as `aborted`, provider failure as `error`.
  const settleFallbackFailure = async (
    err: unknown,
    fallbackMessages: ChatCompletionMessageParam[],
    fallbackStartLen: number,
    controller: AbortController,
  ): Promise<void> => {
    // Any failure persists the partial batch exactly like an abort
    // (yog#42, fallback parity with serve.ts): heal dangling tool
    // calls, then persist the user prompt and every completed
    // round so `transcript.get` shows the turn instead of
    // rewinding. Abort settles as `aborted`, provider failure as
    // `error`.
    const isAbort =
      controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    healFallbackMessages(fallbackMessages);
    await persistFallbackBatch(st, session.id, fallbackMessages, fallbackStartLen, turnRowId);
    await ctx.settleTurn(isAbort ? "aborted" : "error");
    if (controller.signal.aborted && ctx.turnStarted()) {
      await emitClientDisconnected(ctx);
    } else if (!ctx.sawError() && !controller.signal.aborted) {
      const envelope = providerErrorEnvelope(err, ctx.cutUsage());
      // Persist the synthesized terminal event (like `turn.aborted`)
      // so `turn.get` replays it even when no `error` was emitted.
      await ctx.persistEvent(envelope);
      await ctx.emitToStream(envelope);
    }
  };

  const fallbackPrior = (await (st.store?.getTranscript
    ? st.store.getTranscript(session.id)
    : [])) as ChatCompletionMessageParam[];
  const fallbackMessages: ChatCompletionMessageParam[] = [
    ...fallbackPrior,
    { role: "user", content: typeof data.prompt === "string" ? data.prompt : "" },
  ];
  const fallbackStartLen = fallbackPrior.length;
  const fallbackReq = { ...data, messages: fallbackMessages };
  try {
    await st.deps.model!.runTurn(session.id, fallbackReq, {
      emit: async (ev: SseEnvelope) => {
        ctx.track(ev);
        await ctx.persistEvent(ev);
        await ctx.emitToStream(ev);
      },
      signal: controller.signal,
    });
    // A model that emits a terminal `error` but returns normally
    // (the engine always rethrows instead) still failed: settle
    // as `error`, not `finished`, so the row never contradicts
    // its stored terminal event.
    healFallbackMessages(fallbackMessages);
    await persistFallbackBatch(st, session.id, fallbackMessages, fallbackStartLen, turnRowId);
    await ctx.settleTurn(ctx.sawError() ? "error" : "finished");
  } catch (err) {
    await settleFallbackFailure(err, fallbackMessages, fallbackStartLen, controller);
  } finally {
    st.bus?.off(channelFor(session.id), (ev) => ctx.track(ev));
  }
}
/** Usage as of a terminal cut (abort/error), when the model reported any. */
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

  // Record the turn row up front on the fallback path only (best effort).
  // On the orchestrator path the composed executeTurn in serve.ts owns the
  // turn row — creating a second adapter row here would leave a duplicate
  // `running` row (see the former streamTurn comment).
  const turnRowId = await recordFallbackTurnRow(st, session, data);

  const linger = data.abortOnDisconnect !== true;
  const boundStreamId = !linger && typeof data.streamId === "string" ? data.streamId : undefined;

  const settleTurn = (status: string): Promise<void> =>
    settleTurnRow(st, session.id, turnRowId, status);
  const emitTurnAborted = (err: unknown, usage: unknown): Promise<void> =>
    emitTurnAbortedEvent(persistEvent, emitToStream, err, usage);
  if (st.hasOrchestrator) {
    await runOrchestratorTurn(
      st,
      { session, data, turnRowId, boundStreamId },
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
  } else {
    // Fallback path (no orchestrator): drive the model provider directly in
    // the background, persisting each event so terminal state stays
    // recoverable. Hydrate the prior transcript and pass the full
    // message list to the model so context carries across turns.
    void runFallbackTurn(
      st,
      { session, data, turnRowId, boundStreamId },
      {
        track,
        persistEvent,
        emitToStream,
        settleTurn,
        cutUsage,
        sawError: () => sawError,
        turnStarted: () => turnStarted,
      },
    );
  }

  sendMessage(res, 202, "turn.start", { accepted: true }, requestId);
}

/**
 * Replay any running turn's persisted events onto a freshly opened stream
 * (best effort: a failure leaves the client with live events only), so a
 * client that connects mid-turn sees turn.started + deltas instead of a
 * cold stream.
 */
