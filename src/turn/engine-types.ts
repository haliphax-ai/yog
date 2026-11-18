/**
 * Turn engine types that companion modules share (the engine consumes
 * these options; the skill injector and the tool runner read them).
 */

import type { ToolCallRecord } from "../state/index.ts";
import type { RateLimitPolicy } from "./rate-limit.ts";
import type { TurnUsage } from "./sink.ts";

/**
 * Turn engine options. Every observable moment of a turn is emitted as a
 * typed `TurnEvent` on a transport-agnostic `TurnSink`; the composition
 * root supplies the sink and these options.
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
  /**
   * Tool-call rounds allowed in one turn before the engine stops it with
   * `turn.finished { stopReason: "max_rounds" }` (default: 200). The cap
   * bounds a misbehaving model's tool loop; the transcript is healed exactly
   * like an unwind so the next turn hydrates a valid conversation.
   */
  maxRounds?: number;
  /**
   * Context window size in tokens for the session's model. When set, it is
   * forwarded on terminal usage payloads so clients can render fill ratios.
   */
  contextWindow?: number;
  /**
   * Called whenever the accumulated turn usage changes (each round's usage
   * as it arrives). Lets callers capture the usage at a cut point even when
   * the turn never reaches a normal finish (abort / unwind).
   */
  onUsage?: (usage: TurnUsage) => void;
  /**
   * Bounded 429 retry policy for the initial `create()` of each round
   * (see {@link RateLimitPolicy}). Unset = {@link DEFAULT_RATE_LIMIT_POLICY}.
   * The daemon wires this from config (`rateLimit*`); tests inject small
   * delays / a fake `sleep` for determinism.
   */
  rateLimit?: Partial<RateLimitPolicy>;
  /**
   * Loaded-skill instructions (concatenated `SKILL.md` bodies). Appended to
   * the system prompt at the *end* so everything before it stays
   * cacheable; empty/undefined appends nothing.
   */
  skillInstructions?: string;
  /**
   * Available (unloaded) skills block for the initial system message. Also
   * appended at the end (after instructions), keeping the cache boundary
   * stable across turns.
   */
  availableSkills?: string;
}
