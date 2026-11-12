import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type { ToolCall, ToolRegistry } from "./toolkit/index.ts";
import type { ToolCallRecord } from "./state/index.ts";

import { logger } from "./log.ts";
import { newSessionId } from "./state/index.ts";
import { estimateTokenCount as tokenxResultTokens } from "tokenx";

/**
 * Widen a provider `usage` object to the standard-schema extras yog captures
 * verbatim. The OpenAI SDK's `CompletionUsage`
 * types only the three summary numbers; OpenRouter (and newer OpenAI
 * deployments) attach `prompt_tokens_details`, `completion_tokens_details`,
 * and a cost figure. Numbers-of-wrong-shape are dropped, not coerced.
 */
function orUsageDetails(raw: Record<string, unknown>): {
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
import {
  StdoutSink,
  TURN_EVENT_VERSION,
  type TurnEventDataMap,
  type TurnEvent,
  type TurnEventType,
  type TurnSink,
  type TurnUsage,
} from "./turn/sink.ts";

/** Tool calls currently executing per session (for the abort endpoint). */
const activeToolCalls = new Map<string, { id: string; name: string; args: string }>();

/** Make an abort-shaped error (mirrors the orchestrator's normalization). */
function makeAbortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(reason === undefined || reason === null ? "turn aborted" : String(reason));
  err.name = "AbortError";
  return err;
}

/** One OpenAI tool-call round's assistant row shape (subset). */
export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Build the assistant message row that carries `calls` (replay path). */
export function assistantToolCallMessage(calls: AssistantToolCall[]): ChatCompletionMessageParam {
  return { role: "assistant", content: null, tool_calls: calls } as ChatCompletionMessageParam;
}

/**
 * Build the canonical stub tool message for an unanswered tool call:
 * an `error` result so a hydrated follow-up turn sees a definite answer
 * instead of a dangling call (which providers reject).
 */
export function toolStubMessage(toolCallId: string): ChatCompletionMessageParam {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({ error: "tool call aborted before a result was produced" }),
  } as ChatCompletionMessageParam;
}

/**
 * Collect the tool-call ids the transcript announced (assistant rows with
 * `tool_calls`) that never received a `tool` answer message. Any unwind
 * mid-tool-loop (operator abort, provider error) leaves such calls behind;
 * stubbing them keeps the transcript hydratable for the next turn.
 */
export function unansweredToolCallIds(messages: ChatCompletionMessageParam[]): Set<string> {
  const announced = new Set<string>();
  for (const m of messages) {
    const rec = m as { role?: string; tool_calls?: Array<{ id?: string }> };
    if (rec.role === "assistant" && Array.isArray(rec.tool_calls)) {
      for (const tc of rec.tool_calls) {
        if (typeof tc?.id === "string") announced.add(tc.id);
      }
    }
  }
  for (const m of messages) {
    const rec = m as { role?: string; tool_call_id?: string };
    if (rec.role === "tool" && typeof rec.tool_call_id === "string") {
      announced.delete(rec.tool_call_id);
    }
  }
  return announced;
}

/**
 * Bounded retry policy for provider 429s at the *start* of a round.
 *
 * A 429 from `chat.completions.create()` means the request was rejected
 * before any chunk was produced: `messages` is unchanged, no assistant
 * text was emitted, and no tool from *this* round has run (tools belong
 * to earlier, already-appended rounds). The engine therefore resubmits
 * the identical `messages` array after a backoff — no synthetic user
 * message, no transcript "healing", no tool re-execution.
 *
 * Only failures of the initial `create()` call are retried. A failure
 * after streaming has begun cannot be transparently retried (deltas
 * were already emitted and tool calls may have been announced); it
 * unwinds to the terminal/heal path exactly as before.
 */
