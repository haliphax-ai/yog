/**
 * TurnEngine — the agent turn loop, bound to a `TurnSink`: stream one chat
 * completion, execute any tool calls it contains (feeding results back in),
 * and repeat until the model answers without tools. Every observable moment
 * — deltas, tool activity, terminal states — is emitted as a typed
 * `TurnEvent` on the sink. The engine awaits every `emit`, so slow
 * transports exert backpressure on the loop. The composition root supplies
 * its own sink (the engine never writes stdout itself; see `StdoutSink` in
 * turn/sink.ts (re-exported by the barrel) for the CLI shape).
 */

import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { ToolRegistry } from "../toolkit/index.ts";

import { newSessionId } from "../state/index.ts";
import {
  TURN_EVENT_VERSION,
  type TurnEvent,
  type TurnEventDataMap,
  type TurnEventType,
  type TurnSink,
  type TurnUsage,
} from "./sink.ts";
import { isRateLimitError, resolveRateLimitPolicy } from "./rate-limit.ts";
import {
  assistantToolCallMessage,
  healUnwoundMessages,
  type AssistantToolCall,
  type TrackedCall,
} from "./messages.ts";
import type { AnnouncedCall } from "./stream-fold.ts";
import { createRoundStream, drainRoundStream } from "./stream-driver.ts";
import { roundUsageAttribution } from "./usage.ts";
import { runToolCall } from "./tool-run.ts";
import { emitTurnError } from "./error-emit.ts";
import { emitTurnFinished, emitTurnMaxRounds } from "./terminal.ts";
import { injectSkillContext } from "./skills.ts";
import type { TurnOptions } from "./engine-types.ts";
import { makeAbortError } from "./abort.ts";
import { activeToolCalls, clearActiveToolCall } from "./active-tool-calls.ts";

/** In-flight sink event emitter bound to this engine's envelope counter. */
type TurnEmit = <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>;

export class TurnEngine {
  private readonly sink: TurnSink;

  constructor(sink: TurnSink) {
    this.sink = sink;
  }

  async run(
    client: OpenAI,
    modelId: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
    opts: TurnOptions = {},
  ): Promise<void> {
    // Turn identity and envelope ids are per-turn: the contract guarantees
    // monotonic ids within a turn, not across turns.
    const turnId = newSessionId();
    const turnStartedAt = Date.now();
    let nextEventId = 0;
    const emit: TurnEmit = <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) =>
      this.sink.emit({
        id: nextEventId++,
        type,
        version: TURN_EVENT_VERSION,
        ts: Date.now(),
        data,
      } as TurnEvent<T>);

