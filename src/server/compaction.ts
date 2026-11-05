/**
 * Session compaction + handoff.
 *
 * Both operations run a *throwaway* summary turn that is orphaned from the
 * session transcript: it never appends history and never receives tools. The
 * turn's only job is to produce a markdown artifact from the shared template
 * (`compaction-template.md`), after which the resulting transcript starts
 * fresh with the artifact.
 *
 * The two commands are the graduated "strong" rungs of the compaction ladder:
 *
 * - `compact`  — guaranteed result. Fits the conversation into the compaction
 *   model's context window (window − 20,000 token margin) by truncating the
 *   **middle** (obvious marker) and runs the summary turn in a **fresh
 *   session**; the old session is left archived untouched.
 * - `handoff` — maximum continuity. Uses a throwaway turn in the **current**
 *   session with the **intact** transcript history for full context awareness
 *   and recency bias.
 *
 * Both accept optional free-text user guidance that is passed to the
 * summarization model.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "../host.ts";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { TurnEngine, type TurnOptions } from "../turn.ts";
import type { TurnSink } from "../turn/sink.ts";
import { ToolRegistry } from "../toolkit/index.ts";

/** Which summary artifact a client is asking for. */
export type CompactionKind = "compact" | "handoff";

/** Outcome of a compaction/handoff run. */
export interface CompactionResult {
  kind: CompactionKind;
  summary: string;
  /** The model that produced the artifact. */
  model: string;
  /** Session whose transcript now leads with the artifact. */
  sessionId: string;
  /** True when the input transcript had to be truncated to fit the window. */
  truncated: boolean;
}

/** Server route boundary: run a compaction for a session. */
export interface CompactionBoundary {
  (sessionId: string, kind: CompactionKind, guidance?: string): Promise<CompactionResult>;
}

/** The slice of the session store the runner needs. */
export interface CompactionStore {
  getSession(id: string): Promise<unknown>;
  getTranscript(sessionId: string): Promise<Array<Record<string, unknown>>>;
  resetTranscript(sessionId: string, msgs: ChatCompletionMessageParam[]): Promise<unknown>;
  /** Used by `compact` to run the summary turn in a fresh session. */
  createSession?(opts?: { title?: string; system?: string }): Promise<{ id: string }>;
}

/** Options for {@link createCompactionRunner}. */
export interface CompactionRunnerDeps {
  client: OpenAI;
  store: CompactionStore;
  /** Default (session) model id. */
  model: string;
  /** Server-configured compaction model; unset = same as `model`. */
  compactionModel?: string;
  modelInfo?: { getContextWindow(modelId: string): number | undefined } | undefined;
}

/** Name of the markdown template file, relative to this module. */
const TEMPLATE_FILE = "compaction-template.md";
const TEMPLATE_PATH = fileURLToPath(new URL(`./${TEMPLATE_FILE}`, import.meta.url));

let templatePromise: Promise<string> | undefined;

/** Load (and memoize) the compaction markdown template from the repo. */
export function loadCompactionTemplate(): Promise<string> {
  templatePromise ??= readFile(TEMPLATE_PATH, "utf8");
  return templatePromise;
}

/** Resolve the model for a summary turn: configured compaction model, else the session model. */
export function resolveCompactionModel(model: string, compactionModel?: string): string {
  return compactionModel !== undefined && compactionModel !== "" ? compactionModel : model;
}

/** Token margin reserved for the output/instructions when fitting a transcript. */
export const COMPACTION_TOKEN_MARGIN = 20_000;

/** Window used when the compaction model's window is unknown. */
export const DEFAULT_COMPACTION_WINDOW = 128_000;

/** chars/4 token heuristic (used where no provider tokenizer is available). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Render the session transcript as a readable text block so the summary
 * model can see the conversation without inheriting OpenAI chat-history
 * semantics (the summary turn is orphaned — it is not a continuation).
 */
export function serializeTranscript(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "(empty session — no transcript rows yet)";
  const lines: string[] = [];
  for (const [index, row] of rows.entries()) {
    const seq = `[${index + 1}] `;
    const role = String(row.role ?? "?");
    let body = typeof row.content === "string" ? (row.content as string) : "";
    if (Array.isArray(row.tool_calls) && row.tool_calls.length > 0) {
      body += (body === "" ? "" : "\n") + "tool_calls: " + JSON.stringify(row.tool_calls);
    }
    if (row.tool_call_id !== undefined) {
      body += `\ntool_call_id: ${String(row.tool_call_id)}`;
    }
    if (typeof row.name === "string" && row.name !== "") {
      body = `${row.name} — ${body}`;
    }
    lines.push(`${seq}${role}: ${body.trim() === "" ? "(no content)" : body.trim()}`);
  }
  return lines.join("\n");
}

/** Marker inserted where the middle of a too-long transcript is dropped. */
export const MIDDLE_TRUNCATION_MARKER =
  "\n\n[... TRUNCATED — middle of conversation omitted to fit the compaction " +
  "model's context window ...]\n\n";

/**
 * Fit a serialized transcript (lines) under a token budget by keeping the
 * earliest and latest lines and truncating the middle. The cut is obvious to
 * the consumer: the dropped span is replaced by {@link MIDDLE_TRUNCATION_MARKER}.
 */
export function fitSerializedTranscript(
  lines: string[],
  budgetTokens: number,
): { text: string; truncated: boolean } {
  const total = lines.reduce((sum, line) => sum + estimateTokens(line), 0);
  if (total <= budgetTokens || lines.length < 2) {
    return { text: lines.join("\n"), truncated: false };
  }
  const half = Math.floor(budgetTokens / 2);
  const head: string[] = [];
  let headTokens = 0;
  for (const line of lines) {
    if (headTokens + estimateTokens(line) > half && head.length > 0) break;
    head.push(line);
    headTokens += estimateTokens(line);
  }
  const tail: string[] = [];
  let tailTokens = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (tailTokens + estimateTokens(line) > half && tail.length > 0) break;
    tail.unshift(line);
    tailTokens += estimateTokens(line);
  }
  return {
    text: head.join("\n") + MIDDLE_TRUNCATION_MARKER + tail.join("\n"),
    truncated: true,
  };
}