export interface RateLimitPolicy {
  /**
   * Total requests allowed per round, initial try included
   * (default 6 = 1 initial try + 5 retries). `1` disables retrying.
   */
  maxAttempts: number;
  /** First exponential wait in ms (default 1000). */
  baseDelayMs: number;
  /**
   * Cap for any single wait in ms (default 60_000). Server hints
   * (`Retry-After`, `x-ratelimit-reset-*`) are clamped to this cap; a
   * hint above the cap simply trades for another 429 + retry until
   * `maxAttempts` is exhausted.
   */
  maxDelayMs: number;
  /** Exponential multiplier per failed attempt (default 2). */
  backoffFactor: number;
  /**
   * Jitter fraction in [0, 1): the exponential delay is scaled by
   * `1 - random() * jitterRatio` (default 0.25, matching the SDK).
   * Server-hinted delays are *not* jittered — the server's wait is
   * authoritative.
   */
  jitterRatio?: number;
  /** Injectable timer for tests (defaults to real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable randomness in [0, 1) for tests (defaults to `Math.random`). */
  random?: () => number;
}

/** Default 429 retry policy (see {@link RateLimitPolicy}). */
export const DEFAULT_RATE_LIMIT_POLICY: Required<
  Pick<RateLimitPolicy, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "backoffFactor">
> = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffFactor: 2,
};

/** Resolve a partial policy against the defaults (invalid values fall back). */
export function resolveRateLimitPolicy(
  policy?: Partial<RateLimitPolicy>,
): Required<Pick<RateLimitPolicy, "maxAttempts" | "baseDelayMs" | "maxDelayMs" | "backoffFactor">> &
  RateLimitPolicy {
  const num = (v: unknown, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : dflt;
  const maxAttempts = Math.max(
    1,
    Math.floor(num(policy?.maxAttempts, DEFAULT_RATE_LIMIT_POLICY.maxAttempts)),
  );
  const baseDelayMs = Math.max(0, num(policy?.baseDelayMs, DEFAULT_RATE_LIMIT_POLICY.baseDelayMs));
  const maxDelayMs = Math.max(0, num(policy?.maxDelayMs, DEFAULT_RATE_LIMIT_POLICY.maxDelayMs));
  const backoffFactor = Math.max(
    1,
    num(policy?.backoffFactor, DEFAULT_RATE_LIMIT_POLICY.backoffFactor),
  );
  const jitterRatio =
    policy?.jitterRatio === undefined ? 0.25 : Math.min(1, Math.max(0, policy.jitterRatio));
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs: Math.max(maxDelayMs, 0),
    backoffFactor,
    jitterRatio,
    ...(policy?.sleep ? { sleep: policy.sleep } : {}),
    ...(policy?.random ? { random: policy.random } : {}),
  };
}

/**
 * Whether `err` is a provider rate-limit (429) failure. Recognises the
 * OpenAI SDK's `RateLimitError` shape (`status: 429`), an explicit
 * `code` of `rate_limit_exceeded` / `rate_limited`, and the class name.
 * A bare message mentioning "429" is deliberately *not* enough: plain
 * `Error("429 rate limited")` values are also used for mid-stream
 * failures, which must stay terminal rather than retry.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  if (rec.status === 429 || rec.statusCode === 429) return true;
  const code = typeof rec.code === "string" ? rec.code : undefined;
  if (code === "rate_limit_exceeded" || code === "rate_limited") return true;
  if (err instanceof Error && err.name === "RateLimitError") return true;
  // Some SDK/proxy errors nest the body: { error: { code, type } }.
  const inner = rec.error;
  if (inner !== null && typeof inner === "object") {
    const innerCode = (inner as Record<string, unknown>).code;
    if (innerCode === "rate_limit_exceeded" || innerCode === "rate_limited") return true;
  }
  return false;
}

type HeaderGetter = (name: string) => string | undefined;

function headerGetterFrom(err: unknown): HeaderGetter | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const rec = err as Record<string, unknown>;
  const candidates: unknown[] = [
    rec.headers,
    (rec.response as Record<string, unknown> | undefined)?.headers,
  ];
  for (const h of candidates) {
    if (h === null || typeof h !== "object") continue;
    if (typeof (h as { get?: unknown }).get === "function") {
      const get = (h as { get: (n: string) => unknown }).get.bind(h);
      return (name) => {
        const v = get(name);
        return typeof v === "string" ? v : v === null || v === undefined ? undefined : String(v);
      };
    }
    if (Array.isArray(h)) continue;
    const map = h as Record<string, unknown>;
    // Plain object: case-insensitive lookup, first value wins.
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      const val = Array.isArray(v) ? v[0] : v;
      if (typeof val === "string") lower[k.toLowerCase()] = val;
      else if (typeof val === "number") lower[k.toLowerCase()] = String(val);
    }
    if (Object.keys(lower).length > 0) {
      return (name) => lower[name.toLowerCase()];
    }
  }
  return undefined;
}

/** Parse an OpenAI `x-ratelimit-reset-*` duration ("20ms", "1m20s", "2h0s0ms") to ms. */
export function parseRateLimitResetMs(value: string): number | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  // Composite duration: sequence of <int><unit> where unit is h|m|s|ms.
  if (/^(?:\d+(?:ms|h|m|s))+$/.test(v)) {
    let total = 0;
    for (const m of v.matchAll(/(\d+)(ms|h|m|s)/g)) {
      const n = Number(m[1]);
      const unit = m[2];
      total +=
        unit === "h" ? n * 3_600_000 : unit === "m" ? n * 60_000 : unit === "s" ? n * 1_000 : n;
    }
    return total;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return undefined;
  // Bare numbers: epoch timestamps are implausibly large for a wait, so
  // treat huge values as epoch ms/s, everything else as seconds.
  if (n > 1e14) return n - Date.now();
  if (n > 1e10) return n * 1000 - Date.now();
  return n * 1_000 - (v.includes(".") ? 0 : 0);
}

