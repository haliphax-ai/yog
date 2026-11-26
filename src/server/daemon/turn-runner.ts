/**
 * The daemon's turn entry point.
 *
 * `executeTurn` is the orchestrator's per-turn callback: hydrate the
 * transcript, run the turn engine against the session model, and persist
 * the settled batch — on success, operator abort, or provider failure
 * alike (yog#42: a failed turn keeps its prompt and completed rounds).
 */
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { SessionStore } from "../store/index.ts";
import { TurnEngine, type TurnOptions } from "../../turn/index.ts";
import type { TurnEvent, TurnSink, TurnUsage } from "../../turn/index.ts";
import {
  deliverPrelude,
  HARNESS_NOTICE_HINT,
  HARNESS_NOTICE_TOOL,
  type DeliveredPrelude,
  type PreludeNotice,
  type PreludeSink,
} from "./prelude.ts";
import type { SseEnvelope } from "../sse.ts";
import { tools } from "../../register.ts";
import { availableSkillsBlock, type SkillManager } from "../../skills/index.ts";
import { logger } from "../../log.ts";
import type { AgentFSState } from "../../state/index.ts";
import type { ModelInfoCache } from "../modelInfo.ts";
import type { EventBusBoundary } from "../http/types.ts";
import type { YogConfig } from "../../config.ts";
import { openaiClient } from "./openai.ts";

/** The context every turn runs against (bound at composition time). */
export interface TurnRuntime {
  readonly config: YogConfig;
  /** The session model id (capabilities + turns default to it). */
  readonly modelId: string;
  readonly store: SessionStore | undefined;
  readonly state: AgentFSState | undefined;
  readonly skills: SkillManager | undefined;
  readonly modelInfo: ModelInfoCache | undefined;
  /** Per-session event fan-out (the HTTP adapter subscribes per channel). */
  readonly bus: EventBusBoundary;
  /** Prelude notices delivered on the next turn each session starts. */
  readonly prelude?: PreludeSink;
}

/** Per-session usage as of the last known point, for terminal-cut flushes. */
export type UsageBySession = Map<string, TurnUsage | undefined>;

/** A built OpenAI client, one per turn (cheap; carries per-turn state). */
type ClientFactory = () => OpenAI;

/** The 429 retry policy the engine applies per round (from config). */
function rateLimitPolicy(config: YogConfig): TurnOptions["rateLimit"] {
  return {
    maxAttempts: config.rateLimitMaxAttempts,
    baseDelayMs: config.rateLimitBaseDelayMs,
    maxDelayMs: config.rateLimitMaxDelayMs,
    backoffFactor: config.rateLimitBackoffFactor,
  };
}

/** The engine sink: persist (best effort), log debug, publish on the bus. */
function turnSink(rt: TurnRuntime, sessionId: string, live: LiveTurnState): TurnSink {
  return {
    async emit(ev: TurnEvent): Promise<void> {
      const envelope = ev as unknown as SseEnvelope;
      if (ev.type === "turn.started") {
        live.turnId = (ev.data as { turnId?: string }).turnId ?? live.turnId;
      }
      if (ev.type === "turn.finished") {
        const u = (ev.data as { usage?: TurnUsage }).usage;
        if (u !== undefined && u !== null) live.usage = u;
      }
      if (rt.store !== undefined) {
        try {
          await rt.store.addEvent(sessionId, {
            type: ev.type,
            payload: JSON.stringify(ev.data),
            version: ev.version,
          });
        } catch {
          // persistence is best effort
        }
      }
      logger.child({ sessionId }).debug({ event: ev }, "turn event");
      (rt.bus as unknown as { emit: (ch: string, ev: SseEnvelope) => void }).emit(
        `session:${sessionId}`,
        envelope,
      );
    },
  };
}

/** Mutable per-turn state the sink and the settle path share. */
interface LiveTurnState {
  turnId: string | null;
  usage: TurnUsage | undefined;
}

/** Create the turn row (best effort: persistence failure keeps the turn alive). */
async function startTurnRow(
  rt: TurnRuntime,
  sessionId: string,
  prompt: string,
  model: string,
): Promise<number | null> {
  if (rt.store === undefined) return null;
  try {
    const turnRow = await rt.store.addTurn(sessionId, {
      role: "user",
      content: prompt,
      status: "running",
      model,
    });
    const id = (turnRow as { id?: unknown }).id;
    return typeof id === "number" ? id : null;
  } catch {
    // persistence is best effort
    return null;
  }
}

/** Append the settled batch (`messages.slice(startLen)`) to the transcript. */
async function persistBatch(
  rt: TurnRuntime,
  sessionId: string,
  messages: ChatCompletionMessageParam[],
  startLen: number,
  turnRowId: number | null,
): Promise<void> {
  if (rt.store === undefined || messages.length <= startLen) return;
  try {
    await rt.store.appendMessages(sessionId, messages.slice(startLen), turnRowId);
  } catch {
    // persistence is best effort
  }
}

