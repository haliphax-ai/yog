/**
 * Pure fold over one streamed provider chunk: aggregate usage (turn-wide
 * + round copy, capture-first extras), fold tool-call deltas into the
 * per-round accumulator, and accumulate assistant prose. The caller does
 * the emitting and the announced-call bookkeeping.
 */

import type { TurnUsage } from "./sink.ts";

/**
 * Widen a provider `usage` object to the standard-schema extras yog captures
 * verbatim. The OpenAI SDK's `CompletionUsage` types only the three summary
 * numbers; OpenRouter (and newer OpenAI deployments) attach
 * `prompt_tokens_details`, `completion_tokens_details`, and a cost figure.
 * Numbers-of-wrong-shape are dropped, not coerced.
 */
export function orUsageDetails(raw: Record<string, unknown>): {
  prompt_tokens_details?: TurnUsage["prompt_tokens_details"];
  completion_tokens_details?: TurnUsage["completion_tokens_details"];
  cost?: number;
} {
  const out: {
    prompt_tokens_details?: TurnUsage["prompt_tokens_details"];
    completion_tokens_details?: TurnUsage["completion_tokens_details"];
    cost?: number;
  } = {};
  const ptd = raw.prompt_tokens_details;
  if (typeof ptd === "object" && ptd !== null) {
    const d = ptd as Record<string, unknown>;
    const details = {
      ...(typeof d.cached_tokens === "number" ? { cached_tokens: d.cached_tokens } : {}),
      ...(typeof d.cache_write_tokens === "number"
        ? { cache_write_tokens: d.cache_write_tokens }
        : {}),
    };
    if (Object.keys(details).length > 0) out.prompt_tokens_details = details;
  }
  const ctd = raw.completion_tokens_details;
  if (typeof ctd === "object" && ctd !== null) {
    const d = ctd as Record<string, unknown>;
    out.completion_tokens_details =
      typeof d.reasoning_tokens === "number" ? { reasoning_tokens: d.reasoning_tokens } : {};
  }
  if (typeof raw.cost === "number" && Number.isFinite(raw.cost)) out.cost = raw.cost;
  return out;
}

/** One streamed provider chunk, as the engine consumes it. */
export interface StreamChunk {
  id?: string;
  choices: { delta?: { content?: string | null; tool_calls?: StreamToolCall[] } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

/** One streamed tool-call delta (index-keyed, id/name/args accumulate). */
interface StreamToolCall {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** One tool call announced by a streamed delta (id/name/args so far). */
export interface AnnouncedCall {
  id: string;
  name: string;
  args: string;
}

/** Mutable state carried across a turn's streamed chunks. */
export interface ChunkState {
  /** Per-chunk usage observer (the caller's opts.onUsage). */
  onUsage?: (usage: TurnUsage) => void;
  usage: TurnUsage | undefined;
  roundUsage: TurnUsage | undefined;
  toolCalls: Map<number, AnnouncedCall>;
  assistantText: string;
  lastUsage: TurnUsage | undefined;
}

/** What consuming one streamed chunk produced (new state + side data). */
export interface ConsumedChunk {
  usage: TurnUsage | undefined;
  roundUsage: TurnUsage | undefined;
  assistantText: string;
  lastUsage: TurnUsage | undefined;
  /** Calls newly announced by this chunk (id + name set). */
  announced: AnnouncedCall[];
  /** Prose carried by this chunk, when any (emitted as message.delta). */
  deltaText: string | undefined;
}

/**
 * Widen one usage chunk onto a running total (capture-first:
 * standard-schema extras — token details, provider request id, cost — are
 * stored verbatim; the SDK types only the three summary numbers, so the
 * extra fields are widened at this boundary and nowhere else).
 */
export function mergeUsage(
  prev: TurnUsage | undefined,
  raw: unknown,
  requestId?: string,
): TurnUsage {
  const u = (raw ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  const details = orUsageDetails((raw ?? {}) as unknown as Record<string, unknown>);
  return {
    prompt_tokens: u.prompt_tokens ?? prev?.prompt_tokens,
    completion_tokens: u.completion_tokens ?? prev?.completion_tokens,
    total_tokens: u.total_tokens ?? prev?.total_tokens,
    ...(details.prompt_tokens_details !== undefined
      ? { prompt_tokens_details: details.prompt_tokens_details }
      : {}),
    ...(details.completion_tokens_details !== undefined
      ? { completion_tokens_details: details.completion_tokens_details }
      : {}),
    ...(details.cost !== undefined ? { cost: details.cost } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
  };
}

/** Fold one streamed tool-call delta into the per-round call accumulator. */
export function foldToolCall(
  toolCalls: Map<number, AnnouncedCall>,
  tc: StreamToolCall | undefined,
): AnnouncedCall | undefined {
  if (!tc) return undefined;
  const index = tc.index ?? 0;
  const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
  if (tc.id) entry.id = tc.id;
  if (tc.function?.name) entry.name = tc.function.name;
  if (tc.function?.arguments) entry.args += tc.function.arguments;
  toolCalls.set(index, entry);
  return entry.id && entry.name ? { ...entry } : undefined;
}

/**
 * Consume one streamed chunk: aggregate usage (turn-wide + round copy,
 * capture-first extras), fold tool-call deltas, and accumulate assistant
 * prose. Pure state-fold — the caller does the emitting and the
 * announced-call bookkeeping.
 */
export function consumeChunk(chunk: StreamChunk, state: ChunkState): ConsumedChunk {
  const out: ConsumedChunk = {
    usage: state.usage,
    roundUsage: state.roundUsage,
    assistantText: state.assistantText,
    lastUsage: state.lastUsage,
    announced: [],
    deltaText: undefined,
  };
  if (chunk.usage) {
    const requestId = typeof chunk.id === "string" ? chunk.id : undefined;
    out.usage = mergeUsage(out.usage, chunk.usage, requestId);
    out.roundUsage = mergeUsage(out.roundUsage, chunk.usage);
    out.lastUsage = out.usage;
    state.onUsage?.(out.usage);
  }
  const delta = chunk.choices[0]?.delta;
  if (!delta) return out;
  if (delta.content) {
    out.deltaText = delta.content;
    out.assistantText += delta.content;
  }
  for (const tc of delta.tool_calls ?? []) {
    const announced = foldToolCall(state.toolCalls, tc);
    if (announced) out.announced.push(announced);
  }
  return out;
}
