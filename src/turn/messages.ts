/**
 * Transcript surgery for the tool-call loop: the assistant tool-call row,
 * the canonical stub tool message, and the unwind healer that keeps a
 * transcript hydratable after any mid-tool-loop unwind (operator abort,
 * provider error, max rounds).
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";

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

/** Tool calls announced but not yet reflected in `messages`. */
export interface TrackedCall {
  id: string;
  name: string;
  args: string;
}

/** The ids already present as assistant tool_calls rows in `messages`. */
function announcedInMessages(messages: ChatCompletionMessageParam[]): Set<string> {
  const ids = new Set<string>();
  for (const m of messages) {
    const calls = (m as { tool_calls?: Array<{ id?: string }> }).tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const tc of calls) {
      if (typeof tc?.id === "string") ids.add(tc.id);
    }
  }
  return ids;
}

/**
 * Heal an unwound transcript in place (any unwind mid-tool-loop): every
 * announced tool call without a result gets a stub `tool` message, so the
 * persisted transcript stays hydratable — the next turn replays a definite
 * answer instead of a dangling call (providers reject that). A mid-stream
 * abort can leave announced calls in the ledger without their assistant
 * row in `messages` (the row is only pushed after the stream completes),
 * so every missing call is reconstructed first — not just the latest
 * in-flight entry.
 */
export function healUnwoundMessages(
  messages: ChatCompletionMessageParam[],
  announcedCalls: Map<string, TrackedCall>,
  onHeal?: (stubbedToolCallIds: string[]) => void,
): void {
  const inMessages = announcedInMessages(messages);
  const missingCalls = [...announcedCalls.values()].filter((call) => !inMessages.has(call.id));
  if (missingCalls.length > 0) {
    messages.push(
      assistantToolCallMessage(
        missingCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.args },
        })),
      ),
    );
  }
  const heal: ChatCompletionMessageParam[] = [...unansweredToolCallIds(messages)].map(
    (toolCallId) => toolStubMessage(toolCallId),
  );
  if (heal.length > 0) {
    messages.push(...heal);
    onHeal?.(heal.map((m) => (m as { tool_call_id: string }).tool_call_id));
  }
}
