/**
 * Toolkit detach seam (yog#90): the module-level injection point the tool
 * registry consults so a long-running tool call can detach into a
 * background job at a wall-clock threshold.
 *
 * The same injection pattern as `setToolOutputBudgets` (truncation.ts): the
 * composition root owns the policy (the background-jobs manager will arm
 * it, yog#91); the toolkit only races the call's settlement against it.
 * With no policy armed the registry's detach path is inert — no timer, no
 * race change, byte-identical behavior — so every existing caller is
 * unaffected until the manager plugs in.
 */

import type { ToolResult } from "./types.ts";

/** The call the policy sees at the threshold: identity + the retained result. */
export interface DetachCall {
  /** Owning session id (undefined for non-session callers, e.g. the CLI). */
  readonly sessionId?: string;
  /** Tool name (e.g. `bash`). */
  readonly tool: string;
  /** Raw JSON arguments exactly as the registry received them. */
  readonly argsJson: string | null;
  /**
   * The call's true wall-clock start (ms epoch): a detached job's
   * duration is TOTAL runtime — threshold-to-settle is only its
   * background tail, and quoting that as elapsed misreports the row.
   */
  readonly startedAt: number;
  /**
   * The call's result promise — already capped (`capToolResult` applied),
   * so a detached build log cannot nuke context at delivery time. The
   * policy caller retains this promise: it is the job's eventual result.
   */
  readonly result: Promise<ToolResult>;
}

/** What the policy decides when the threshold fires. */
export type DetachVerdict =
  | { kind: "detach"; jobId: string }
  | { kind: "terminate"; reason: string; kill?: () => void | Promise<void> };

/** Threshold-time policy: the armed policy consults every tool execution. */
export interface ToolDetachPolicy {
  /** Wall-clock ms after which a still-running call races the policy. */
  readonly thresholdMs: number;
  /**
   * The verdict when the threshold fires. A rejection (or any throw) is
   * handled by the registry as a `terminate` with a fixed reason, so a
   * broken policy degrades instead of wedging calls.
   */
  onThreshold(call: DetachCall): Promise<DetachVerdict>;
}

let detachPolicy: ToolDetachPolicy | undefined;

/** Inject the detach policy (owned by the composition root). */
export function setToolDetachPolicy(policy: ToolDetachPolicy | undefined): void {
  detachPolicy = policy;
}

/** The live detach policy (`undefined` ⇒ inert: no timer, no race change). */
export function toolDetachPolicy(): ToolDetachPolicy | undefined {
  return detachPolicy;
}