function parseRetryAfterMs(value: string, now: number): number | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  const asSeconds = Number(v);
  if (Number.isFinite(asSeconds)) return Math.max(0, asSeconds * 1_000);
  const asDate = Date.parse(v);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);
  return undefined;
}

/**
 * Server wait hints carried by a 429 error, in ms. `retryAfterMs` comes
 * from `retry-after-ms` / `Retry-After`; `resetMs` is the largest
 * `x-ratelimit-reset-*` window (tokens and requests must both refill,
 * so the larger governs). Both are undefined when the provider sent
 * no usable hint.
 */
export function rateLimitHints(
  err: unknown,
  now = Date.now(),
): { retryAfterMs?: number; resetMs?: number } {
  const get = headerGetterFrom(err);
  if (!get) return {};
  let retryAfterMs: number | undefined;
  const retryAfterMsRaw = get("retry-after-ms");
  if (retryAfterMsRaw !== undefined) {
    const n = Number(retryAfterMsRaw);
    if (Number.isFinite(n)) retryAfterMs = Math.max(0, n);
  }
  if (retryAfterMs === undefined) {
    const retryAfterRaw = get("retry-after");
    if (retryAfterRaw !== undefined) retryAfterMs = parseRetryAfterMs(retryAfterRaw, now);
  }
  let resetMs: number | undefined;
  for (const name of [
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset",
  ]) {
    const raw = get(name);
    if (raw === undefined) continue;
    const ms = parseRateLimitResetMs(raw);
    if (ms !== undefined) resetMs = resetMs === undefined ? ms : Math.max(resetMs, ms);
  }
  return {
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(resetMs !== undefined ? { resetMs } : {}),
  };
}

/**
 * Backoff wait (ms) before the next try after failed attempt `attempt`
 * (1-based): the largest server hint when present (clamped to
 * `maxDelayMs`), otherwise exponential `baseDelayMs * factor^(attempt-1)`
 * with jitter, also clamped.
 */
export function rateLimitDelayMs(
  err: unknown,
  attempt: number,
  policy: RateLimitPolicy,
  now = Date.now(),
): number {
  const resolved = resolveRateLimitPolicy(policy);
  const hints = rateLimitHints(err, now);
  const hinted = [hints.retryAfterMs, hints.resetMs].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (hinted.length > 0) {
    return Math.min(resolved.maxDelayMs, Math.max(0, Math.max(...hinted)));
  }
  const exponential =
    resolved.baseDelayMs * Math.pow(resolved.backoffFactor, Math.max(0, attempt - 1));
  const jittered =
    exponential * (1 - (resolved.jitterRatio ?? 0.25) * (resolved.random?.() ?? Math.random()));
  return Math.min(resolved.maxDelayMs, Math.max(0, jittered));
}

