/**
 * `/shake` — the softest rung of the compaction ladder. Mechanical, local,
 * model-free transcript rewriting: tool-call arguments and tool results are
 * truncated (tail-first) using each tool's own truncator, with the global
 * {@link TRUNCATION_IDENTIFIER} marking every cut. No summary is produced and
 * no session/transcript reset happens — the same rows are rewritten in place.
 */

import type { ToolRegistry } from "../toolkit/index.ts";
import { TRUNCATION_IDENTIFIER } from "../toolkit/index.ts";

/** Outcome of one shake pass. */
export interface ShakeOutcome {
  /** Number of tool-call argument payloads truncated. */
  argsTruncated: number;
  /** Number of tool-result payloads truncated. */
  resultsTruncated: number;
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
}

export { TRUNCATION_IDENTIFIER };

/**
 * Build the shake runner: rewrite a session's transcript in place, applying
 * each tool's `truncateArgs`/`truncateResult` hooks. Rows that change are
 * patched via the store; seq/turnId/timestamps are untouched.
 */
export function createShakeRunner(deps: ShakeDeps) {
  return async (sessionId: string): Promise<ShakeOutcome> => {
    const rows = await deps.store.getTranscript(sessionId);
    let argsTruncated = 0;
    let resultsTruncated = 0;

    // Map tool-call id → tool name, from the assistant rows that announced
    // the calls (the tool result rows may not carry a name column).
    const callName = new Map<string, string>();

    // Pending row patches: seq → { tool_calls_json } | { content }.
    const patches = new Map<number, { tool_calls_json?: string; content?: string }>();

    const patch = (seq: number, p: { tool_calls_json?: string; content?: string }): void => {
      const existing = patches.get(seq) ?? {};
      patches.set(seq, { ...existing, ...p });
    };

    for (const row of rows) {
      const seq = Number(row.seq);
      if (!Number.isFinite(seq)) continue;
      const role = row.role;

      if (role === "assistant" && Array.isArray(row.tool_calls)) {
        const calls = row.tool_calls as Array<{
          id?: unknown;
          function?: { name?: unknown; arguments?: unknown };
        }>;
        let next = calls;
        let changed = false;
        for (const call of calls) {
          const id = typeof call.id === "string" ? call.id : undefined;
          const name = typeof call.function?.name === "string" ? call.function.name : undefined;
          if (id !== undefined && name !== undefined) callName.set(id, name);
          if (name === undefined) continue;
          const tool = deps.registry.get(name);
          if (!tool?.truncateArgs) continue;
          const raw = typeof call.function?.arguments === "string" ? call.function.arguments : "";
          if (raw === "") continue;
          const replacement = tool.truncateArgs(raw);
          if (replacement === raw) continue;
          next = next.map((c) =>
            c === call ? { ...c, function: { ...c.function, arguments: replacement } } : c,
          );
          changed = true;
          argsTruncated += 1;
        }
        if (changed) patch(seq, { tool_calls_json: JSON.stringify(next) });
      }

      if (role === "tool") {
        const name =
          typeof row.name === "string" && row.name !== ""
            ? row.name
            : typeof row.tool_call_id === "string"
              ? callName.get(row.tool_call_id)
              : undefined;
        const tool = name !== undefined ? deps.registry.get(name) : undefined;
        if (!tool?.truncateResult) continue;
        if (typeof row.content !== "string") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.content);
        } catch {
          continue; // not JSON-shaped — leave it alone
        }
        const replacementValue = tool.truncateResult(parsed);
        if (replacementValue === undefined) continue;
        const replacement = JSON.stringify(replacementValue);
        if (replacement === row.content) continue;
        patch(seq, { content: replacement });
        resultsTruncated += 1;
      }
    }

    for (const [seq, p] of patches) {
      await deps.store.updateMessage(sessionId, seq, {
        ...(p.tool_calls_json !== undefined ? { tool_calls_json: p.tool_calls_json } : {}),
        ...(p.content !== undefined ? { content: p.content } : {}),
      });
    }

    return { argsTruncated, resultsTruncated };
  };
}
