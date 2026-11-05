/**
 * Session compaction + handoff.
 *
 * Both operations run a *throwaway* summary turn that is orphaned from the
 * session transcript: it never appends history and never receives tools. The
 * turn's only job is to produce a markdown artifact from the shared template
 * (`compaction-template.md`), after which the session transcript is reset to
 * a fresh one containing the artifact. The artifact is produced using a
 * second copy of the session's model by default, or a server-configured
 * compaction model (`config.compactionModel`).
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
}

/** Server route boundary: run a compaction for a session. */
export interface CompactionBoundary {
  (sessionId: string, kind: CompactionKind): Promise<CompactionResult>;
}

/** The slice of the session store the runner needs. */
export interface CompactionStore {
  getSession(id: string): Promise<unknown>;
  getTranscript(sessionId: string): Promise<Array<Record<string, unknown>>>;
  resetTranscript(sessionId: string, msgs: ChatCompletionMessageParam[]): Promise<unknown>;
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
  transcript: Array<Record<string, unknown>>,
  kind: CompactionKind,
): ChatCompletionMessageParam[] {
  const user =
    "Use the template below and fill out every section for this session. " +
    "Replace the <Title> placeholder with a short descriptive title. Do not " +
    "leave any section blank — if a section has nothing relevant, write " +
    '"None." or a brief equivalent.\n\n' +
    template +
    "\n\n== Conversation transcript ==\n\n" +
    serializeTranscript(transcript);
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
 * The runner owns a throwaway, orphaned turn: a fresh model completion with
 * no tools and no session history (the transcript is supplied as prompt
 * content). On success it resets the session transcript to a fresh one that
 * contains just the produced artifact. A failed or empty artifact throws.
 */
export function createCompactionRunner(deps: CompactionRunnerDeps): CompactionBoundary {
  return async (sessionId: string, kind: CompactionKind): Promise<CompactionResult> => {
    const session = await deps.store.getSession(sessionId);
    if (!session) {
      const error = new Error(`session ${sessionId} not found`) as Error & { code?: string };
      error.code = "unknown_session";
      throw error;
    }

    const model = resolveCompactionModel(deps.model, deps.compactionModel);
    const transcript = await deps.store.getTranscript(sessionId);
    const template = await loadCompactionTemplate();
    const messages = buildCompactionMessages(template, transcript, kind);

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
    const opts: TurnOptions = {
      sessionId,
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
    await deps.store.resetTranscript(sessionId, fresh);

    return { kind, summary: trimmed, model };
  };
}
