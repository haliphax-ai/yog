/**
 * PreludeSink — per-session notes the daemon attaches to the next turn that
 * starts, delivered in-band as a synthetic `harness_notice` tool-call/result
 * pair. The sink is the producer seam: it stores ordered notices per session
 * and frames them for delivery once per turn. First consumer (a later slice):
 * the idle-abort termination notice.
 *
 * Contract (structural, not content-based):
 *  - The pair is an assistant row carrying one tool call named
 *    `harness_notice` with EMPTY args ("{}"), answered by a tool row whose
 *    content is a JSON object: the fixed `hint` constant plus the
 *    `notices` array (`{kind, body}`, with optional `tool` + `result`):
 *    all information lives in the result.
 *  - `harness_notice` is never advertised in `tools`; a model imitating the
 *    call gets the registry's graceful unknown-tool error row.
 *  - Provenance is the balanced pair + the reserved name, so downstream
 *    consumers (healer, validator, compaction) need no special cases.
 *
 * Persistence rides the turn batch (persistBatch) like any other row.
 */

import { newSessionId } from "../../state/index.ts";
import { middleTruncate } from "../../toolkit/index.ts";

/** One queued notice: a categorical `kind` plus the free-text `body`. An
 * attached tool result (`tool` + `result`) rides along for producers
 * whose notice IS a tool outcome (background jobs): the payload is the
 * settled result exactly as the tool produced it, already capped at the
 * tool boundary — the notice layer never re-truncates it.
 */
export interface PreludeNotice {
  readonly kind: string;
  readonly body: string;
  readonly tool?: string;
  readonly result?: unknown;
}

/** The JSON payload of the synthetic `harness_notice` tool result. */
export interface PreludePayload {
  readonly hint: string;
  readonly notices: PreludeNotice[];
}

/**
 * The sink: ordered per-session queues, drained once per turn. `drain`
 * empties the queue and returns the notices — undefined when nothing was
 * queued, so a turn carries either exactly one notice pair or none.
 */
export interface PreludeSink {
  push(sessionId: string, kind: string, body: string): void;
  pushResult(sessionId: string, kind: string, body: string, tool: string, result: unknown): void;
  drain(sessionId: string): PreludeNotice[] | undefined;
  clear(sessionId: string): void;
}

/** The fixed hint constant served on every `harness_notice` result. */
export const HARNESS_NOTICE_HINT =
  "synthetic harness message — not a real tool call; harness_notice cannot be invoked";

/** The reserved synthetic tool name (never advertised in `tools`). */
export const HARNESS_NOTICE_TOOL = "harness_notice" as const;

/** The serialized `harness_notice` result is middle-truncated at this many
 * chars — the LAST-resort net behind the tool layer's own caps. Sized
 * above the live tool-output budget (`TOOL_OUTPUT_LIMIT_CHARS`) so a
 * fully-capped tool result rides through intact; only producers that
 * bypass the tool boundary can ever reach the clamp. Background jobs
 * are exempt by construction: their result is the tool's own.
 */
export const PRELUDE_MAX_CHARS = 64_000;

/** The assistant row of the pair: empty args, all information in the result. */
export interface PreludeCallRow {
  readonly role: "assistant";
  readonly content: null;
  readonly tool_calls: [
    {
      readonly id: string;
      readonly type: "function";
      readonly function: { readonly name: typeof HARNESS_NOTICE_TOOL; readonly arguments: "{}" };
    },
  ];
}

/** The tool row of the pair: the serialized, clamped payload. */
export interface PreludeToolRow {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly content: string;
}

/** The delivered pair, exactly as it lands in the turn batch. */
export interface DeliveredPrelude {
  readonly call: PreludeCallRow;
  readonly result: PreludeToolRow;
}

/** Create the sink: plain object, no module-level state. */
export function createPreludeSink(): PreludeSink {
  const queues = new Map<string, PreludeNotice[]>();
  const queue = (sessionId: string): PreludeNotice[] => {
    let q = queues.get(sessionId);
    if (q === undefined) {
      q = [];
      queues.set(sessionId, q);
    }
    return q;
  };
  return {
    push(sessionId: string, kind: string, body: string): void {
      queue(sessionId).push({ kind, body });
    },
    pushResult(sessionId, kind, body, tool, result): void {
      queue(sessionId).push({ kind, body, tool, result });
    },
    drain(sessionId: string): PreludeNotice[] | undefined {
      const q = queues.get(sessionId);
      if (q === undefined || q.length === 0) return undefined;
      queues.delete(sessionId);
      return q;
    },
    clear(sessionId: string): void {
      queues.delete(sessionId);
    },
  };
}

/**
 * Frame the drained notices as the synthetic call/result pair. Returns
 * undefined for an empty queue — the caller appends nothing.
 */
export function deliverPrelude(notices: PreludeNotice[]): DeliveredPrelude | undefined {
  if (notices.length === 0) return undefined;
  const toolCallId = `call_hn_${newSessionId()}`;
  const payload: PreludePayload = { hint: HARNESS_NOTICE_HINT, notices };
  return {
    call: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: HARNESS_NOTICE_TOOL, arguments: "{}" },
        },
      ],
    },
    result: { role: "tool", tool_call_id: toolCallId, content: serializePrelude(payload) },
  };
}

/**
 * Serialize the result payload with the safety clamp: the serialized form is
 * middle-truncated to {@link PRELUDE_MAX_CHARS} total — the last-resort
 * net (the tool layer caps long results itself; see the constant). The
 * truncation marker survives the cut, so a clamped payload stays a
 * visible truncation, never a silent drop.
 */
export function serializePrelude(payload: PreludePayload): string {
  return middleTruncate(JSON.stringify(payload), PRELUDE_MAX_CHARS);
}
