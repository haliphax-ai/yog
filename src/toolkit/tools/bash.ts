import { z } from "zod";
import { type ToolResult, type ToolSpec } from "../types.ts";
import { middleTruncate } from "../truncation.ts";
export interface BashResult extends ToolResult {
  stdout: string | null;
  stderr: string | null;
  runtimeMs: number | null;
  exitCode: number | null;
}

export interface BashArgs extends Record<string, unknown> {
  command: string;
}

/** Structural view of the persistent-shell snapshot (mirrors the worker's). */
export interface ShellStateProvider {
  load(): Promise<{ cwd?: string; env?: string; functions?: string } | undefined>;
  save(state: { cwd: string; env: string; functions: string }): Promise<void>;
}

/** /shake truncation budgets (chars). */
export const BASH_ARG_TRUNCATE_CHARS = 1000;
export const BASH_RESULT_TRUNCATE_CHARS = 1000;
function truncateStream(text: string, max: number): string {
  return text.length <= max ? text : middleTruncate(text, max);
}

/**
 * Split a 1000-char budget fairly between stdout and stderr (both middle-
 * truncated). Each stream's base share is half the budget; any unused share
 * from one stream is offered to the other.
 */
function fairTruncate(stdout: string, stderr: string, budget: number): [string, string] {
  const half = Math.floor(budget / 2);
  const retainedOut = Math.min(stdout.length, half);
  let remaining = budget - retainedOut;
  const retainedErr = Math.min(stderr.length, remaining);
  remaining -= retainedErr;
  // Unused portion of the second stream flows back to the first.
  const extraOut = Math.min(stdout.length - retainedOut, remaining);
  return [truncateStream(stdout, retainedOut + extraOut), truncateStream(stderr, retainedErr)];
}

/** Options the bash tool forwards to the injected executor. */
export interface BashRequestOpts {
  /**
   * Abort key for the script (a running script is addressable by this id).
   * The turn engine stamps the session id here; callers without a session
   * fall back to the daemon-wide key.
   */
  scriptId?: string;
  /** Directory for the persistent shell-state snapshot. */
  stateDir?: string;
  /** Prior snapshot to restore before running. */
  restore?: { cwd?: string; env?: string; functions?: string };
}

/** Structural result contract the injected executor must satisfy. */
export interface BashExecutionResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
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
      if (!bashExecutor) {
        return {
          stdout: null,
          stderr: null,
          runtimeMs: Math.round(performance.now() - start),
          exitCode: null,
          error: "bash executor not configured",
        };
      }

      // Restore the prior shell snapshot from the agentfs-backed home (if a
      // provider is wired) so state survives across daemon restarts.
      let restore: BashRequestOpts["restore"];
      try {
        restore = await shellProvider?.load();
      } catch {
        restore = undefined;
      }

      const resp = await bashExecutor(args.command, {
        ...(ctx?.sessionId !== undefined ? { scriptId: ctx.sessionId } : {}),
        stateDir: ctx?.stateDir,
        ...(restore ? { restore } : {}),
      });
      const runtimeMs = Math.round(performance.now() - start);

      if (resp.ok && resp.state && shellProvider) {
        try {
          await shellProvider.save(resp.state);
        } catch {
          // A home write failure must not fail the tool call.
        }
      }

      if (!resp.ok) {
        return { stdout: null, stderr: null, runtimeMs, exitCode: null, error: resp.error };
      }
      return {
        stdout: resp.stdout ?? null,
        stderr: resp.stderr ?? null,
        runtimeMs,
        exitCode: resp.exitCode ?? null,
      };
    } catch (err) {
      const runtimeMs = Math.round(performance.now() - start);
      return {
        stdout: null,
        stderr: null,
        runtimeMs,
        exitCode: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  /**
   * /shake: truncate the `command` argument to 1000 chars (middle cut).
   * The arguments are stored as a JSON string; other fields pass through.
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

  /**
   * /shake: truncate stdout/stderr fairly against a shared 1000-char budget
   * (tail-truncated, marker appended where cut). Other fields are preserved.
   */
  truncateResult(value: unknown): unknown | undefined {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const rec = value as Record<string, unknown>;
    const stdout = typeof rec.stdout === "string" ? (rec.stdout as string) : "";
    const stderr = typeof rec.stderr === "string" ? (rec.stderr as string) : "";
    if (
      (rec.stdout === null || rec.stdout === undefined) &&
      (rec.stderr === null || rec.stderr === undefined)
    ) {
      return undefined; // nothing to truncate
    }
    const [newOut, newErr] = fairTruncate(stdout, stderr, BASH_RESULT_TRUNCATE_CHARS);
    if (newOut === rec.stdout && newErr === rec.stderr) return undefined;
    return {
      ...rec,
      stdout: newOut,
      stderr: newErr,
    };
  },
};