/** Abortable backoff wait: wakes promptly when `checkAbort` would throw. */
async function sleepBackoff(
  ms: number,
  checkAbort: () => void,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  if (sleep) {
    // Injected sleep (tests): honour an abort that fires while waiting.
    // Slice the wait so `checkAbort` is probed periodically even when the
    // injected timer is long; simple fakes that resolve immediately just
    // complete in one slice.
    const deadline = Date.now() + Math.max(0, ms);
    while (true) {
      checkAbort();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      await sleep(Math.min(remaining, 50));
    }
  }
  const deadline = Date.now() + Math.max(0, ms);
  while (true) {
    checkAbort();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(remaining, 50)));
  }
}
/**
 * Agent turn engine: streams one chat completion, executes any tool calls it
 * contains (feeding results back in), and repeats until the model answers
 * without tools. This is the loop every agent run funnels through as the
 * harness grows. Every observable moment — deltas, tool activity, terminal
 * states — is emitted as a typed `TurnEvent` on a transport-agnostic
 * `TurnSink`; the default `StdoutSink` reproduces the original stdout bytes.
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

/**
 * The turn loop, bound to a `TurnSink`: every observable moment (stream
 * deltas, tool activity, terminal states) is emitted as a typed event to the
 * sink instead of being written to stdout directly. The engine awaits every
 * `emit`, so slow transports exert backpressure on the loop.
 */
export class TurnEngine {
  private readonly sink: TurnSink;

  constructor(sink: TurnSink) {
    this.sink = sink;
  }

