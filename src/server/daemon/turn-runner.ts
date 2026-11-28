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
import type { ToolCallRecord } from "../../state/index.ts";
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
/** The sink's bookkeeping: fold the wire turn id and the terminal usage
 *  into `live` (the settle path reads both). */
function foldLiveState(live: LiveTurnState, ev: TurnEvent): void {
  if (ev.type === "turn.started") {
    live.turnId = (ev.data as { turnId?: string }).turnId ?? live.turnId;
  }
  if (ev.type === "turn.finished") {
    const u = (ev.data as { usage?: TurnUsage }).usage;
    if (u != null) live.usage = u;
  }
}

function turnSink(
  rt: TurnRuntime,
  sessionId: string,
  live: LiveTurnState,
  turnRowId: number | null,
): TurnSink {
  return {
    async emit(ev: TurnEvent): Promise<void> {
      foldLiveState(live, ev);
      if (rt.store !== undefined) {
        try {
          await rt.store.addEvent(
            sessionId,
            {
              type: ev.type,
              payload: JSON.stringify(ev.data),
              version: ev.version,
            },
            turnRowId ?? undefined,
          );
        } catch {
          // persistence is best effort
        }
      }
      logger.child({ sessionId }).debug({ event: ev }, "turn event");
      (rt.bus as unknown as { emit: (ch: string, ev: SseEnvelope) => void }).emit(
        `session:${sessionId}`,
        ev as unknown as SseEnvelope,
      );
    },
  };
}

/** Mutable per-turn state the sink and the settle path share. */
interface LiveTurnState {
  turnId: string | null;
  usage: TurnUsage | undefined;
}

/**
 * Create the turn row (best effort: persistence failure keeps the turn
 * alive). `wake` marks a background-jobs wake turn (the jobs manager
 * fires it, no human prompt behind it): the flag persists in the row's
 * request_json so transcript consumers can style the prompt row as
 * harness-internal, not user-typed.
 */
async function startTurnRow(
  rt: TurnRuntime,
  sessionId: string,
  prompt: string,
  model: string,
  wake: boolean | undefined,
): Promise<number | null> {
  if (rt.store === undefined) return null;
  try {
    const turnRow = await rt.store.addTurn(sessionId, {
      role: "user",
      content: prompt,
      status: "running",
      model,
      wake,
    });
    const id = (turnRow as { id?: unknown }).id;
    return typeof id === "number" ? id : null;
  } catch {
    // persistence is best effort
    return null;
  }
}

/** Append the settled batch (the prelude pair rows, if any, plus everything
 *  from the prompt row on) to the transcript. The boundary anchors on the
 *  PROMPT ROW's value, scanned from the END, then extends back over the
 *  contiguous prelude pair rows. Value beats both prior anchors: object
 *  identity failed on the live daemon (the pair's call row vanished while
 *  identity-anchored — yog#146) and index counts drift under the skills
 *  unshift. */
/** The batch's first index: the prompt row by value (scanned from the END —
 *  the hydrate wrote it, so the value is this turn's), extended back over
 *  the delivered prelude pairs (each is exactly [call, result]). */
function batchStartOf(
  messages: ChatCompletionMessageParam[],
  promptValue: string,
  pairCount: number,
): number {
  let first = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role === "user" && m.content === promptValue) {
      first = i;
      break;
    }
  }
  return Math.max(0, first - 2 * pairCount);
}

/** What persistBatch needs beyond the session: the boundary inputs and the
 *  row the batch stamps. */
interface BatchBoundary {
  readonly messages: ChatCompletionMessageParam[];
  readonly promptValue: string;
  readonly pairCount: number;
  readonly turnRowId: number | null;
}

