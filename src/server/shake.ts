/**
 * `/shake` — the softest rung of the compaction ladder. Mechanical, local,
 * model-free transcript rewriting: tool-call arguments and tool results are
 * truncated (middle-first) using each tool's own truncator when available, with
 * the global {@link TRUNCATION_IDENTIFIER} marking every cut. Tools without a
 * bespoke truncator fall back to a generic 500-char middle-truncation of the
 * JSON string, wrapped in a `{"truncated":"..."}` blob. No summary is produced
 * and no session/transcript reset happens — the same rows are rewritten in
 * place via `SessionStore.updateMessage`; seq/turnId/timestamps are untouched.
 */

import type { ToolRegistry } from "../toolkit/index.ts";
import {
  TRUNCATION_IDENTIFIER,
  FALLBACK_TRUNCATE_CHARS,
  middleTruncate,
  estimateTokenCountWithProfile,
  DEFAULT_PROFILE,
  type TokenProfile,
} from "../toolkit/index.ts";

/** One pending transcript-row patch (which fields to rewrite). */
interface ShakeRowPatch {
  tool_calls_json?: string;
  content?: string;
}

/** Outcome of one shake pass. */
export interface ShakeOutcome {
  /** Number of tool-call argument payloads truncated. */
  argsTruncated: number;
  /** Number of tool-result payloads truncated. */
  resultsTruncated: number;
  /** Estimated current transcript size in tokens (profile-driven tokenx) after the shake. */
  contextSize: number;
}

/** Store slice the shake runner needs. */
export interface ShakeStore {
  getTranscript(sessionId: string): Promise<Array<Record<string, unknown>>>;
  updateMessage(
    sessionId: string,
    seq: number,
    patch: { content?: string | null; tool_calls_json?: string | null },
  ): Promise<void>;
}

export interface ShakeDeps {
  store: ShakeStore;
  registry: ToolRegistry;
  /**
   * Token profile for the `contextSize` estimate. Defaults to the neutral
   * profile; the daemon passes the overlay-loaded profile for the session's
   * model so the reported size matches native counts on calibrated models.
   */
  profile?: TokenProfile;
}

/** Descriptors for the shake runner (see `./commands.ts`). */
export { SHAKE_COMMAND } from "./commands.ts";

export { TRUNCATION_IDENTIFIER };

/** Wrap a middle-truncated JSON string in the generic marker blob. */
function fallbackBlob(jsonText: string): string {
  return JSON.stringify({ truncated: middleTruncate(jsonText, FALLBACK_TRUNCATE_CHARS) });
}

/** Tool truncation hook for assistant tool-call arguments (or undefined). */
function argsTruncator(
  registry: ToolRegistry,
  callName: string,
): ((raw: string) => string) | undefined {
  const tool = registry.get(callName);
  return tool?.truncateArgs?.bind(tool);
}

/** Tool truncation hook for tool-result payloads (or undefined). */
function resultTruncator(
  registry: ToolRegistry,
  toolName: string | undefined,
): ((value: unknown) => unknown) | undefined {
  if (toolName === undefined) return undefined;
  const tool = registry.get(toolName);
  return tool?.truncateResult?.bind(tool);
}

/** State shared across the rows of one shake pass. */
interface ShakePassState {
  /** Tool-call id → tool name (from the assistant rows announcing calls). */
  callName: Map<string, string>;
  /** Pending row patches: seq → { tool_calls_json } | { content }. */
  patches: Map<number, ShakeRowPatch>;
  /** Truncation counters (args / results). */
  counters: { args: number; results: number };
}

/** Merge `p` into the pending patch for `seq`. */
function addPatch(patches: Map<number, ShakeRowPatch>, seq: number, p: ShakeRowPatch): void {
  patches.set(seq, { ...patches.get(seq), ...p });
}

/** The tool name a tool-result row belongs to (row column, else the call map). */
function resultRowToolName(
  row: Record<string, unknown>,
  callName: Map<string, string>,
): string | undefined {
  if (typeof row.name === "string" && row.name !== "") return row.name;
  if (typeof row.tool_call_id !== "string") return undefined;
  return callName.get(row.tool_call_id);
}

/** One assistant tool-call entry (id + name + JSON-string arguments). */
interface ShakeCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** The call id (string) or undefined. */
function callIdOf(call: ShakeCall): string | undefined {
  return typeof call.id === "string" ? call.id : undefined;
}

/** The call tool name (string) or undefined. */
function callNameOf(call: ShakeCall): string | undefined {
  return typeof call.function?.name === "string" ? call.function.name : undefined;
}
/** The call argument payload ("" when absent). */
function callArgsRaw(call: ShakeCall): string {
  const raw = call.function?.arguments;
  return typeof raw === "string" ? raw : "";
}

/** Truncate (or fall back for) an assistant tool-call argument. */
function truncateCallArgs(
  deps: ShakeDeps,
  call: ShakeCall,
  counters: ShakePassState["counters"],
): string | undefined {
  const name = typeof call.function?.name === "string" ? call.function.name : undefined;
  const raw = callArgsRaw(call);
  if (name === undefined || raw === "") return undefined;
  const truncate = argsTruncator(deps.registry, name);
  const replacement = truncate ? guardUnchanged(truncate(raw), raw) : fallbackUnlessSmall(raw);
  if (replacement === undefined) return undefined;
  counters.args += 1;
  return replacement;
}

/** Generic middle-truncation blob when the raw payload is oversized. */
function fallbackUnlessSmall(raw: string): string | undefined {
  if (raw.length <= FALLBACK_TRUNCATE_CHARS) return undefined;
  return fallbackBlob(raw);
}

