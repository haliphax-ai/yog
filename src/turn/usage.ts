/**
 * Turn-usage bookkeeping: the round attribution copied onto each
 * `tool.result` (the API does not segment tokens per call), and the
 * per-round prompt growth delta. These are the honest numbers a client
 * can show for context growth — a per-call split would be fabricated.
 */

import type { TurnUsage } from "./sink.ts";

/** Inputs for one round's usage attribution. */
export interface RoundUsageInput {
  /** The round's provider usage (undefined when the provider sent none). */
  roundUsage: TurnUsage | undefined;
  /** Previous round's prompt_tokens (undefined for the turn's first round). */
  prevRoundPrompt: number | undefined;
}

/** One round's attribution: the shared round usage + the prompt delta. */
export interface RoundAttribution {
  /** The round's real usage, stamped identically on every tool.result. */
  roundUsage: TurnUsage | undefined;
  /**
   * This round's prompt_tokens minus the previous round's (what this
   * round's calls + results added to the next request's context).
   * Undefined for the turn's first round or when either side lacks a
   * prompt count.
   */
  promptDelta: number | undefined;
  /** The prompt count to carry into the next round's delta (undefined keeps it). */
  nextPrevPrompt: number | undefined;
}

/**
 * Compute one round's tool-result attribution from the round's usage and
 * the previous round's prompt count (see the module docstring for why the
 * round — not the call — is the honest attribution unit).
 */
export function roundUsageAttribution(input: RoundUsageInput): RoundAttribution {
  const { roundUsage, prevRoundPrompt } = input;
  return {
    roundUsage: roundUsage === undefined ? undefined : { ...roundUsage },
    promptDelta:
      roundUsage?.prompt_tokens !== undefined && prevRoundPrompt !== undefined
        ? roundUsage.prompt_tokens - prevRoundPrompt
        : undefined,
    nextPrevPrompt:
      roundUsage?.prompt_tokens !== undefined ? roundUsage.prompt_tokens : prevRoundPrompt,
  };
}