    // Declared outside `try` so the unwind/heal path in `catch` can
    // reconstruct assistant rows for calls announced before the unwind.
    const announcedCalls = new Map<string, AnnouncedCall>();
    // Declared outside `try` so the error path can reference it: the last
    // usage seen anywhere in the turn, carried on the terminal error event.
    let lastUsage: TurnUsage | undefined;
    try {
      await emit("turn.started", { turnId, model: modelId, ts: Date.now() });

      // Abort probe: checked at every await boundary so an abort arriving
      // mid-tool-call or mid-stream still unwinds the turn deterministically.
      const abortErr = () => makeAbortError(opts.abortReason ?? "turn aborted");
      const checkAbort = (): void => {
        if (opts.signal?.aborted === true || opts.isAborted?.() === true) throw abortErr();
      };
      checkAbort();

      // Skills system: append the skills context to the END of the first
      // system message so everything before it stays prompt-cacheable.
      injectSkillContext(messages, opts);

      // Bound the tool-call loop so a misbehaving model cannot spin forever.
      const maxRounds = opts.maxRounds ?? 200;
      // Accumulate token usage across all rounds: the final chunk of each
      // round's stream carries the request's usage (when the provider supports
      // `include_usage`); merge partial fields so a round that reports only
      // some of them keeps the rest of the running total.
      let usage: TurnUsage | undefined;
      const rateLimitPolicy = resolveRateLimitPolicy(opts.rateLimit);
      // Previous round's prompt_tokens, for the per-round context-growth delta.
      let prevRoundPrompt: number | undefined;
      // Total 429 backoffs this turn (reported on `turn.finished`).
      let rateLimitRetries = 0;
      for (let round = 0; round < maxRounds; round++) {
        const stream = await createRoundStream({
          client,
          messages,
          tools,
          modelId,
          opts,
          policy: rateLimitPolicy,
          round,
          emit,
          checkAbort,
          countRetry: () => {
            rateLimitRetries += 1;
          },
        });
        const roundState = { usage, lastUsage };
        const drained = await drainRoundStream(stream, roundState, {
          emit,
          checkAbort,
          abortErr,
          announcedCalls,
          activeToolCalls,
          opts,
        });
        usage = roundState.usage;
        lastUsage = roundState.lastUsage;

        if (drained.toolCalls.size === 0) {
          // Plan §4.3: the caller diffs by index, so the final assistant text
          // message must be in `messages` before the turn ends. A round that
          // streamed text but also made tool calls keeps its `content: null`
          // tool_calls row as-is; only the terminal no-tool round appends.
          if (drained.assistantText) {
            messages.push({ role: "assistant", content: drained.assistantText });
          }
          await emitTurnFinished(
            emit,
            {
              turnId,
              durationMs: Date.now() - turnStartedAt,
              usage,
              rateLimitRetries,
            },
            opts.contextWindow,
          );
          return;
        }

        const ordered = [...drained.toolCalls.entries()].sort(([a], [b]) => a - b);
        // The provider reports one usage object per round (final chunk), with
        // no per-call segmentation — completion tokens cover reasoning, prose,
        // and every call's args JSON together. The honest attribution is the
        // round itself (see roundUsageAttribution).
        const attribution = roundUsageAttribution({
          roundUsage: drained.roundUsage,
          prevRoundPrompt,
        });
        prevRoundPrompt = attribution.nextPrevPrompt;

        // Replay the assistant turn, then append one tool message per call.
        const assistantCallRow: AssistantToolCall[] = ordered.map(([i, tc]) => ({
          id: tc.id || `call_${i}`,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        }));
        messages.push(assistantToolCallMessage(assistantCallRow));

        await executeToolRounds(messages, ordered, attribution, {
          emit,
          tools,
          opts,
          checkAbort,
          announcedCalls,
        });
      }
      // Round cap reached (clean exhaustion): every executed round's
      // assistant rows and tool results are already in `messages`, so the
      // transcript stays hydratable. Emit the terminal event explicitly —
      // falling off the loop silently would end the stream without any
      // terminal state, leaving clients with a bare stream close and no
      // definite stop reason.
      await emitTurnMaxRounds(emit, {
        turnId,
        durationMs: Date.now() - turnStartedAt,
        usage,
        rateLimitRetries,
      });
    } catch (err) {
      healUnwoundMessages(messages, announcedCalls, opts.onHeal);

      const aborted = opts.signal?.aborted === true || opts.isAborted?.() === true;
      if (aborted) {
        // Hard abort: the adapter framed the terminal `turn.aborted` itself
        // and closed the wire — do NOT emit again here (a late engine event
        // would otherwise land on the next turn's stream via the per-session
        // bus). The transcript was healed above; propagate so the caller
        // settles the turn row.
        throw err;
      }
      // Terminal error: emit first (so transports see it), then rethrow so the
      // composition root keeps its existing exit-code handling.
      await emitTurnError(emit, err, isRateLimitError, lastUsage);
      throw err;
    } finally {
      // The turn settled (finished or unwound): the abort endpoint must not
      // report a phantom in-flight tool on later calls.
      if (opts.sessionId !== undefined) clearActiveToolCall(opts.sessionId);
    }
  }
}

/**
 * Execute one round's announced calls in order (emit, track, run, append):
 * each result row lands in `messages` right after its `tool.call`, so the
 * transcript stays valid at every await point.
 */
async function executeToolRounds(
  messages: ChatCompletionMessageParam[],
  ordered: [number, TrackedCall][],
  attribution: { roundUsage: TurnUsage | undefined; promptDelta: number | undefined },
  ctx: {
    emit: TurnEmit;
    tools: ToolRegistry;
    opts: TurnOptions;
    checkAbort: () => void;
    announcedCalls: Map<string, AnnouncedCall>;
  },
): Promise<void> {
  for (const [i, tc] of ordered) {
    const tcId = tc.id || `call_${i}`;
    // An abort that fired while the round's model stream was draining
    // (or between rounds) throws here — before the tool starts and
    // before its `tool.call` is announced — so the just-reconstructed
    // assistant row lands in the heal path's stub set.
    ctx.checkAbort();
    await ctx.emit("tool.call", { id: tcId, name: tc.name, args: tc.args });
    // Track the in-flight call so an abort can kill it and stub any
    // calls in this round that never produced a result.
    ctx.announcedCalls.set(tcId, { id: tcId, name: tc.name, args: tc.args });
    messages.push(
      await runToolCall(tcId, tc, attribution.roundUsage, attribution.promptDelta, {
        emit: ctx.emit,
        tools: ctx.tools,
        opts: ctx.opts,
        activeToolCalls,
      }),
    );
  }
}
