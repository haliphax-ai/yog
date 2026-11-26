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
/** One queued notice: a categorical `kind` plus the free-text `body`. */
export interface PreludeNotice {
  readonly kind: string;
  readonly body: string;
  /**
   * Exemption scope for the clamp (see {@link serializePrelude}): a
   * notice whose payload must survive serialization untouched (a
   * background job's settled tool result — already capped at the tool
   * boundary) opts in here. Everything else stays clamped. The
   * exemption is the PRODUCER'S declaration, made at push time; future
   * exempting producers set the flag and never touch the clamp itself.
   */
  readonly exemptFromClamp?: boolean;
  /** Attached tool result (a notice that IS a tool outcome). */
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
 * chars: the clamp on ordinary notices, sized against the context-window
 * math (a long body cannot nuke the model's context). The clamp is
 * PER-NOTICE exemptable — {@link PreludeNotice.exemptFromClamp} — for
 * payloads that are already size-safe by construction (a background
 * job's settled tool result was capped at the tool boundary; clamping
 * it would only shred the JSON). The exemption is declared by the
 * PRODUCER at push time; this module owns only the mechanism.
 */
export const PRELUDE_MAX_CHARS = 4_000;

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
      queue(sessionId).push({
        kind,
        body,
        tool,
        result,
        // Background jobs notices carry an already-capped tool result:
        // exempt from the clamp. The exemption is per-notice, not global.
        exemptFromClamp: true,
      });
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
 * The per-notice clamp. Exempt notices ride through untouched — the
 * exemption is the PRODUCER'S declaration ({@link PreludeNotice
 * .exemptFromClamp}): the payload is already size-safe by construction
 * (a background job's tool result was capped at the tool boundary),
 * and this layer must not second-guess tool-owned data. Everything else
 * is serialized whole then middle-truncated to {@link PRELUDE_MAX_CHARS}
 * — the marker survives the cut, so a clamped payload stays a visible
 * truncation, never a silent drop.
 */
export function serializePrelude(payload: PreludePayload): string {
  const exempt = payload.notices.every((n) => n.exemptFromClamp === true);
  const json = JSON.stringify(payload);
  return exempt ? json : middleTruncate(json, PRELUDE_MAX_CHARS);
}
