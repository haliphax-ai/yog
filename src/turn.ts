import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { ToolCall, ToolRegistry } from "./toolkit/index.ts";
import type { ToolCallRecord } from "./state/index.ts";

import { logger } from "./log.ts";
import { newSessionId } from "./state/index.ts";
import {
  StdoutSink,
  TURN_EVENT_VERSION,
  type TurnEventDataMap,
  type TurnEvent,
  type TurnEventType,
  type TurnSink,
} from "./turn/sink.ts";

/** Tool calls currently executing per session (for the abort endpoint). */
const activeToolCalls = new Map<string, { id: string; name: string; args: string }>();

/** Make an abort-shaped error (mirrors the orchestrator's normalization). */
function makeAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined || reason === null ? "turn aborted" : String(reason));
  err.name = "AbortError";
  return err;
}

/** One OpenAI tool-call round's assistant row shape (subset). */
export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Build the assistant message row that carries `calls` (replay path). */
export function assistantToolCallMessage(calls: AssistantToolCall[]): ChatCompletionMessageParam {
  return { role: "assistant", content: null, tool_calls: calls } as ChatCompletionMessageParam;
}

/**
 * Build the canonical stub tool message for an unanswered tool call:
 * an `error` result so a hydrated follow-up turn sees a definite answer
 * instead of a dangling call (which providers reject).
 */
export function toolStubMessage(toolCallId: string): ChatCompletionMessageParam {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({ error: "tool call aborted before a result was produced" }),
  } as ChatCompletionMessageParam;
}

/**
 * Collect the tool-call ids the transcript announced (assistant rows with
 * `tool_calls`) that never received a `tool` answer message. Any unwind
 * mid-tool-loop (operator abort, provider error) leaves such calls behind;
 * stubbing them keeps the transcript hydratable for the next turn.
 */
export function unansweredToolCallIds(messages: ChatCompletionMessageParam[]): Set<string> {
  const announced = new Set<string>();
  for (const m of messages) {
    const rec = m as { role?: string; tool_calls?: Array<{ id?: string }> };
    if (rec.role === "assistant" && Array.isArray(rec.tool_calls)) {
      for (const tc of rec.tool_calls) {
        if (typeof tc?.id === "string") announced.add(tc.id);
      }
    }
  }
  for (const m of messages) {
    const rec = m as { role?: string; tool_call_id?: string };
    if (rec.role === "tool" && typeof rec.tool_call_id === "string") {
      announced.delete(rec.tool_call_id);
    }
  }
  return announced;
}

/**
 * Agent turn engine: streams one chat completion, executes any tool calls it
 * contains (feeding results back in), and repeats until the model answers
 * without tools. This is the loop every agent run funnels through as the
 * harness grows. Every observable moment — deltas, tool activity, terminal
 * states — is emitted as a typed `TurnEvent` on a transport-agnostic
 * `TurnSink`; the default `StdoutSink` reproduces the original stdout bytes.
 */
export interface TurnOptions {
  /** Abort the in-flight model stream (used for graceful SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Session id stamped on audit rows. */
  sessionId?: string;
  /** Best-effort audit recorder (failures never abort the turn). */
  recorder?: { record(rec: ToolCallRecord): Promise<void> };
  /**
   * Abort sentinel probed at every await point (round boundary, tool call).
   * When it flips, the engine stops streaming/executing and throws the
   * abort error — the loop cannot miss an abort that arrives mid-tool.
   */
  isAborted?: () => boolean;
  /**
   * Abort reason (message/code) for the terminal error event when the turn
   * unwinds via `isAborted`.
   */
  abortReason?: string;
  /**
   * Called when the engine heals the transcript during an unwind (abort or
   * terminal error mid-tool-loop): the caller learns which tool-call ids
   * were stubbed so it can persist the healed batch.
   */
  onHeal?: (stubbedToolCallIds: string[]) => void;
}

