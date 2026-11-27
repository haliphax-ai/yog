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
  /**
   * Attached tool outcome: the notice IS a tool result, delivered as the
   * INVERSE of detach — a synthetic call (the original call's name and
   * arguments) paired to the call's TRUE result, so the client renders
   * it through the same call/result component any live call uses and the
   * model sees a well-formed tool round. No user-message parsing: the
   * pair rides the transcript like any other rows.
   */
  readonly tool?: string;
  /** The original call's raw JSON arguments (the synthetic call echoes them). */
  readonly argsJson?: string | null;
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
  /** A tool-outcome notice: the notice IS a tool result (see
   *  {@link PreludeNotice.tool}). */
  pushResult(sessionId: string, notice: PreludeNotice): void;
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
/** NO second truncation pass here: an attached result was already capped
 *  at the tool boundary (the tool layer owns truncation), and the
 *  per-notice exemption below is that contract. (The 3.1 MB pair that
 *  killed turn 631 was 203 notices x 50k — the BATCH is what compounded,
 *  and the batch cap lives at delivery: maxJobsPerWake on the wake
 *  prompt. The sink never second-guesses tool-owned data.) */

/** The assistant row of a prelude pair: one synthetic call, all
 *  information in the paired result. `harness_notice` pairs carry empty
 *  args; tool-outcome pairs echo the original call's name and args. */
export interface PreludeCallRow {
  readonly role: "assistant";
  readonly content: null;
  readonly tool_calls: [
    {
      readonly id: string;
      readonly type: "function";
      readonly function: { readonly name: string; readonly arguments: string };
    },
  ];
}

/** The tool row of the pair: the serialized, clamped payload. `name` rides
 *  it (the original tool) so an orphan result still labels with the tool,
 *  not the synthetic call id (yog#146). */
export interface PreludeToolRow {
  readonly role: "tool";
  readonly tool_call_id: string;
  readonly name?: string;
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
    pushResult(sessionId, notice): void {
      queue(sessionId).push(notice);
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
 * Frame the drained notices as transcript rows. A notice that IS a tool
 * outcome becomes the inverse of its detach: a SYNTHETIC call (the
 * original call's name + arguments) paired to the call's TRUE result —
 * the client's standard pairing renders it through the same component
 * any live call uses, and the model sees a well-formed tool round.
 * Ordinary notices share one `harness_notice` pair as before. Returns
 * undefined for an empty queue — the caller appends nothing.
 */
export function deliverPrelude(notices: PreludeNotice[]): DeliveredPrelude[] | undefined {
  if (notices.length === 0) return undefined;
  const out: DeliveredPrelude[] = [];
  const plain: PreludeNotice[] = [];
  for (const n of notices) {
    if (n.tool === undefined) {
      plain.push(n);
      continue;
    }
    const toolCallId = `call_bg_${newSessionId()}`;
    out.push({
      call: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: toolCallId,
            type: "function",
            function: {
              name: n.tool,
              arguments: n.argsJson ?? "{}",
            },
          },
        ],
      },
      // The name rides the result row: a client that pairs it with the
      // call renders ⚙️/bash normally, and one that misses the call row
      // (an orphan result) still labels the outcome with the TOOL, not the
      // synthetic call id (yog#146 — the id is already on the row above).
      result: {
        role: "tool",
        tool_call_id: toolCallId,
        name: n.tool,
        content: JSON.stringify(n.result ?? {}),
      },
    });
  }
  if (plain.length > 0) {
    const toolCallId = `call_hn_${newSessionId()}`;
    const payload: PreludePayload = { hint: HARNESS_NOTICE_HINT, notices: plain };
    out.push({
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
    });
  }
  return out;
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