/** Strict single-artifact instruction shared by both paths. */
const STRICT_OUTPUT =
  "You must reply with ONLY the completed markdown document as your entire " +
  "output — no preamble, no commentary, no explanations, no code fences, and " +
  "no trailing notes. Do not add any prose before or after the document.";

/** Per-kind instruction: what the artifact is for and how to curate it. */
function kindInstruction(kind: CompactionKind): string {
  if (kind === "compact") {
    return (
      "You are compacting a work session into a concise continuation document. " +
      "Keep it focused on information germane to continuing the work: the goal, " +
      "plan, progress, decisions, and concrete identifiers. Discard useless " +
      "tangents and small-talk leakage. Preserve useful historical context only " +
      "insofar as it informs what to do next."
    );
  }
  return (
    "You are preparing a handoff document for a person or another instance that " +
    "is taking over this work from scratch. Include everything germane: the " +
    "goal, plan overview, progress (completed and to-do), context, and all " +
    "identifiers. Be thorough but disciplined — omit noise, small talk, and " +
    "irrelevant detail."
  );
}

/** Build the message list for a summary turn (system + user only, no tools). */
export function buildCompactionMessages(
  template: string,
  sourceText: string,
  kind: CompactionKind,
  guidance?: string,
): ChatCompletionMessageParam[] {
  let user =
    "Use the template below and fill out every section for this session. " +
    "Replace the <Title> placeholder with a short descriptive title. Do not " +
    "leave any section blank — if a section has nothing relevant, write " +
    '"None." or a brief equivalent.\n\n' +
    template +
    "\n\n== Conversation transcript ==\n\n" +
    sourceText;
  if (guidance !== undefined && guidance.trim() !== "") {
    user += `\n\n== User guidance ==\n\n${guidance.trim()}`;
  }
  return [
    { role: "system", content: `${kindInstruction(kind)}\n\n${STRICT_OUTPUT}` },
    { role: "user", content: user },
  ];
}

/** Empty registry — summary turns never see tools. */
const NO_TOOLS = new ToolRegistry();

/**
 * Build the compaction/handoff runner used by the daemon's HTTP layer.
 *
 * `compact`: fits the conversation to the compaction model's window (minus a
 * 20,000-token margin) by middle-truncation, then runs the summary turn in a
 * freshly created session and returns that session id.
 *
 * `handoff`: runs the summary turn in the current session with the intact
 * transcript and keeps the same session id.
 *
 * Both reset the target session's transcript to the artifact (preserving any
 * original system seed). A failed or empty artifact throws.
 */
export function createCompactionRunner(deps: CompactionRunnerDeps): CompactionBoundary {
  return async (
    sessionId: string,
    kind: CompactionKind,
    guidance?: string,
  ): Promise<CompactionResult> => {
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      const error = new Error(`session ${sessionId} not found`) as Error & { code?: string };
      error.code = "unknown_session";
      throw error;
    }

    const model = resolveCompactionModel(deps.model, deps.compactionModel);
    const window = deps.modelInfo?.getContextWindow(model) ?? DEFAULT_COMPACTION_WINDOW;
    const budget = Math.max(2_000, window - COMPACTION_TOKEN_MARGIN);

    const transcript = await deps.store.getTranscript(sessionId);
    const serialized = serializeTranscript(transcript);
    const lines = serialized.split("\n");

    let sourceText = serialized;
    let truncated = false;
    if (kind === "compact") {
      const fitted = fitSerializedTranscript(lines, budget);
      sourceText = fitted.text;
      truncated = fitted.truncated;
    }

    const template = await loadCompactionTemplate();
    const messages = buildCompactionMessages(template, sourceText, kind, guidance);

    // Orphan turn: the sink only collects the streamed artifact text — nothing
    // is persisted to the session and nothing is published to SSE subscribers.
    let summary = "";
    const sink: TurnSink = {
      async emit(ev) {
        if (ev.type === "message.delta") {
          summary += (ev.data as { text: string }).text;
        }
      },
    };

    // `compact` runs the summary turn in a fresh session (the old session is
    // left untouched); `handoff` stays in the current session.
    let targetSession = sessionId;
    if (kind === "compact" && deps.store.createSession) {
      const created = await deps.store.createSession();
      targetSession = created.id;
    }

    const opts: TurnOptions = {
      sessionId: targetSession,
      maxRounds: 1, // one completion; no tool loop
      ...(deps.modelInfo
        ? { contextWindow: deps.modelInfo.getContextWindow(model) ?? undefined }
        : {}),
    };
    await new TurnEngine(sink).run(deps.client, model, messages, NO_TOOLS, opts);

    const trimmed = summary.trim();
    if (trimmed === "") {
      throw new Error(`compaction produced an empty summary (model ${model})`);
    }

    // Start a fresh transcript with the artifact. The session's original
    // system seed (if any) is preserved; all other history is replaced.
    const systemSeed = transcript.filter(
      (row) => row.role === "system",
    ) as unknown as ChatCompletionMessageParam[];
    const fresh: ChatCompletionMessageParam[] = [
      ...systemSeed,
      { role: "assistant", content: trimmed },
    ];
    await deps.store.resetTranscript(targetSession, fresh);

    return { kind, summary: trimmed, model, sessionId: targetSession, truncated };
  };
}
