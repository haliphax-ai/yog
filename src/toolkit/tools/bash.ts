import { z } from "zod";
import { type ToolContext, type ToolResult, type ToolSpec } from "../types.ts";
import { fairTruncate, middleTruncate, toolOutputBudgets } from "../truncation.ts";
export interface BashResult extends ToolResult {
  stdout: string | null;
  stderr: string | null;
  runtimeMs: number | null;
  exitCode: number | null;
  /** The death signal when the child was killed; null on a normal exit. */
  signal?: string | null;
}

export interface BashArgs extends Record<string, unknown> {
  command: string;
}

/** Structural view of the persistent-shell snapshot (mirrors the worker's). */
export interface ShellStateProvider {
  load(sessionId: string): Promise<{ cwd?: string; env?: string; functions?: string } | undefined>;
  save(sessionId: string, state: { cwd: string; env: string; functions: string }): Promise<void>;
}

/**
 * Resolves the loaded-skill `scripts/` directories for a session (PATH
 * injection). Injected by the composition root from the `SkillManager`;
 * returns an empty array when the skills system is not wired.
 */
export type SkillPathProvider = (
  sessionId: string,
) => readonly string[] | Promise<readonly string[]>;

let skillPathProvider: SkillPathProvider | undefined;

/** Inject the loaded-skill PATH provider (owned by the composition root). */
export function setSkillPathProvider(provider: SkillPathProvider | undefined): void {
  skillPathProvider = provider;
}

/**
 * Build the all-null failure result every early exit of `run` returns (with
 * the wall-clock `runtimeMs` for the elapsed window).
 */
function nullResult(start: number, error: string): BashResult {
  return {
    stdout: null,
    stderr: null,
    runtimeMs: Math.round(performance.now() - start),
    exitCode: null,
    signal: null,
    error,
  };
}

/** /shake truncation budgets (raw chars). */
export const BASH_ARG_TRUNCATE_CHARS = 500;
export const BASH_RESULT_TRUNCATE_CHARS = 500;

/**
 * Executor arguments for a bash run: the session-scoped abort key plus the
 * optional restore snapshot and skill-PATH injection, omitted when unset.
 */
function executorOpts(
  ctx: ToolContext | undefined,
  restore: BashRequestOpts["restore"],
  extraPath: readonly string[] | undefined,
): BashRequestOpts {
  return {
    ...(ctx?.sessionId !== undefined ? { scriptId: ctx.sessionId } : {}),
    stateDir: ctx?.stateDir,
    ...(restore ? { restore } : {}),
    ...(extraPath ? { extraPath } : {}),
  };
}

/**
 * Restore the prior shell snapshot from the agentfs-backed home (if a
 * provider is wired) so state survives across daemon restarts. The
 * snapshot is keyed by session: sessions must not restore each other's
 * shell. A load failure degrades to no restore.
 */
async function loadRestore(sessionKey: string): Promise<BashRequestOpts["restore"]> {
  try {
    return await shellProvider?.load(sessionKey);
  } catch {
    return undefined;
  }
}

/**
 * Loaded-skill PATH injection: resolve this session's skill scripts
 * (best effort — a failure must not fail the tool call).
 */
