/**
 * The model-stream driver for one round: acquire the stream (bounded 429
 * retry around the initial `create()` only), then drain it — folding each
 * chunk, bookkeeping announced calls, and emitting prose deltas. Mid-stream
 * failures stay terminal; the abort signal tears the stream down at once.
 */

import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { ToolRegistry } from "../toolkit/index.ts";

import {
  consumeChunk,
  type AnnouncedCall,
  type ConsumedChunk,
  type StreamChunk,
} from "./stream-fold.ts";
import type { RateLimitPolicy } from "./rate-limit.ts";
import { emitRateLimited } from "./rate-limit-wait.ts";
import type { TurnEventDataMap, TurnEventType, TurnUsage } from "./sink.ts";
import type { TurnOptions } from "./engine-types.ts";
import { isRateLimitError } from "./rate-limit.ts";

/** One streamed round, fully drained. */
export interface DrainedRound {
  /** Calls the model announced this round, keyed by stream index. */
  toolCalls: Map<number, AnnouncedCall>;
  /** The round's accumulated assistant prose (appended only when no calls). */
  assistantText: string;
  /** The round's provider usage, when the stream reported any. */
  roundUsage: TurnUsage | undefined;
}

/** Inputs for draining one round's stream. */
export interface RoundDrainContext {
  /** The turn's emit (message.delta + backpressure). */
  emit: <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>;
  /** Abort probe (mid-stream flips tear the stream down and throw). */
  checkAbort: () => void;
  /** The abort error the drain throws when the probe flips. */
  abortErr: () => Error;
  /** Announced-call ledger (turn-wide; the heal path reconstructs from it). */
  announcedCalls: Map<string, AnnouncedCall>;
  /** Live in-flight call per session id (the abort endpoint's target). */
  activeToolCalls: Map<string, AnnouncedCall>;
  opts: TurnOptions;
}

/** Everything one round's stream acquisition needs. */
export interface RoundStreamRequest {
  client: OpenAI;
  /** The (unchanged) transcript the request is resubmitted with on retry. */
  messages: ChatCompletionMessageParam[];
  tools: ToolRegistry;
  modelId: string;
  opts: TurnOptions;
  policy: RateLimitPolicy;
  /** 0-based tool-loop round whose request this is. */
  round: number;
  emit: <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>;
  checkAbort: () => void;
  /** Counts one backoff for the terminal `turn.finished` payload. */
  countRetry: () => void;
}

/**
 * Acquire one round's stream: the 429 retry wrapper around the initial
 * `create()` only. `maxRetries: 0` disables the SDK's own silent retries so
 * every backoff is the one signalled via `rate_limited` (the SDK would
 * otherwise retry 429s invisibly before yog ever sees them). The body still
 * carries `signal` for fakes/older SDKs that read options from the body;
 * the second argument is the canonical RequestOptions location.
 */
export async function createRoundStream(
  req: RoundStreamRequest,
): Promise<AsyncIterable<StreamChunk>> {
  let attempt = 0;
  for (;;) {
    req.checkAbort();
    try {
      return (await req.client.chat.completions.create(
        {
          model: req.modelId,
          messages: req.messages,
          tools: req.tools.definitions,
          stream_options: { include_usage: true },
          stream: true,
          ...(req.opts.signal ? { signal: req.opts.signal } : {}),
        },
        { maxRetries: 0, ...(req.opts.signal ? { signal: req.opts.signal } : {}) },
      )) as AsyncIterable<StreamChunk>;
    } catch (err) {
      if (!isRateLimitError(err)) throw err;
      attempt += 1;
      if (attempt >= req.policy.maxAttempts) throw err;
      // Loop: resubmit the *identical* `messages` array. Nothing was
      // appended by the failed call, so no synthetic message and no
      // tool re-execution are needed (or correct).
      await emitRateLimited(
        req.emit,
        req.checkAbort,
        { round: req.round, attempt, policy: req.policy, err },
        req.countRetry,
      );
    }
  }
}

/**
 * Drain one round's model stream into fold state: usage aggregates
 * (turn-wide + round copy), announced-call bookkeeping, and prose delta
 * emission. The abort probe runs per chunk — a flip aborts the stream
 * immediately (no waiting for a round seam) and throws to the unwind path.
 */
export async function drainRoundStream(
  stream: AsyncIterable<StreamChunk>,
  state: { usage: TurnUsage | undefined; lastUsage: TurnUsage | undefined },
  ctx: RoundDrainContext,
): Promise<DrainedRound> {
  const toolCalls = new Map<number, AnnouncedCall>();
  let assistantText = "";
  let roundUsage: TurnUsage | undefined;
  for await (const chunk of stream) {
    // Hard abort: drop the model stream the moment the signal fires —
    // no waiting for a round seam, no consuming remaining output. The
    // abort error propagates to the unwind/heal path below.
    if (ctx.opts.signal?.aborted === true || ctx.opts.isAborted?.() === true) {
      abortStream(stream);
      throw ctx.abortErr();
    }
    const consumed: ConsumedChunk = consumeChunk(chunk, {
      usage: state.usage,
      roundUsage,
      toolCalls,
      assistantText,
      lastUsage: state.lastUsage,
      onUsage: ctx.opts.onUsage,
    });
    state.usage = consumed.usage;
    roundUsage = consumed.roundUsage;
    assistantText = consumed.assistantText;
    state.lastUsage = consumed.lastUsage;
    trackAnnounced(consumed.announced, ctx);
    if (consumed.deltaText !== undefined) {
      await ctx.emit("message.delta", { text: consumed.deltaText });
    }
  }
  return { toolCalls, assistantText, roundUsage };
}

/** Track calls announced by one chunk (turn ledger + live in-flight map). */
function trackAnnounced(announced: AnnouncedCall[], ctx: RoundDrainContext): void {
  for (const call of announced) {
    // Track announced calls as they stream: a mid-stream abort unwinds
    // before the assistant row is pushed, and the heal path reconstructs
    // the call from this tracker entry.
    ctx.announcedCalls.set(call.id, { ...call });
    if (ctx.opts.sessionId !== undefined) {
      ctx.activeToolCalls.set(ctx.opts.sessionId, { ...call });
    }
  }
}

/** Tear the model stream down (best effort — SDK shape only). */
function abortStream(stream: AsyncIterable<StreamChunk>): void {
  const s = stream as { controller?: { abort(reason?: unknown): void } };
  s.controller?.abort();
}
