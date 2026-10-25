import { z } from "zod";
import { type ToolResult, type ToolSpec } from "../index.ts";
import { WorkerClient } from "../../worker/index.ts";

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
 * The bash tool executes through the worker process, never directly in the
 * harness. The worker owns the persistent shell (cwd/export/function state
 * carried between calls) and spawns bash with a minimal environment, so host
 * credentials never reach the tool.
 */
let workerPromise: Promise<WorkerClient> | undefined;

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
      const resp = await worker.runBash(args.script, process.env["HARNESS_STATE_DIR"]);
      const runtimeMs = Math.round(performance.now() - start);
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