  async run(
    client: OpenAI,
    modelId: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
    opts: TurnOptions = {},
  ): Promise<void> {
    // Turn identity and envelope ids are per-turn: the contract guarantees
    // monotonic ids within a turn, not across turns.
    const turnId = newSessionId();
    const turnStartedAt = Date.now();
    let nextEventId = 0;
    const emit = <T extends TurnEventType>(type: T, data: TurnEventDataMap[T]): Promise<void> =>
      this.sink.emit({
        id: nextEventId++,
        type,
        version: TURN_EVENT_VERSION,
        ts: Date.now(),
        data,
      } as TurnEvent<T>);

    // Declared outside `try` so the unwind/heal path in `catch` can
    // reconstruct assistant rows for calls announced before the unwind.
    const announcedCalls = new Map<string, { id: string; name: string; args: string }>();
    // Declared outside `try` so the error path can reference it: the last
    // usage seen anywhere in the turn, carried on the terminal error event.
    let lastUsage: TurnUsage | undefined;
    try {
      await emit("turn.started", { turnId, model: modelId, ts: Date.now() });

      // Abort probe: checked at every await boundary so an abort arriving
      // mid-tool-call or mid-stream still unwinds the turn deterministically.
      const abortErr = () => makeAbortError(opts.abortReason ?? "turn aborted");
      const checkAbort = (): void => {
        if (opts.signal?.aborted === true || opts.isAborted?.() === true) throw abortErr();
      };
      checkAbort();

      // Skills system: append the loaded-skill instructions and the
      // available-skills block to the END of the first system message
      // (create it when absent), so everything before the addition stays
      // prompt-cacheable across turns.
      {
        const instructions = opts.skillInstructions?.trim();
        const available = opts.availableSkills?.trim();
        if (instructions || available) {
          const addition = [instructions, available].filter(Boolean).join("\n\n");
          const first = messages[0];
          const firstRec = first as { role?: string; content?: unknown } | undefined;
          if (firstRec && firstRec.role === "system" && typeof firstRec.content === "string") {
            messages[0] = {
              role: "system",
              content: `${firstRec.content}\n\n${addition}`,
            } as ChatCompletionMessageParam;
          } else {
            messages.unshift({
              role: "system",
              content: addition,
            } as ChatCompletionMessageParam);
          }
        }
      }

      // Bound the tool-call loop so a misbehaving model cannot spin forever.
      const maxRounds = opts.maxRounds ?? 200;
      // Accumulate token usage across all rounds: the final chunk of each
      // round's stream carries the request's usage (when the provider supports
      // `include_usage`); merge partial fields so a round that reports only
      // some of them keeps the rest of the running total.
      let usage: TurnUsage | undefined;
      const rateLimitPolicy = resolveRateLimitPolicy(opts.rateLimit);
      // Previous round's prompt_tokens, for the per-round context-growth delta.
      let prevRoundPrompt: number | undefined;
      // Total 429 backoffs this turn (reported on `turn.finished`).
      let rateLimitRetries = 0;
      for (let round = 0; round < maxRounds; round++) {
        let roundUsage: TurnUsage | undefined;
        // 429 retry wrapper around the initial `create()` only. `maxRetries: 0`
        // disables the SDK's own silent retries so every backoff below is the
        // one signalled via `rate_limited` (the SDK would otherwise retry
        // 429s invisibly before yog ever sees them). The body still carries
        // `signal` for fakes/older SDKs that read options from the body; the
        // second argument is the canonical RequestOptions location.
        const createStream = async () => {
          let attempt = 0;
          for (;;) {
            checkAbort();
            try {
              return await client.chat.completions.create(
                {
                  model: modelId,
                  messages,
                  tools: tools.definitions,
                  stream_options: { include_usage: true },
                  stream: true,
                  ...(opts.signal ? { signal: opts.signal } : {}),
                },
                { maxRetries: 0, ...(opts.signal ? { signal: opts.signal } : {}) },
              );
            } catch (err) {
              if (!isRateLimitError(err)) throw err;
              attempt += 1;
              if (attempt >= rateLimitPolicy.maxAttempts) throw err;
              const hints = rateLimitHints(err);
              const delayMs = rateLimitDelayMs(err, attempt, rateLimitPolicy);
              rateLimitRetries += 1;
              logger.warn(
                { round, attempt, maxAttempts: rateLimitPolicy.maxAttempts, delayMs, ...hints },
                `[rate-limit] provider 429 on round ${round} (attempt ${attempt}/${rateLimitPolicy.maxAttempts}); backing off ${delayMs}ms`,
              );
              await emit("rate_limited", {
                attempt,
                maxAttempts: rateLimitPolicy.maxAttempts,
                delayMs,
                ...(hints.retryAfterMs !== undefined ? { retryAfterMs: hints.retryAfterMs } : {}),
                ...(hints.resetMs !== undefined ? { resetMs: hints.resetMs } : {}),
                round,
                status: 429,
                ...(err instanceof Error && err.message ? { providerMessage: err.message } : {}),
              });
              await sleepBackoff(delayMs, checkAbort, rateLimitPolicy.sleep);
              // Loop: resubmit the *identical* `messages` array. Nothing was
              // appended by the failed call, so no synthetic message and no
              // tool re-execution are needed (or correct).
            }
          }
        };
        const stream = await createStream();

        const toolCalls = new Map<number, { id: string; name: string; args: string }>();
        // Accumulate this round's assistant text. It is only ever appended to
        // `messages` on the no-tool-calls path (plan §4.3): a tool-call round
        // streams text too, but its assistant row carries `tool_calls` and the
        // text is discarded exactly as before.
        let assistantText = "";

        for await (const chunk of stream) {
          // Hard abort: drop the model stream the moment the signal fires —
          // no waiting for a round seam, no consuming remaining output. The
          // abort error propagates to the unwind/heal path below.
          if (opts.signal?.aborted === true || opts.isAborted?.() === true) {
            stream.controller.abort(new Error(opts.abortReason ?? "turn aborted"));
            throw abortErr();
          }
          // Aggregate usage for this round onto the turn-wide running total.
          // Providers that don't support `include_usage` (or newer always-on
          // reporting) simply never send a `usage` field, so this stays
          // undefined for them. The round-level copy drives per-tool-call
          // attribution; it resets each round.
          //
          // Capture-first: the standard-schema
          // extras - prompt/completion token details, provider request id,
          // cost - are stored verbatim on the turn/round usage records.
          // The OpenAI SDK types only the three summary numbers, so the
          // extra fields are widened at this boundary and nowhere else.
          if (chunk.usage) {
            const raw = chunk.usage as unknown as Record<string, unknown>;
            const details = orUsageDetails(raw);
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens ?? usage?.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens ?? usage?.completion_tokens,
              total_tokens: chunk.usage.total_tokens ?? usage?.total_tokens,
              ...(details.prompt_tokens_details !== undefined
                ? { prompt_tokens_details: details.prompt_tokens_details }
                : {}),
              ...(details.completion_tokens_details !== undefined
                ? { completion_tokens_details: details.completion_tokens_details }
                : {}),
              ...(details.cost !== undefined ? { cost: details.cost } : {}),
            };
            const requestId = typeof chunk.id === "string" ? chunk.id : undefined;
            if (requestId !== undefined) {
              usage = { ...usage, requestId };
            }
            opts.onUsage?.(usage);
            roundUsage = {
              prompt_tokens: chunk.usage.prompt_tokens ?? roundUsage?.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens ?? roundUsage?.completion_tokens,
              total_tokens: chunk.usage.total_tokens ?? roundUsage?.total_tokens,
              ...(details.prompt_tokens_details !== undefined
                ? { prompt_tokens_details: details.prompt_tokens_details }
                : {}),
              ...(details.completion_tokens_details !== undefined
                ? { completion_tokens_details: details.completion_tokens_details }
                : {}),
              ...(details.cost !== undefined ? { cost: details.cost } : {}),
              ...(requestId !== undefined ? { requestId } : {}),
            };
            lastUsage = usage;
          }
          const delta = chunk.choices[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            await emit("message.delta", { text: delta.content });
            assistantText += delta.content;
          }

          for (const tc of delta.tool_calls ?? []) {
            const index = tc.index ?? 0;
            const entry = toolCalls.get(index) ?? { id: "", name: "", args: "" };
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
            toolCalls.set(index, entry);
            // Track announced calls as they stream: a mid-stream abort
            // unwinds before the assistant row is pushed, and the heal path
            // reconstructs the call from this tracker entry.
            if (entry.id && entry.name) {
              announcedCalls.set(entry.id, { ...entry });
              if (opts.sessionId !== undefined) {
                activeToolCalls.set(opts.sessionId, { ...entry });
              }
            }
          }
        }

        if (toolCalls.size === 0) {
          // Plan §4.3: the caller diffs by index, so the final assistant text
          // message must be in `messages` before the turn ends. A round that
          // streamed text but also made tool calls keeps its `content: null`
          // tool_calls row as-is; only the terminal no-tool round appends.
          if (assistantText) {
            messages.push({ role: "assistant", content: assistantText });
          }
          await emit("turn.finished", {
            turnId,
            durationMs: Date.now() - turnStartedAt,
            ...(usage !== undefined
              ? { usage: { ...usage, context_window: opts.contextWindow } }
              : {}),
            ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
          });
          return;
        }

        const ordered = [...toolCalls.entries()].sort(([a], [b]) => a - b);

        // The provider reports one usage object per round (final chunk), with
        // no per-call segmentation — completion tokens cover reasoning, prose,
        // and every call's args JSON together. The honest attribution is the
        // round itself: stamp the same real usage on each tool.result, plus
        // the prompt delta vs. the previous round (what this round's calls +
        // results added to the next request's context).
        const roundUsageOut =
          roundUsage === undefined
            ? undefined
            : {
                ...(roundUsage.prompt_tokens !== undefined
                  ? { prompt_tokens: roundUsage.prompt_tokens }
                  : {}),
                ...(roundUsage.completion_tokens !== undefined
                  ? { completion_tokens: roundUsage.completion_tokens }
                  : {}),
                ...(roundUsage.total_tokens !== undefined
                  ? { total_tokens: roundUsage.total_tokens }
                  : {}),
                ...(roundUsage.prompt_tokens_details !== undefined
                  ? { prompt_tokens_details: roundUsage.prompt_tokens_details }
                  : {}),
                ...(roundUsage.completion_tokens_details !== undefined
                  ? { completion_tokens_details: roundUsage.completion_tokens_details }
                  : {}),
                ...(roundUsage.requestId !== undefined ? { requestId: roundUsage.requestId } : {}),
                ...(roundUsage.cost !== undefined ? { cost: roundUsage.cost } : {}),
              };
        const promptDelta =
          roundUsage?.prompt_tokens !== undefined && prevRoundPrompt !== undefined
            ? roundUsage.prompt_tokens - prevRoundPrompt
            : undefined;
        if (roundUsage?.prompt_tokens !== undefined) prevRoundPrompt = roundUsage.prompt_tokens;

        // Replay the assistant turn, then append one tool message per call.
        const assistantCallRow: AssistantToolCall[] = ordered.map(([i, tc]) => ({
          id: tc.id || `call_${i}`,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.args },
        }));
        messages.push(assistantToolCallMessage(assistantCallRow));

        for (const [i, tc] of ordered) {
          const tcId = tc.id || `call_${i}`;
          // An abort that fired while the round's model stream was draining
          // (or between rounds) throws here — before the tool starts and
          // before its `tool.call` is announced — so the just-reconstructed
          // assistant row lands in the heal path's stub set.
          checkAbort();
          await emit("tool.call", {
            id: tcId,
            name: tc.name,
            args: tc.args,
          });

          // Track the in-flight call so an abort can kill it and stub any
          // calls in this round that never produced a result.
          announcedCalls.set(tcId, { id: tcId, name: tc.name, args: tc.args });
          if (opts.sessionId !== undefined) {
            activeToolCalls.set(opts.sessionId, { id: tcId, name: tc.name, args: tc.args });
          }

          const startedAt = Date.now();
          const result = await tools.execute(tc.name, tc.args, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            ...(opts.isAborted ? { isAborted: opts.isAborted } : {}),
            ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
            onStart: (call: ToolCall) =>
              void activeToolCalls.set(opts.sessionId ?? "", {
                id: tcId,
                name: call.name,
                args: tc.args,
              }),
            onEnd: () => {
              if (activeToolCalls.get(opts.sessionId ?? "")?.id === tcId) {
                activeToolCalls.delete(opts.sessionId ?? "");
              }
            },
          });
          // Belt-and-braces: validation failures return before the registry
          // fires onEnd (the tool never started), so clear the in-flight
          // entry here too — a settled call must never look active.
          if (opts.sessionId !== undefined && activeToolCalls.get(opts.sessionId)?.id === tcId) {
            activeToolCalls.delete(opts.sessionId);
          }
          const completedAt = Date.now();
          const outcome =
            result === undefined
              ? "unknown tool"
              : result["error"]
                ? `error: ${result["error"]}`
                : `exitCode=${result["exitCode"]} runtimeMs=${result["runtimeMs"]}`;
          // Tool activity goes to the structured log so stdout remains a clean response stream.
          logger.error(
            {
              tool: tc.name,
              args: tc.args,
              ok: result !== undefined && result["error"] === undefined,
              outcome,
            },
            `[tool] ${tc.name}(${tc.args}) -> ${outcome}`,
          );

          const toolError = result?.["error"] as string | undefined;

          const payload =
            result === undefined
              ? JSON.stringify({ error: `unknown tool "${tc.name}"` })
              : JSON.stringify(result);
          // Per-result estimate rides the event for UI stat rows; the
          // round-level `usage` above is the authoritative native count.
          const resultTokens = tokenxResultTokens(payload);

          await emit("tool.result", {
            id: tcId,
            name: tc.name,
            ok: result !== undefined && toolError === undefined,
            result,
            error: toolError ?? (result === undefined ? `unknown tool "${tc.name}"` : undefined),
            ...(roundUsageOut !== undefined ? { usage: roundUsageOut } : {}),
            ...(promptDelta !== undefined ? { promptDelta } : {}),
            ...(resultTokens > 0 ? { resultTokens } : {}),
          });
          if (opts.recorder && opts.sessionId) {
            try {
              await opts.recorder.record({
                name: tc.name,
                parameters: tc.args,
                result: toolError === undefined && result !== undefined ? result : undefined,
                error: toolError,
                startedAt,
                completedAt,
                durationMs: completedAt - startedAt,
                sessionId: opts.sessionId,
              });
            } catch (err) {
              // Non-fatal by contract: an audit failure must never kill the turn.
              logger.error(`[audit] recorder failed: ${(err as Error).message}`);
            }
          }

          messages.push({
            role: "tool",
            tool_call_id: tcId,
            content: payload,
          });
        }
      }
      // Round cap reached (clean exhaustion): every executed round's
      // assistant rows and tool results are already in `messages`, so the
      // transcript stays hydratable. Emit the terminal event explicitly —
      // falling off the loop silently would end the stream without any
      // terminal state, leaving clients with a bare stream close and no
      // definite stop reason.
      await emit("turn.finished", {
        turnId,
        durationMs: Date.now() - turnStartedAt,
        ...(usage !== undefined ? { usage } : {}),
        stopReason: "max_rounds",
        ...(rateLimitRetries > 0 ? { rateLimitRetries } : {}),
      });
    } catch (err) {
      // Heal first, unconditionally (any unwind mid-tool-loop): every
      // announced tool call without a result gets a stub `tool` message, so
      // the persisted transcript stays hydratable — the next turn replays a
      // definite answer instead of a dangling call (providers reject that).
      // A mid-stream abort can leave the announced tool calls in the
      // ledger without their assistant row in `messages` (the row is only
      // pushed after the stream completes). Reconstruct every missing
      // call — not just the latest in-flight entry — so the healed
      // transcript keeps each call the model actually made.
      const announcedInMessages = new Set<string>();
      for (const m of messages) {
        const calls = (m as { tool_calls?: Array<{ id?: string }> }).tool_calls;
        if (Array.isArray(calls)) {
          for (const tc of calls) {
            if (typeof tc?.id === "string") announcedInMessages.add(tc.id);
          }
        }
      }
      const missingCalls = [...announcedCalls.values()].filter(
        (call) => !announcedInMessages.has(call.id),
      );
      if (missingCalls.length > 0) {
        messages.push(
          assistantToolCallMessage(
            missingCalls.map((call) => ({
              id: call.id,
              type: "function" as const,
              function: { name: call.name, arguments: call.args },
            })),
          ),
        );
      }

      const heal: ChatCompletionMessageParam[] = [...unansweredToolCallIds(messages)].map(
        (toolCallId) => toolStubMessage(toolCallId),
      );
      if (heal.length > 0) {
        messages.push(...heal);
        opts.onHeal?.(heal.map((m) => (m as { tool_call_id: string }).tool_call_id));
      }

      const aborted = opts.signal?.aborted === true || opts.isAborted?.() === true;
      if (aborted) {
        // Hard abort: the adapter framed the terminal `turn.aborted` itself
        // and closed the wire — do NOT emit again here (a late engine event
        // would otherwise land on the next turn's stream via the per-session
        // bus). The transcript was healed above; propagate so the caller
        // settles the turn row.
        throw err;
      }
      // Terminal error: emit first (so transports see it), then rethrow so the
      // composition root keeps its existing exit-code handling.
      await emit("error", {
        code: isRateLimitError(err) ? "rate_limited" : "provider_error",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error ? { details: { name: err.name, stack: err.stack } } : {}),
        // Capture-first on the error path too: the last known
        // round usage is the freshest native anchor a failed turn has —
        // rejected requests never yield a usage chunk of their own, so this
        // is what calibration and post-mortems have to work with.
        ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
      });
      throw err;
    } finally {
      // The turn settled (finished or unwound): the abort endpoint must not
      // report a phantom in-flight tool on later calls.
      if (opts.sessionId !== undefined) clearActiveToolCall(opts.sessionId);
    }
  }
}

/**
 * The tool call currently executing (or last started without settling) for
 * `sessionId`, for the abort endpoint: kill the tool first, then unwind.
 */
export function activeToolCallFor(
  sessionId: string,
): { id: string; name: string; args: string } | undefined {
  return activeToolCalls.get(sessionId);
}

/**
 * Drop the active-call tracking entry for `sessionId` (turn fully settled).
 */
export function clearActiveToolCall(sessionId: string): void {
  activeToolCalls.delete(sessionId);
}

/**
 * Convenience wrapper for callers that just want a turn run with the default
 * stdout sink; the composition root uses `TurnEngine` directly so the sink
 * is explicit.
 */
export function runTurn(
  client: OpenAI,
  modelId: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  opts: TurnOptions = {},
  sink?: TurnSink,
): Promise<void> {
  return new TurnEngine(sink ?? new StdoutSink()).run(client, modelId, messages, tools, opts);
}
