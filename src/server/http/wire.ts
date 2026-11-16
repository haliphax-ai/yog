import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { SseEnvelope } from "../sse.ts";
import { toolStubMessage, unansweredToolCallIds } from "../../turn.ts";
/**
 * Build the terminal `error` envelope synthesized when a turn fails without
 * the engine emitting one: the provider error code (or `provider_error`),
 * its message, and the usage reported up to the cut, when any.
 */
export function providerErrorEnvelope(err: unknown, usage?: unknown): SseEnvelope {
  const e = err as { code?: string; message?: string };
  const code = e.code ?? "provider_error";
  return {
    id: 0,
    type: "error",
    version: 1,
    ts: Date.now(),
    code,
    data: {
      code,
      message: e.message ?? String(err),
      ...(usage !== undefined ? { usage } : {}),
    },
  } as SseEnvelope;
}

/** Stored usage columns on a turn row (numeric and finite), or undefined. */
export function turnUsageFromRow(row: Record<string, unknown>): Record<string, number> | undefined {
  const usage: Record<string, number> = {};
  let has = false;
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
    const n = row[key];
    if (typeof n === "number" && Number.isFinite(n)) {
      usage[key] = n;
      has = true;
    }
  }
  return has ? usage : undefined;
}

/** Usage embedded in a stored terminal event payload (recovery fallback). */
export function turnUsageFromEvents(events: unknown[]): Record<string, number> | undefined {
  for (const raw of events) {
    const ev = raw as { type?: string; data?: unknown };
    if (ev.type !== "turn.finished" && ev.type !== "turn.aborted" && ev.type !== "error") continue;
    const data = ev.data as { usage?: unknown } | undefined;
    const u = data?.usage;
    if (u === null || typeof u !== "object" || Array.isArray(u)) continue;
    const rec = u as Record<string, unknown>;
    const usage: Record<string, number> = {};
    let has = false;
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) {
      const n = rec[key];
      if (typeof n === "number" && Number.isFinite(n)) {
        usage[key] = n;
        has = true;
      }
    }
    if (has) return usage;
  }
  return undefined;
}

/**
 * §4.6 wire shape for one transcript message: the store's snake_case columns
 * (`tool_call_id`, `tool_calls`) become camelCase (`toolCallId`, `toolCalls`);
 * only the contract's known keys cross the boundary. The store itself stays
 * snake_case — its rows feed the model hydrate (OpenAI message shape) — the
 * conversion is a route-layer concern. Round attribution on tool result rows
 * (`usage`, `promptDelta`) is forwarded when present, matching the live
 * `tool.result` envelope so rehydration renders the same counts.
 */
export function toWireMessage(m: unknown): Record<string, unknown> {
  const row = (m ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["seq", "turnId", "ts", "role", "content", "name"] as const) {
    if (key in row) out[key] = row[key];
  }
  if (row.tool_call_id !== undefined) out.toolCallId = row.tool_call_id;
  if (row.tool_calls !== undefined) out.toolCalls = row.tool_calls;
  if (row.usage !== undefined) out.usage = row.usage;
  if (row.promptDelta !== undefined) out.promptDelta = row.promptDelta;
  if (row.resultTokens !== undefined) out.resultTokens = row.resultTokens;
  return out;
}

/**
 * Heal a fallback-path transcript in place: stub every tool call the
 * messages announce but never answer, so the batch persisted on error
 * stays hydratable (the engine heals the orchestrator path the same way;
 * providers reject dangling calls). Prior turns are already answered,
 * so this only stubs this turn's dangling calls.
 */
export function healFallbackMessages(messages: ChatCompletionMessageParam[]): void {
  const heal: ChatCompletionMessageParam[] = [...unansweredToolCallIds(messages)].map(
    (toolCallId) => toolStubMessage(toolCallId),
  );
  if (heal.length > 0) messages.push(...heal);
}
