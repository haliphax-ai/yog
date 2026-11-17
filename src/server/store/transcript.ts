import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";

/** Row-shape options for {@link transcriptRows}. */
export interface TranscriptOptions {
  /** Round attribution per turn (from the persisted `tool.result` event). */
  readonly roundAttribution?: Map<number, { usage?: unknown; promptDelta?: number }>;
  /** Per-call token estimates keyed by tool call id. */
  readonly resultTokensByCall?: Map<string, number>;
}

/** Paging options for {@link SessionStore.getTranscript} (§4.2). */
export interface PagingOptions {
  /** Page forward from a known seq (exclusive). */
  readonly afterSeq?: number;
  /** Cap the batch length. */
  readonly limit?: number;
}

/**
 * Attach round attribution to a tool result row: `usage` and `promptDelta`
 * sourced from the turn's persisted `tool.result` event — the same envelope
 * fields the live stream emitted — so rehydrated transcripts can render the
 * same per-result counts. Non-tool rows (and turns with no stored
 * tool.result event: legacy volumes, no-usage providers) stay untouched.
 */
function attachRoundAttribution(
  msg: Record<string, unknown>,
  role: unknown,
  round: { usage?: unknown; promptDelta?: number } | undefined,
): void {
  if (role !== "tool" || round === undefined) return;
  if (round.usage !== undefined) msg.usage = round.usage;
  if (round.promptDelta !== undefined) msg.promptDelta = round.promptDelta;
}

/**
 * Attach the per-call token estimate to a tool result row (keyed by tool
 * call id). Rows without a string tool call id, or whose call has no
 * stored estimate, stay untouched.
 */
function attachResultTokens(
  msg: Record<string, unknown>,
  role: unknown,
  toolCallId: unknown,
  resultTokensByCall: ReadonlyMap<string, number> | undefined,
): void {
  if (
    role !== "tool" ||
    typeof toolCallId !== "string" ||
    resultTokensByCall === undefined ||
    !resultTokensByCall.has(toolCallId)
  ) {
    return;
  }
  msg.resultTokens = resultTokensByCall.get(toolCallId);
}

/**
 * Map one transcript row to its `ChatCompletionMessageParam`-shaped
 * message: the role plus every set column (nulls stay absent), tool calls
 * decoded from their JSON column.
 */
function transcriptMsg(row: Record<string, unknown>): ChatCompletionMessageParam {
  const msg: Record<string, unknown> = { role: row.role };
  if (row.content !== null) msg.content = row.content;
  if (row.tool_call_id !== null) msg.tool_call_id = row.tool_call_id;
  if (row.name !== null) msg.name = row.name;
  if (row.tool_calls_json !== null) msg.tool_calls = JSON.parse(row.tool_calls_json as string);
  return msg as unknown as ChatCompletionMessageParam;
}

/**
 * Map stored transcript rows (§4.2) to message-shaped objects plus
 * metadata (`seq`, `turnId`, `ts`) so callers can address rows explicitly.
 * See {@link transcriptMsg}, {@link attachRoundAttribution}, and
 * {@link attachResultTokens} for the per-row mapping rules.
 */
export function transcriptRows(
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: TranscriptOptions = {},
): Array<Record<string, unknown>> {
  const attribution = opts.roundAttribution;
  const resultTokensByCall = opts.resultTokensByCall;
  return rows.map((row) => {
    const msg = transcriptMsg(row) as unknown as Record<string, unknown>;
    attachRoundAttribution(msg, row.role, attribution?.get(Number(row.turn_id)));
    attachResultTokens(msg, row.role, row.tool_call_id, resultTokensByCall);
    return {
      ...msg,
      seq: row.seq,
      turnId: row.turn_id,
      ts: row.created_at,
    };
  });
}