async function persistBatch(rt: TurnRuntime, sessionId: string, b: BatchBoundary): Promise<void> {
  const first = batchStartOf(b.messages, b.promptValue, b.pairCount);
  if (rt.store === undefined || b.messages.length <= first) return;
  try {
    await rt.store.appendMessages(sessionId, b.messages.slice(first), b.turnRowId);
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
  /** The harness-internal marker echoed on `turn.started` (wake turns). */
  readonly wake?: boolean;
  /** The turn's prompt (the batch boundary anchors on its value). */
  readonly prompt: string;
}

/**
 * The engine options for one turn: abort plumbing (the signal is probed at
 * every await point, so a mid-tool/mid-stream abort still unwinds the
 * turn), usage capture, policy caps from config, the model's context
 * window, and the skills context (appended to the system prompt at the END
 * so everything before it stays cache-stable).
 */
/** Drop the keys whose value is `undefined` (the conditional spreads the
 *  option object used to hand-build, one `? :` per field). */
function withoutUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function buildTurnOptions(rt: TurnRuntime, input: TurnOptionsInput): Promise<TurnOptions> {
  const { sessionId, model, ctx, live, usageBySession } = input;
  const [skillInstructions, availableSkills] =
    rt.skills !== undefined
      ? await Promise.all([
          rt.skills.getInstructions(sessionId),
          availableSkillsBlock(rt.skills, sessionId),
        ])
      : ["", ""];
  const options = withoutUndefined<TurnOptions>({
    sessionId,
    isAborted: () => ctx.signal?.aborted === true,
    abortReason: "turn aborted by operator",
    onUsage: (u: TurnUsage) => {
      live.usage = u;
      usageBySession.set(sessionId, u);
    },
    maxRounds: rt.config.maxRoundsPerTurn,
    rateLimit: rateLimitPolicy(rt.config),
    recorder:
      rt.state !== undefined
        ? { record: (rec: ToolCallRecord) => rt.state!.recordToolCall(rec) }
        : undefined,
    contextWindow:
      rt.modelInfo !== undefined ? (rt.modelInfo.getContextWindow(model) ?? undefined) : undefined,
    skillInstructions: skillInstructions === "" ? undefined : skillInstructions,
    availableSkills: availableSkills === "" ? undefined : availableSkills,
    wake: input.wake === true ? true : undefined,
    signal: ctx.signal,
  });
  return options;
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
    // The jobs manager stamps its wake turns (`revive: true` plus the
    // `wake` marker); the flag rides the turn row for transcript styling.
    const wake = req.wake === true;
    const live: LiveTurnState = { turnId: null, usage: undefined };
    usageBySession.set(sessionId, undefined);

    // Hydrate prior context from the canonical transcript, then drain the
    // session's prelude queue: the notice pair lands between the prior
    // transcript and this turn's prompt row, and persists under this
    // turn's id (the batch slice starts before the pair). An unwound turn
    // keeps its delivered pair — a notice never re-delivers.
    const { messages, promptValue, pairCount, turnOpts, sink, turnRowId } = await assembleTurn(
      rt,
      usageBySession,
      {
        sessionId,
        model,
        ctx,
        live,
        usageBySession,
        wake,
        prompt,
      },
    );

    // (The engine heals announced-but-unanswered tool calls before
    // throwing, so the batch persisted in the catch below already
    // carries the stubs and stays hydratable. A delivered harness_notice
    // pair is already balanced — its result row exists — so the healer
    // never stubs it.)
    try {
      await new TurnEngine(sink).run(client, model, messages, tools, turnOpts);
      // On success, persist everything this turn produced: the batch
      // starts at the prelude head (when a pair was delivered) and runs
      // through the prompt and every round the engine appended.
      await persistBatch(rt, sessionId, {
        messages,
        promptValue,
        pairCount,
        turnRowId,
      });
      // Settle the row as finished — the bookkeeping record of a complete
      // turn, never a gate on the stream's success.
      await settleTurnRow(rt, sessionId, turnRowId, "finished", live);
    } catch (err) {
      await settleFailedTurn(
        { rt, sessionId, messages, promptValue, pairCount, turnRowId, live },
        ctx,
        err,
      );
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
  /** The turn's prompt value (the batch boundary anchors on it). */
  readonly promptValue: string;
  /** Delivered prelude pairs (each is [call, result] before the prompt). */
  readonly pairCount: number;
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
  await persistBatch(s.rt, s.sessionId, s);
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
  turnRowId: number | null,
): Promise<{
  messages: ChatCompletionMessageParam[];
  promptValue: string;
  pairCount: number;
}> {
  const prior =
    rt.store !== undefined
      ? ((await rt.store.getTranscript(sessionId)) as Array<Record<string, unknown>>)
      : [];
  const notices: PreludeNotice[] | undefined = rt.prelude?.drain(sessionId);
  const prelude = notices !== undefined ? deliverPrelude(notices) : undefined;
  const messages: ChatCompletionMessageParam[] = [
    ...(prior as unknown as ChatCompletionMessageParam[]),
    ...(prelude ?? []).flatMap((p) => [
      p.call as unknown as ChatCompletionMessageParam,
      p.result as unknown as ChatCompletionMessageParam,
    ]),
    { role: "user", content: prompt },
  ];
  if (prelude !== undefined && notices !== undefined) {
    publishPrelude(rt, sessionId, prelude, notices, turnRowId);
    logger.child({ sessionId }).debug({ pairs: prelude.length }, "turn prelude");
  }
  // The batch boundary anchors on the PROMPT ROW by VALUE (role=user +
  // content=prompt): the settled batch starts there and extends BACK over
  // the prelude pair rows (their synthetic ids are server-generated —
  // call_bg_/call_hn_ — never model-made). Value beats both prior anchors:
  // object identity failed on the live daemon (yog#146: the pair's call
  // row vanished while identity-anchored) and index counts drift under the
  // skills unshift. The prompt value is unique in the turn (the hydrate
  // wrote it); scanning from the END lands on THIS turn's row even when a
  // prior turn's prompt carried the same text.
  return { messages, promptValue: prompt, pairCount: prelude?.length ?? 0 };
}

/** One turn's assembled inputs: the hydrated conversation and the options. */
interface TurnInputs {
  readonly messages: ChatCompletionMessageParam[];
  readonly promptValue: string;
  readonly pairCount: number;
  readonly turnOpts: TurnOptions;
  readonly sink: TurnSink;
  readonly turnRowId: number | null;
}

async function assembleTurn(
  rt: TurnRuntime,
  usageBySession: UsageBySession,
  input: TurnOptionsInput,
): Promise<TurnInputs> {
  const turnRowId = await startTurnRow(rt, input.sessionId, input.prompt, input.model, input.wake);
  const { messages, promptValue, pairCount } = await hydrateMessages(
    rt,
    input.sessionId,
    input.prompt,
    turnRowId,
  );
  const turnOpts = await buildTurnOptions(rt, input);
  const sink = turnSink(rt, input.sessionId, input.live, turnRowId);
  return { messages, promptValue, pairCount, turnOpts, sink, turnRowId };
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
  prelude: DeliveredPrelude[],
  notices: PreludeNotice[],
  turnRowId: number | null,
): void {
  const events: Array<{ type: "tool.call" | "tool.result"; data: Record<string, unknown> }> = [];
  for (const p of prelude) {
    const call = p.call.tool_calls[0]!;
    const fn = call.function;
    events.push({
      type: "tool.call",
      data: { id: call.id, name: fn.name, args: safeJson(fn.arguments) },
    });
    // The result frame carries the paired content verbatim (the true tool
    // result for tool-outcome pairs; the notice payload for the
    // harness_notice pair) — the client's decode path consumes both.
    const content = p.result.content;
    const parsed = safeJson(content);
    // The ok flag mirrors the live engine's rule: a result with an error
    // string failed. A plain parse failure leaves the frame ok (the
    // content still rides for the client to render).
    const failed = typeof (parsed as Record<string, unknown> | undefined)?.["error"] === "string";
    events.push({
      type: "tool.result",
      data: { id: call.id, name: fn.name, ok: !failed, result: parsed },
    });
  }
  void notices;
  for (const ev of events) {
    void rt.store
      ?.addEvent(
        sessionId,
        { type: ev.type, payload: JSON.stringify(ev.data), version: 1 },
        turnRowId ?? undefined,
      )
      .catch(() => undefined);
    (rt.bus as unknown as { emit?: (ch: string, ev: unknown) => void })?.emit?.(
      `session:${sessionId}`,
      { id: 0, type: ev.type, version: 1, ts: Date.now(), data: ev.data },
    );
  }
}

/** Best-effort JSON parse (prelude content is always serialized JSON). */
function safeJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}