async function resolveExtraPath(sessionKey: string): Promise<readonly string[] | undefined> {
  if (!skillPathProvider) return undefined;
  try {
    const paths = await skillPathProvider(sessionKey);
    return paths.length > 0 ? paths : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the fresh shell snapshot after a successful run (best effort — a
 * home write failure must not fail the tool call).
 */
async function saveState(
  sessionKey: string,
  state: { cwd: string; env: string; functions: string },
): Promise<void> {
  if (!shellProvider) return;
  try {
    await shellProvider.save(sessionKey, state);
  } catch {
    // ignore
  }
}

/**
 * The output budget is split fairly between stdout and stderr, both
 * middle-truncated in serialized space (`fairTruncate` in truncation.ts):
 * raw `.length` under-counts escape-dense content (ANSI colors, tabs,
 * backslashes), which previously slipped past this cap and tripped the
 * registry fallback. Each stream's base share is half the budget; any
 * unused share from one stream is offered to the other.
 */
function capStreams(stdout: string, stderr: string): [string, string] {
  const { limit } = toolOutputBudgets();
  return fairTruncate(stdout, stderr, limit);
}

/** Options the bash tool forwards to the injected executor. */
export interface BashRequestOpts {
  /**
   * Abort key for the script (a running script is addressable by this id).
   * The turn engine stamps the session id here; callers without a session
   * fall back to the daemon-wide key.
   */
  scriptId?: string;
  /**
   * Directory for the persistent shell-state snapshot. Omitted in the
   * daemon path: the executor derives it per session
   * (`<stateRoot>/harness/<sessionId>`); an explicit value wins (tests,
   * direct callers).
   */
  stateDir?: string;
  /** Prior snapshot to restore before running. */
  restore?: { cwd?: string; env?: string; functions?: string };
  /**
   * Loaded-skill `scripts/` directories prepended to PATH for this run
   * (resolved from the session's `SkillManager` by the composition root).
   */
  extraPath?: readonly string[];
}

/** Structural result contract the injected executor must satisfy. */
export interface BashExecutionResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** The death signal when the child was killed; null on a normal exit. */
  signal?: string | null;
  state?: { cwd: string; env: string; functions: string };
  error?: string;
}

/**
 * Who runs the shell for us — injected by the composition root. The bash tool
 * deliberately does not know about the worker process; it just asks an
 * executor to run a script and hand back a result.
 */
export type BashExecutor = (script: string, opts?: BashRequestOpts) => Promise<BashExecutionResult>;

/** Abort the script currently running for `key`; false when none is running. */
export type BashAbort = (key: string) => Promise<boolean>;

let bashExecutor: BashExecutor | undefined;
let shellProvider: ShellStateProvider | undefined;
let bashAborts: BashAbort | undefined;

/** Inject the bash executor (owned by the composition root). */
export function setBashExecutor(executor: BashExecutor | undefined): void {
  bashExecutor = executor;
}

/** Inject the agentfs-backed home provider (called once at startup). */
export function setShellStateProvider(provider: ShellStateProvider | undefined): void {
  shellProvider = provider;
}

/**
 * Inject the abort hook (owned by the composition root): kills the worker's
 * active bash child for `key`. The worker snapshots shell state via the
 * wrapper's EXIT trap before the child dies, so persistence is unaffected.
 */
export function setBashAbort(abort: BashAbort | undefined): void {
  bashAborts = abort;
}

/**
 * Abort the script `key` is currently running. Returns false when no abort
 * hook is wired or nothing is running for `key` — the caller decides whether
 * that is an error.
 */
export async function abortBash(key: string): Promise<boolean> {
  if (!bashAborts) return false;
  try {
    return await bashAborts(key);
  } catch {
    return false;
  }
}

export const bashTool: ToolSpec<BashArgs, BashResult> = {
  name: "bash",

  description:
    "Run a bash script in a persistent shell environment. " +
    "cwd, exported variables, and shell functions persist between calls; " +
    "the agent rc (BASH_ENV or ~/.bashrc) is sourced as the baseline. " +
    "stdout/stderr/exitCode map to the shell process; they are null (with " +
    "`error` set) if the call failed validation or threw.",

  schema: z
    .object({
      command: z.string().describe("The bash command/script to execute."),
    })
    .strict(),

  failure(error: string): BashResult {
    return { stdout: null, stderr: null, runtimeMs: null, exitCode: null, error };
  },

  async run(args, ctx): Promise<BashResult> {
    const start = performance.now();
    try {
      if (!bashExecutor) return nullResult(start, "bash executor not configured");
      // Restore the prior shell snapshot from the agentfs-backed home (if a
      // provider is wired) so state survives across daemon restarts. The
      // snapshot is keyed by session: sessions must not restore each other's
      // shell.
      const sessionKey = ctx?.sessionId ?? "daemon";
      const restore = await loadRestore(sessionKey);
      const extraPath = await resolveExtraPath(sessionKey);

      const resp = await bashExecutor(args.command, executorOpts(ctx, restore, extraPath));
      const runtimeMs = Math.round(performance.now() - start);

      // A detached call (yog#90) must not write shell state back to the
      // mirror: its scratch dir is throwaway, and the frozen snapshot it
      // started from is what the manager re-seeds future foreground runs
      // with. The live per-session state stays exactly as the foreground
      // left it.
      if (resp.ok && resp.state && ctx?.detached === undefined) {
        await saveState(sessionKey, resp.state);
      }

      if (!resp.ok) return nullResult(start, resp.error ?? "bash call failed");
      // Limit the tool's own output: the budget (config `toolOutputLimit`,
      // default 50,000 serialized chars) is fairly split across stdout and
      // stderr, each middle-truncated with the shared marker where cut.
      // Budgets are measured on the JSON-serialized lengths (what the
      // transcript actually stores), so the result is guaranteed to fit
      // `toolOutputLimit` before the registry's generic `capToolResult`
      // fallback ever sees it.
      const capped = capStreams(resp.stdout ?? "", resp.stderr ?? "");
      return {
        stdout: capped[0],
        stderr: capped[1],
        runtimeMs,
        exitCode: resp.exitCode ?? null,
        // Death signal (SIGTERM &c.): rides the result so the jobs manager
        // can classify a signal death as a TERMINATION — a waking one.
        signal: resp.signal ?? null,
      };
    } catch (err) {
      return nullResult(start, err instanceof Error ? err.message : String(err));
    }
  },

  /** /shake: truncate the `command` argument (middle cut); other fields pass
   * through. The raw form is truncated verbatim when it is not a JSON object
   * with a string `command`.
   */
  truncateArgs(raw: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return middleTruncate(raw, BASH_ARG_TRUNCATE_CHARS);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return middleTruncate(raw, BASH_ARG_TRUNCATE_CHARS);
    }
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.command !== "string") return raw;
    const command = middleTruncate(rec.command, BASH_ARG_TRUNCATE_CHARS);
    if (command === rec.command) return raw;
    return JSON.stringify({ ...rec, command });
  },

  /** /shake: truncate stdout/stderr fairly against a shared 500-char budget
   * (middle cut, marker appended where content is dropped); other fields are
   * preserved. No change when the value is not an object with at least one
   * string stream or nothing was cut. */
  truncateResult(value: unknown): unknown | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const rec = value as Record<string, unknown>;
    const stdout = typeof rec.stdout === "string" ? (rec.stdout as string) : "";
    const stderr = typeof rec.stderr === "string" ? (rec.stderr as string) : "";
    if (rec.stdout === undefined && rec.stderr === undefined) return undefined;
    const [newOut, newErr] = fairTruncate(stdout, stderr, BASH_RESULT_TRUNCATE_CHARS);
    if (newOut === rec.stdout && newErr === rec.stderr) return undefined;
    return {
      ...rec,
      stdout: newOut,
      stderr: newErr,
    };
  },
};
