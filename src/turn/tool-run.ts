/**
 * One tool call's execution, as a turn engine round runs it: registry
 * execution with the turn's abort plumbing, in-flight bookkeeping for the
 * abort endpoint, the `tool.result` emission (round attribution +
 * per-result estimate), and the best-effort audit row.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { ToolCall, ToolRegistry } from "../toolkit/index.ts";
import type { ToolCallRecord } from "../state/index.ts";

import { estimateTokenCount } from "tokenx";
import { logger } from "../log.ts";
import type { TurnEventDataMap, TurnEventType, TurnUsage } from "./sink.ts";
import type { TurnOptions } from "./engine-types.ts";
import type { TrackedCall } from "./messages.ts";

/** Everything one tool call needs at execution time. */
export interface ToolCallRun {
  /** The engine's emit (tool.call/tool.result + backpressure). */
  emit: <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]) => Promise<void>;
  /** The tool registry (definitions + execute). */
  tools: ToolRegistry;
  /** Turn options (signal/isAborted/sessionId/recorder). */
  opts: TurnOptions;
  /** Live in-flight call per session id (the abort endpoint's target). */
  activeToolCalls: Map<string, TrackedCall>;
}

/** Outcome summary of one tool execution (drives the `[tool]` log line). */
function toolOutcome(
  result: Record<string, unknown> | undefined,
  name: string,
): { error?: string; text: string; ok: boolean } {
  const error = result?.["error"] as string | undefined;
  if (result === undefined) return { text: `unknown tool "${name}"`, ok: false };
  return {
    error,
    ok: error === undefined,
    text: error
      ? `error: ${error}`
      : `exitCode=${result["exitCode"]} runtimeMs=${result["runtimeMs"]}`,
  };
}

/** One settled tool call's audit inputs (see recordToolAudit). */
interface ToolAudit {
  opts: TurnOptions;
  sessionId: string | undefined;
  call: { name: string; args: string };
  outcome: { error?: string };
  result: Record<string, unknown> | undefined;
  startedAt: number;
  completedAt: number;
}

/** Record one audit row (best effort: failures never abort the turn). */
async function recordToolAudit(audit: ToolAudit): Promise<void> {
  const { opts, sessionId, call, outcome, result, startedAt, completedAt } = audit;
  if (!opts.recorder || !sessionId) return;
  try {
    await opts.recorder.record({
      name: call.name,
      parameters: call.args,
      result: outcome.error === undefined && result !== undefined ? result : undefined,
      error: outcome.error,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      sessionId,
    } satisfies ToolCallRecord);
  } catch (err) {
    // Non-fatal by contract: an audit failure must never kill the turn.
    logger.error(`[audit] recorder failed: ${(err as Error).message}`);
  }
}

/**
 * Execute one announced tool call: run it through the registry with the
 * turn's abort plumbing, clear the in-flight tracker (belt-and-braces —
 * validation failures return before the registry fires onEnd), log the
 * outcome, emit `tool.result` (round usage + prompt delta + per-result
 * estimate), record the audit row best-effort, and return the transcript
 * `tool` message row.
 */
export async function runToolCall(
  tcId: string,
  tc: TrackedCall,
  roundUsage: TurnUsage | undefined,
  promptDelta: number | undefined,
  run: ToolCallRun,
): Promise<ChatCompletionMessageParam> {
  const { emit, tools, opts, activeToolCalls } = run;
  const sessionId = opts.sessionId;
  const startedAt = Date.now();
  const result = await tools.execute(tc.name, tc.args, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.isAborted ? { isAborted: opts.isAborted } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    onStart: (call: ToolCall) =>
      void activeToolCalls.set(sessionId ?? "", { id: tcId, name: call.name, args: tc.args }),
    onEnd: () => {
      if (activeToolCalls.get(sessionId ?? "")?.id === tcId) {
        activeToolCalls.delete(sessionId ?? "");
      }
    },
  });
  // Belt-and-braces: validation failures return before the registry fires
  // onEnd (the tool never started), so clear the in-flight entry here too
  // — a settled call must never look active.
  if (sessionId !== undefined && activeToolCalls.get(sessionId)?.id === tcId) {
    activeToolCalls.delete(sessionId);
  }
  const completedAt = Date.now();
  const outcome = toolOutcome(result as Record<string, unknown> | undefined, tc.name);
  // Tool activity goes to the structured log so stdout remains a clean response stream.
  logger.error(
    { tool: tc.name, args: tc.args, ok: outcome.ok, outcome: outcome.text },
    `[tool] ${tc.name}(${tc.args}) -> ${outcome.text}`,
  );
  const payload =
    result === undefined ? JSON.stringify({ error: outcome.text }) : JSON.stringify(result);
  // Per-result estimate rides the event for UI stat rows; the round-level
  // usage is the authoritative native count.
  const resultTokens = estimateTokenCount(payload);
  await emit("tool.result", {
    id: tcId,
    name: tc.name,
    ok: outcome.ok,
    result,
    error: outcome.error ?? (result === undefined ? outcome.text : undefined),
    ...(roundUsage !== undefined ? { usage: roundUsage } : {}),
    ...(promptDelta !== undefined ? { promptDelta } : {}),
    ...(resultTokens > 0 ? { resultTokens } : {}),
  });
  await recordToolAudit({
    opts,
    sessionId,
    call: tc,
    outcome,
    result: result as Record<string, unknown>,
    startedAt,
    completedAt,
  });
  return { role: "tool", tool_call_id: tcId, content: payload } as ChatCompletionMessageParam;
}
