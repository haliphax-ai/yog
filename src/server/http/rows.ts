import type { RoundAttribution, StoreBoundary } from "./types.ts";
import { parseEventPayload } from "./transcript.ts";

/** Build one turn's round attribution from a persisted tool.result row. */
export function attributionFromEvent(
  ev: Record<string, unknown>,
  resultTokensByCall: Map<string, number>,
): RoundAttribution | undefined {
  if (ev.type !== "tool.result") return undefined;
  const data = parseEventPayload(ev);
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const rec = data as {
    usage?: unknown;
    promptDelta?: unknown;
    resultTokens?: unknown;
    id?: unknown;
  };
  const round: RoundAttribution = {};
  if (rec.usage !== undefined) round.usage = rec.usage;
  if (typeof rec.promptDelta === "number" && Number.isFinite(rec.promptDelta)) {
    round.promptDelta = rec.promptDelta;
  }
  if (
    typeof rec.resultTokens === "number" &&
    Number.isFinite(rec.resultTokens) &&
    rec.resultTokens > 0
  ) {
    resultTokensByCall.set(String(rec.id), rec.resultTokens);
  }
  return Object.keys(round).length > 0 ? round : undefined;
}

/** Synthetic rows (user prompt + assistant/tool rounds) for one running turn. */
/** Wire-shape tool call from a persisted `tool.call` event payload. */
export function toolCallFromEvent(data: Record<string, unknown>): {
  id: string;
  name: string;
  arguments: string;
} {
  return {
    id: typeof data.id === "string" ? data.id : "",
    name: typeof data.name === "string" ? data.name : "",
    arguments: typeof data.args === "string" ? data.args : JSON.stringify(data.args ?? {}),
  };
}

/** Wire-shape tool result row from a persisted `tool.result` event payload. */
export function toolResultRow(
  data: Record<string, unknown>,
  turnId: number,
  nextSeq: () => number,
): Record<string, unknown> {
  let resultPayload: unknown = null;
  if (data.result !== undefined) resultPayload = data.result;
  else if (data.error) resultPayload = { error: data.error };
  return {
    seq: nextSeq(),
    turnId,
    role: "tool",
    content:
      typeof resultPayload === "string" ? resultPayload : JSON.stringify(resultPayload ?? null),
    toolCallId: typeof data.id === "string" ? data.id : undefined,
    name: typeof data.name === "string" ? data.name : undefined,
    ...(typeof data.resultTokens === "number" ? { resultTokens: data.resultTokens } : {}),
    ...(data.usage !== undefined ? { usage: data.usage } : {}),
    ...(typeof data.promptDelta === "number" ? { promptDelta: data.promptDelta } : {}),
  } as Record<string, unknown>;
}

export function syntheticRowsForTurn(
  r: Record<string, unknown>,
  evs: Array<Record<string, unknown>>,
  turnId: number,
  nextSeq: () => number,
): Array<Record<string, unknown>> {
  const synth: Array<Record<string, unknown>> = [];
  // User prompt from the turn row itself.
  const promptText =
    typeof r.prompt === "string"
      ? r.prompt
      : typeof (r.request as any)?.prompt === "string"
        ? (r.request as any).prompt
        : "";
  if (promptText) {
    synth.push({ seq: nextSeq(), turnId, role: "user", content: promptText });
  }
  let assistantText = "";
  let pendingCalls: Array<{ id: string; name: string; arguments: string }> = [];
  const flushAssistant = (): void => {
    if (assistantText) {
      synth.push({
        seq: nextSeq(),
        turnId,
        role: "assistant",
        content: assistantText,
      });
      assistantText = "";
    }
    if (pendingCalls.length > 0) {
      synth.push({
        seq: nextSeq(),
        turnId,
        role: "assistant",
        content: null,
        toolCalls: pendingCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        })),
      });
      pendingCalls = [];
    }
  };
  for (const ev of evs) {
    const data = parseEventPayload(ev);
    if (ev.type === "message.delta" && typeof data.text === "string") {
      assistantText += data.text;
    } else if (ev.type === "tool.call") {
      // A tool call closes the open prose segment (mirrors the
      // engine: text streamed in a tool round is discarded, but
      // completed prose before the call is part of the turn).
      flushAssistant();
      pendingCalls.push(toolCallFromEvent(data));
    } else if (ev.type === "tool.result") {
      flushAssistant();
      synth.push(toolResultRow(data, turnId, nextSeq));
    }
  }
  flushAssistant();
  return synth;
}

/**
 * In-flight (running) turns have no canonical transcript rows yet: serve.ts
 * only appends `messages.slice(startLen)` at settle time, so a reconnecting
 * client polling the dump would see only the previous turn while the
 * in-flight turn generates. Reconstruct the running turn's completed rounds
 * from its persisted `turn_events` (the sink records every event
 * incrementally) and append them as synthetic transcript rows so a poll
 * rehydrates the in-flight turn progressively; settled turns use the real
 * rows and get no synthetic duplicates.
 */
export async function appendSyntheticRunningRows(
  store: StoreBoundary,
  id: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  if (typeof store.listTurns !== "function") return;
  const rowsForSynthetic = ((await store.listTurns(id)) ?? []) as Array<Record<string, unknown>>;
  const runningRows = rowsForSynthetic.filter((r) => r.status === "running");
  if (runningRows.length === 0 || typeof store.listEvents !== "function") return;
  const allEvents = ((await store.listEvents(id)) ?? []) as Array<Record<string, unknown>>;
  const eventsByTurn = new Map<number, Array<Record<string, unknown>>>();
  for (const ev of allEvents) {
    const tid = Number(ev.turn_id);
    if (!Number.isFinite(tid)) continue;
    const list = eventsByTurn.get(tid) ?? [];
    list.push(ev);
    eventsByTurn.set(tid, list);
  }
  let nextSeq =
    messages.reduce((max, m) => Math.max(max, typeof m.seq === "number" ? m.seq : 0), 0) + 1;
  for (const r of runningRows) {
    const turnId = Number(r.id);
    const evs = eventsByTurn.get(turnId) ?? [];
    if (evs.length === 0) continue;
    const synth = syntheticRowsForTurn(r, evs, turnId, () => nextSeq++);
    messages.push(...synth);
  }
}