/**
 * The turn loop, bound to a `TurnSink`: every observable moment (stream
 * deltas, tool activity, terminal states) is emitted as a typed event to the
 * sink instead of being written to stdout directly. The engine awaits every
 * `emit`, so slow transports exert backpressure on the loop.
 */
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
    const emit = <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]): Promise<void> =>
      this.sink.emit({
        id: nextEventId++,
        type,
        version: TURN_EVENT_VERSION,
        ts: Date.now(),
        data,
      } as TurnEvent<T>);

    try {
      await emit("turn.started", { turnId, model: modelId, ts: Date.now() });

      // Abort probe: checked at every await boundary so an abort arriving
      // mid-tool-call or mid-stream still unwinds the turn deterministically.
      const abortErr = () => makeAbortError(opts.abortReason ?? "turn aborted");
      const checkAbort = (): void => {
        if (opts.isAborted?.() === true) throw abortErr();
      };
      checkAbort();

      // Bound the tool-call loop so a misbehaving model cannot spin forever.
      for (let round = 0; round < 16; round++) {
        const stream = await client.chat.completions.create({
          model: modelId,
          messages,
          tools: tools.definitions,
          stream: true,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });

        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        // Accumulate this round's assistant text. It is only ever appended to
        // `messages` on the no-tool-calls path (plan §4.3): a tool-call round
        // streams text too, but its assistant row carries `tool_calls` and the
        // text is discarded exactly as before.
        let assistantText = "";

        for await (const chunk of stream) {
          checkAbort();
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            await emit("message.delta", { text: delta.content });
            assistantText += delta.content;
          }

          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
            toolCalls.set(index, entry);
            // Track announced calls as they stream: a mid-stream abort
            // unwinds before the assistant row is pushed, and the heal path
            // reconstructs the call from this tracker entry.
            if (entry.id && entry.name && opts.sessionId !== undefined) {
              activeToolCalls.set(opts.sessionId, { ...entry });
            }
          }
        }

        if (toolCalls.size === 0) {
          // Plan §4.3: the caller diffs by index, so the final assistant text
          // message must be in `messages` before the turn ends. A round that
          // streamed text but also made tool calls keeps its `content: null`
          // tool_calls row as-is; only the terminal no-tool round appends.
          if (assistantText) {
            messages.push({ role: "assistant", content: assistantText });
          }
          await emit("turn.finished", {
            turnId,
            durationMs: Date.now() - turnStartedAt,
          });
          return;
        }

        const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b);

        // Replay the assistant turn, then append one tool message per call.
        const assistantCallRow: AssistantToolCall[] = ordered.map(([i, tc]) => ({
          id: tc.id || `call_${i}`,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        }));
        messages.push(assistantToolCallMessage(assistantCallRow));

        for (const [i, tc] of ordered) {
          const tcId = tc.id || `call_${i}`;
          await emit("tool.call", {
            id: tcId,
            name: tc.name,
            args: tc.args,
          });

          // Track the in-flight call so an abort can kill it and stub any
          // calls in this round that never produced a result.
          if (opts.sessionId !== undefined) {
            activeToolCalls.set(opts.sessionId, { id: tcId, name: tc.name, args: tc.args });
          }
          // An abort that fired between rounds (or while the model stream
          // was draining) unwinds here — before the tool starts — so the
          // just-announced call lands in the heal path's stub set.
          checkAbort();

          const startedAt = Date.now();
          const result = await tools.execute(tc.name, tc.args, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            onStart: (call: ToolCall) =>
              void activeToolCalls.set(opts.sessionId ?? "", {
                id: tcId,
                name: call.name,
                args: tc.args,
              }),
            onEnd: () => {
              if (activeToolCalls.get(opts.sessionId ?? "")?.id === tcId) {
                activeToolCalls.delete(opts.sessionId ?? "");
              }
            },
          });
          const completedAt = Date.now();
          const outcome =
            result === undefined
              ? "unknown tool"
              : result["error"]
                ? `error: ${result["error"]}`
                : `exitCode=${result["exitCode"]} runtimeMs=${result["runtimeMs"]}`;
          // Tool activity goes to the structured log so stdout remains a clean response stream.
          logger.error(
            {
              tool: tc.name,
              args: tc.args,
              ok: result !== undefined && result["error"] === undefined,
              outcome,
            },
            `[tool] ${tc.name}(${tc.args}) -> ${outcome}`,
          );

          const toolError = result?.["error"] as string | undefined;

          await emit("tool.result", {
            id: tcId,
            name: tc.name,
            ok: result !== undefined && toolError === undefined,
            result,
            error: toolError ?? (result === undefined ? `unknown tool "${tc.name}"` : undefined),
          });
          if (opts.recorder && opts.sessionId) {
            try {
              await opts.recorder.record({
                name: tc.name,
                parameters: tc.args,
                result: toolError === undefined && result !== undefined ? result : undefined,
                error: toolError,
                startedAt,
                completedAt,
                durationMs: completedAt - startedAt,
                sessionId: opts.sessionId,
              });
            } catch (err) {
              // Non-fatal by contract: an audit failure must never kill the turn.
              logger.error(`[audit] recorder failed: ${(err as Error).message}`);
            }
          }

          const payload =
            result === undefined
              ? JSON.stringify({ error: `unknown tool "${tc.name}"` })
              : JSON.stringify(result);
          messages.push({
            role: "tool",
            tool_call_id: tcId,
            content: payload,
          });
        }
      }
    } catch (err) {
      // Heal first, unconditionally (any unwind mid-tool-loop): every
      // announced tool call without a result gets a stub `tool` message, so
      // the persisted transcript stays hydratable — the next turn replays a
      // definite answer instead of a dangling call (providers reject that).
      // A mid-stream abort can leave the announced tool calls in the
      // tracker without their assistant row in `messages` (the row is only
      // pushed after the stream completes). Reconstruct it so the healed
      // transcript keeps the call the model actually made.
      const tracked =
        opts.sessionId !== undefined ? activeToolCalls.get(opts.sessionId) : undefined;
      if (
        tracked &&
        !messages.some((m) =>
          (m as { tool_calls?: { id?: string }[] }).tool_calls?.some((tc) => tc.id === tracked.id),
        )
      ) {
        messages.push(
          assistantToolCallMessage([
            {
              id: tracked.id,
              type: "function",
              function: { name: tracked.name, arguments: tracked.args },
            },
          ]),
        );
      }

      const heal: ChatCompletionMessageParam[] = [...unansweredToolCallIds(messages)].map(
        (toolCallId) => toolStubMessage(toolCallId),
      );
      if (heal.length > 0) {
        messages.push(...heal);
        opts.onHeal?.(heal.map((m) => (m as { tool_call_id: string }).tool_call_id));
      }

      const aborted = opts.signal?.aborted === true || opts.isAborted?.() === true;
      if (aborted) {
        // Abort: terminal `turn.aborted` (not `error`) — the operator ended
        // the turn on purpose; transports surface it and the transcript was
        // healed above. Propagate untouched so the caller maps its exit path.
        await emit("turn.aborted", { reason: opts.abortReason ?? "turn aborted" });
        throw err;
      }
      // Terminal error: emit first (so transports see it), then rethrow so the
      // composition root keeps its existing exit-code handling.
      await emit("error", {
        code: "provider_error",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error ? { details: { name: err.name, stack: err.stack } } : {}),
      });
      throw err;
    } finally {
      // The turn settled (finished or unwound): the abort endpoint must not
      // report a phantom in-flight tool on later calls.
      if (opts.sessionId !== undefined) clearActiveToolCall(opts.sessionId);
    }
  }
}

/**
 * The tool call currently executing (or last started without settling) for
 * `sessionId`, for the abort endpoint: kill the tool first, then unwind.
 */
export function activeToolCallFor(
  sessionId: string,
): { id: string; name: string; args: string } | undefined {
  return activeToolCalls.get(sessionId);
}

/**
 * Drop the active-call tracking entry for `sessionId` (turn fully settled).
 */
export function clearActiveToolCall(sessionId: string): void {
  activeToolCalls.delete(sessionId);
}

/**
 * Convenience wrapper for callers that just want a turn run with the default
 * stdout sink; the composition root uses `TurnEngine` directly so the sink
 * is explicit.
 */
export function runTurn(
  client: OpenAI,
  modelId: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  opts: TurnOptions = {},
  sink?: TurnSink,
): Promise<void> {
  return new TurnEngine(sink ?? new StdoutSink()).run(client, modelId, messages, tools, opts);
}
