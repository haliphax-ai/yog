/**
 * Skills-context injection for a turn's system prompt: append the
 * loaded-skill instructions and the available-skills block to the END of
 * the first system message (create it when absent), so everything before
 * the addition stays prompt-cacheable across turns.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";

import type { TurnOptions } from "./engine-types.ts";

/**
 * Append the turn's skills context (loaded instructions + available
 * skills block) onto the transcript's system prompt, in place.
 */
export function injectSkillContext(
  messages: ChatCompletionMessageParam[],
  opts: Pick<TurnOptions, "skillInstructions" | "availableSkills">,
): void {
  const instructions = opts.skillInstructions?.trim();
  const available = opts.availableSkills?.trim();
  if (!instructions && !available) return;
  const addition = [instructions, available].filter(Boolean).join("\n\n");
  const first = messages[0];
  const firstRec = first as { role?: string; content?: unknown } | undefined;
  if (firstRec && firstRec.role === "system" && typeof firstRec.content === "string") {
    messages[0] = {
      role: "system",
      content: `${firstRec.content}\n\n${addition}`,
    } as ChatCompletionMessageParam;
  } else {
    messages.unshift({ role: "system", content: addition } as ChatCompletionMessageParam);
  }
}