/** A replacement only when the truncator actually changed the payload. */
function guardUnchanged(replacement: string, raw: string): string | undefined {
  return replacement === raw ? undefined : replacement;
}

/** Hooked tool result: parse, truncate, and re-stringify (or undefined). */
function hookedToolResult(
  row: Record<string, unknown>,
  truncate: (value: unknown) => unknown,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content as string);
  } catch {
    return undefined; // not JSON-shaped — leave it alone
  }
  const replacementValue = truncate(parsed);
  if (replacementValue === undefined) return undefined;
  const replacement = JSON.stringify(replacementValue);
  return replacement === row.content ? undefined : replacement;
}

/** Apply the result-side truncation hook or generic fallback for one row. */
function truncateToolResult(
  deps: ShakeDeps,
  row: Record<string, unknown>,
  name: string | undefined,
  counters: ShakePassState["counters"],
): string | undefined {
  const truncate = resultTruncator(deps.registry, name);
  const replacement = truncate
    ? hookedToolResult(row, truncate)
    : fallbackUnlessSmall(row.content as string);
  if (replacement === undefined) return undefined;
  counters.results += 1;
  return replacement;
}

/** Record one assistant row: index call ids and truncate oversized args. */
function shakeAssistantRow(
  row: Record<string, unknown>,
  seq: number,
  deps: ShakeDeps,
  state: ShakePassState,
): void {
  const calls = row.tool_calls as ShakeCall[];
  let next = calls;
  let changed = false;
  for (const call of calls) {
    const id = callIdOf(call);
    const name = callNameOf(call);
    if (id !== undefined && name !== undefined) state.callName.set(id, name);
    const replacement = truncateCallArgs(deps, call, state.counters);
    if (replacement === undefined) continue;
    next = next.map((c) =>
      c === call ? { ...c, function: { ...c.function, arguments: replacement } } : c,
    );
    changed = true;
  }
  if (changed) addPatch(state.patches, seq, { tool_calls_json: JSON.stringify(next) });
}

/** Record one tool-result row (tool hook or generic fallback). */
function shakeToolRow(
  row: Record<string, unknown>,
  seq: number,
  deps: ShakeDeps,
  state: ShakePassState,
): void {
  if (typeof row.content !== "string") return;
  const name = resultRowToolName(row, state.callName);
  const replacement = truncateToolResult(deps, row, name, state.counters);
  if (replacement !== undefined) addPatch(state.patches, seq, { content: replacement });
}

/** Rewrite one transcript row in place (assistant tool calls / tool results). */
function processShakeRow(
  row: Record<string, unknown>,
  seq: number,
  deps: ShakeDeps,
  state: ShakePassState,
): void {
  if (row.role === "assistant" && Array.isArray(row.tool_calls)) {
    shakeAssistantRow(row, seq, deps, state);
    return;
  }
  if (row.role === "tool") shakeToolRow(row, seq, deps, state);
}

/** Token estimate for one row (content + serialized tool calls). */
function rowTokenSize(row: Record<string, unknown>, profile: TokenProfile): number {
  const content = typeof row.content === "string" ? row.content : "";
  const calls = typeof row.tool_calls_json === "string" ? row.tool_calls_json : "";
  return (
    estimateTokenCountWithProfile(content, profile) + estimateTokenCountWithProfile(calls, profile)
  );
}

/**
 * Estimated transcript size after the shake: tokenx under the configured
 * profile (neutral default until a calibrated overlay exists). Native
 * usage is authoritative when the session has any — this is the
 * display-side fallback for sessions without anchors.
 */
/** The token profile for a shake pass (deps override, else neutral). */
function profileOf(deps: ShakeDeps): TokenProfile {
  return deps.profile ?? DEFAULT_PROFILE;
}

async function estimateContextSize(deps: ShakeDeps, sessionId: string): Promise<number> {
  const profile = profileOf(deps);
  const rows = await deps.store.getTranscript(sessionId);
  let contextSize = 0;
  for (const row of rows) contextSize += rowTokenSize(row, profile);
  return contextSize;
}

/** Flush the pending row patches through the store. */
async function applyShakePatches(
  deps: ShakeDeps,
  sessionId: string,
  patches: ShakePassState["patches"],
): Promise<void> {
  for (const [seq, p] of patches) {
    await deps.store.updateMessage(sessionId, seq, {
      ...(p.tool_calls_json !== undefined ? { tool_calls_json: p.tool_calls_json } : {}),
      ...(p.content !== undefined ? { content: p.content } : {}),
    });
  }
}

/** Walk the transcript rows, rewriting each in place through the state. */
function shakeRows(
  deps: ShakeDeps,
  rows: Array<Record<string, unknown>>,
  state: ShakePassState,
): void {
  for (const row of rows) {
    const seq = Number(row.seq);
    if (!Number.isFinite(seq)) continue;
    processShakeRow(row, seq, deps, state);
  }
}

/**
 * Build the shake runner: rewrite a session's transcript in place, applying
 * each tool's `truncateArgs`/`truncateResult` hooks (or the generic fallback).
 * Rows that change are patched via the store; seq/turnId/timestamps are
 * untouched.
 */
export function createShakeRunner(deps: ShakeDeps) {
  return async (sessionId: string): Promise<ShakeOutcome> => {
    const rows = await deps.store.getTranscript(sessionId);
    const state: ShakePassState = {
      callName: new Map<string, string>(),
      patches: new Map<number, ShakeRowPatch>(),
      counters: { args: 0, results: 0 },
    };
    shakeRows(deps, rows, state);
    await applyShakePatches(deps, sessionId, state.patches);
    const contextSize = await estimateContextSize(deps, sessionId);
    return {
      argsTruncated: state.counters.args,
      resultsTruncated: state.counters.results,
      contextSize,
    };
  };
}
