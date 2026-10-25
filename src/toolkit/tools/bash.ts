import { z } from "zod";
import { type ToolResult, type ToolSpec } from "../index.ts";
import { WorkerClient } from "../../worker/index.ts";
import type { ShellSnapshot } from "../../worker/protocol.ts";

export interface BashResult extends ToolResult {
  stdout: string | null;
  stderr: string | null;
  runtimeMs: number | null;
  exitCode: number | null;
}

export interface BashArgs extends Record<string, unknown> {
  script: string;
}

/**
 * Optional source/sink for the persistent shell state, injected by the
 * composition root. When set, every bash call restores the previous snapshot
 * before running and persists the post-run snapshot afterwards — making the
 * shell's home state agentfs-backed (queryable and rewindable).
 */
export interface ShellStateProvider {
  load(): Promise<Partial<ShellSnapshot> | undefined>;
  save(state: ShellSnapshot): Promise<void>;
}

let workerPromise: Promise<WorkerClient> | undefined;
let shellProvider: ShellStateProvider | undefined;

/** Inject the agentfs-backed home provider (called once at startup). */
export function setShellStateProvider(provider: ShellStateProvider | undefined): void {
  shellProvider = provider;
}

function getWorker(): Promise<WorkerClient> {
  workerPromise ??= WorkerClient.start();
  return workerPromise;
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

  async run(args): Promise<BashResult> {
    const start = performance.now();
    try {
      const worker = await getWorker();

      let restore: Partial<ShellSnapshot> | undefined;
      try {
        restore = await shellProvider?.load();
      } catch {
        // A home read failure must not fail the tool call.
        restore = undefined;
      }

      const resp = await worker.runBash(args.script, process.env["HARNESS_STATE_DIR"], restore);
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
        stdout: resp.stdout,
        stderr: resp.stderr,
        runtimeMs,
        exitCode: resp.exitCode,
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