/** Settle the turn row with its terminal status + last-known usage. */
async function settleTurnRow(
  rt: TurnRuntime,
  sessionId: string,
  turnRowId: number | null,
  status: string,
  live: LiveTurnState,
): Promise<void> {
  await rt.store?.finishTurn?.(sessionId, turnRowId, status, live.usage).catch(() => {});
}

/** The turn-specific inputs `buildTurnOptions` reads. */
interface TurnOptionsInput {
  readonly sessionId: string;
  readonly model: string;
  readonly ctx: { signal?: AbortSignal };
  readonly live: LiveTurnState;
  readonly usageBySession: UsageBySession;
}

/**
 * The engine options for one turn: abort plumbing (the signal is probed at
 * every await point, so a mid-tool/mid-stream abort still unwinds the
 * turn), usage capture, policy caps from config, the model's context
 * window, and the skills context (appended to the system prompt at the END
 * so everything before it stays cache-stable).
 */
async function buildTurnOptions(rt: TurnRuntime, input: TurnOptionsInput): Promise<TurnOptions> {
  const { sessionId, model, ctx, live, usageBySession } = input;
  const skillInstructions =
    rt.skills !== undefined ? await rt.skills.getInstructions(sessionId) : "";
  const availableSkills =
    rt.skills !== undefined ? await availableSkillsBlock(rt.skills, sessionId) : "";
  return {
    sessionId,
    ...(rt.state !== undefined
      ? { recorder: { record: (rec) => rt.state!.recordToolCall(rec) } }
      : {}),
    ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    isAborted: () => ctx.signal?.aborted === true,
    abortReason: "turn aborted by operator",
    onUsage: (u) => {
      live.usage = u;
      usageBySession.set(sessionId, u);
    },
    maxRounds: rt.config.maxRoundsPerTurn,
    rateLimit: rateLimitPolicy(rt.config),
    ...(rt.modelInfo !== undefined
      ? { contextWindow: rt.modelInfo.getContextWindow(model) ?? undefined }
      : {}),
    ...(skillInstructions !== "" ? { skillInstructions } : {}),
    ...(availableSkills !== "" ? { availableSkills } : {}),
  };
}

/**
 * Turn entry point injected into the orchestrator. Builds the OpenAI
 * client + TurnEngine and routes its sink so every event is BOTH
 * persisted (best effort) and delivered to the HTTP layer for SSE.
 * The returned turnId (from turn.started) enables turn recovery.
 */
export function makeExecuteTurn(rt: TurnRuntime, usageBySession: UsageBySession) {
  const newClient: ClientFactory = () => openaiClient(rt.config);
  return async (
    sessionId: string,
    req: Record<string, unknown>,
    ctx: { signal?: AbortSignal } = {},
  ): Promise<{ turnId: string | null }> => {
    const client = newClient();
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    const model = typeof req.model === "string" ? req.model : rt.modelId;
    const live: LiveTurnState = { turnId: null, usage: undefined };
    usageBySession.set(sessionId, undefined);

    // Hydrate prior context from the canonical transcript, then drain the
    // session's prelude queue: the notice pair lands between the prior
    // transcript and this turn's prompt row, and persists under this
    // turn's id (the batch slice starts before the pair). An unwound turn
    // keeps its delivered pair — a notice never re-delivers.
    const { messages, startLen } = await hydrateMessages(rt, sessionId, prompt);
    if (startLen < messages.length - 1) {
      // Something extra (a prelude notice pair) landed between the prior
      // transcript and the prompt row; log it for daemon forensics.
      logger
        .child({ sessionId })
        .debug({ startLen, extraRows: messages.length - 1 - startLen }, "turn prelude");
    }
    const turnRowId = await startTurnRow(rt, sessionId, prompt, model);

    const turnOpts = await buildTurnOptions(rt, {
      sessionId,
      model,
      ctx,
      live,
      usageBySession,
    });
    const sink = turnSink(rt, sessionId, live);

    // (The engine heals announced-but-unanswered tool calls before
    // throwing, so the batch persisted in the catch below already
    // carries the stubs and stays hydratable. A delivered harness_notice
    // pair is already balanced — its result row exists — so the healer
    // never stubs it.)
    try {
      await new TurnEngine(sink).run(client, model, messages, tools, turnOpts);
      // On success, persist everything this turn produced: the batch
      // starts at this turn's user prompt (`startLen` was captured before
      // it, so the slice includes it).
      await persistBatch(rt, sessionId, messages, startLen, turnRowId);
      // Settle the row as finished — the bookkeeping record of a complete
      // turn, never a gate on the stream's success.
      await settleTurnRow(rt, sessionId, turnRowId, "finished", live);
    } catch (err) {
      await settleFailedTurn({ rt, sessionId, messages, startLen, turnRowId, live }, ctx, err);
    }
    return { turnId: live.turnId };
  };
}

