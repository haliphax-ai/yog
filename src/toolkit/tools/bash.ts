import { z } from "zod";
import { type ToolResult, type ToolSpec } from "../types.ts";

export interface BashResult extends ToolResult {
  stdout: string | null;
  stderr: string | null;
  runtimeMs: number | null;
  exitCode: number | null;
}

export interface BashArgs extends Record<string, unknown> {
  script: string;
}

/** Structural view of the persistent-shell snapshot (mirrors the worker's). */
export interface ShellStateProvider {
  load(): Promise<{ cwd?: string; env?: string; functions?: string } | undefined>;
  save(state: { cwd: string; env: string; functions: string }): Promise<void>;
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
      script: z.string().describe("A bash script to execute."),
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

      const resp = await bashExecutor(args.script, {
        ...(ctx?.sessionId !== undefined ? { scriptId: ctx.sessionId } : {}),
        stateDir: process.env["HARNESS_STATE_DIR"],
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
};