/**
 * The failure path (yog#42): the partial batch — user prompt, completed
 * rounds, and the engine's healed stubs for unanswered tool calls — is
 * persisted exactly like an abort, instead of rewinding to the prior
 * turn. The row settles `aborted` for an operator abort, `error` for a
 * provider failure. The signal is the authoritative abort marker:
 * mid-model-stream the engine rethrows the provider's raw abort error,
 * not an `AbortError`.
 */
function isOperatorAbort(ctx: { signal?: AbortSignal }, err: unknown): boolean {
  return ctx.signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}

/** One turn's settled-batch bookkeeping, shared by both exit paths. */
interface TurnSettlement {
  readonly rt: TurnRuntime;
  readonly sessionId: string;
  /** The turn's batch (prompt + completed rounds), as the engine left it. */
  readonly messages: ChatCompletionMessageParam[];
  /** Where the batch starts (`messages.slice(startLen)` is this turn's). */
  readonly startLen: number;
  /** The turn row to stamp `turn_id` onto (null when persistence is off). */
  readonly turnRowId: number | null;
  readonly live: LiveTurnState;
}

/** Settle an unwound turn: persist the healed partial batch, stamp the row. */
async function settleFailedTurn(
  s: TurnSettlement,
  ctx: { signal?: AbortSignal },
  err: unknown,
): Promise<void> {
  const status = isOperatorAbort(ctx, err) ? "aborted" : "error";
  await persistBatch(s.rt, s.sessionId, s.messages, s.startLen, s.turnRowId);
  await settleTurnRow(s.rt, s.sessionId, s.turnRowId, status, s.live);
}

/**
 * Hydrate the engine's `messages` from the canonical transcript, the
 * drained prelude pair (if any), and the prompt: the notice pair lands
 * between the prior transcript and the user prompt row, so the prompt row
 * stays pure. The batch slice starts BEFORE the pair, so persistence
 * carries it under this turn's id like any other row.
 */
async function hydrateMessages(
  rt: TurnRuntime,
  sessionId: string,
  prompt: string,
): Promise<{
  messages: ChatCompletionMessageParam[];
  startLen: number;
  prelude: DeliveredPrelude | undefined;
}> {
  const prior =
    rt.store !== undefined
      ? ((await rt.store.getTranscript(sessionId)) as Array<Record<string, unknown>>)
      : [];
  const notices: PreludeNotice[] | undefined = rt.prelude?.drain(sessionId);
  const prelude = notices !== undefined ? deliverPrelude(notices) : undefined;
  const messages: ChatCompletionMessageParam[] = [
    ...(prior as unknown as ChatCompletionMessageParam[]),
    ...(prelude !== undefined ? [prelude.call as unknown as ChatCompletionMessageParam] : []),
    ...(prelude !== undefined ? [prelude.result as unknown as ChatCompletionMessageParam] : []),
    { role: "user", content: prompt },
  ];
  if (prelude !== undefined && notices !== undefined)
    publishPrelude(rt, sessionId, prelude, notices);
  return { messages, startLen: prior.length, prelude };
}

/**
 * Mirror the drained prelude pair onto the wire (persist + bus): the
 * transcript splice above only reaches clients that rehydrate from
 * `transcript.get` — a live client (the idle watch's stream) never saw
 * the notices until its next submit synced the transcript. The pair
 * ships as ordinary `tool.call`/`tool.result` frames for the
 * `harness_notice` tool, exactly the shape the rehydrate path decodes.
 */
function publishPrelude(
  rt: TurnRuntime,
  sessionId: string,
  prelude: DeliveredPrelude,
  notices: PreludeNotice[],
): void {
  const callId = prelude.call.tool_calls[0]?.id ?? "";
  const events: Array<{ type: "tool.call" | "tool.result"; data: Record<string, unknown> }> = [
    {
      type: "tool.call",
      data: {
        id: callId,
        name: HARNESS_NOTICE_TOOL,
        args: "{}",
      },
    },
    {
      type: "tool.result",
      data: {
        id: callId,
        name: HARNESS_NOTICE_TOOL,
        ok: true,
        result: { hint: HARNESS_NOTICE_HINT, notices },
      },
    },
  ];
  for (const ev of events) {
    void rt.store
      ?.addEvent(sessionId, { type: ev.type, payload: JSON.stringify(ev.data), version: 1 })
      .catch(() => undefined);
    (rt.bus as unknown as { emit?: (ch: string, ev: unknown) => void })?.emit?.(
      `session:${sessionId}`,
      { id: 0, type: ev.type, version: 1, ts: Date.now(), data: ev.data },
    );
  }
}
