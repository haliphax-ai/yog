/**
 * The bash tool's global seams, wired to the daemon's real boundaries.
 *
 * The toolkit's bash tool is deliberately executor-agnostic: it asks an
 * injected executor to run a script and hands the result back. The daemon
 * owns the concrete executor (the worker pool), the persistent-shell state
 * store (the agent state db), the skill-PATH source (the skills registry),
 * and the abort kill switch — this module adapts one to the other.
 */
import type { WorkerResponse } from "../../worker/index.ts";
import type {
  BashExecutionResult,
  BashRequestOpts,
  ShellStateProvider,
  SkillPathProvider,
} from "../../toolkit/index.ts";
import {
  setBashAbort,
  setBashExecutor,
  setShellStateProvider,
  setSkillPathProvider,
} from "../../toolkit/index.ts";
import type { AgentFSState } from "../../state/index.ts";
import { harnessStateDir } from "../../state/index.ts";
import type { SkillManager } from "../../skills/index.ts";
import type { WorkerPool } from "../workpool.ts";
import type { YogConfig } from "../../config.ts";

/** Map a worker reply onto the executor's result contract. */
function executorResult(resp: WorkerResponse): BashExecutionResult {
  if (resp.ok) {
    return {
      ok: true,
      stdout: resp.stdout,
      stderr: resp.stderr,
      exitCode: resp.exitCode,
      ...(resp.state !== undefined ? { state: resp.state } : {}),
    };
  }
  return { ok: false, stdout: "", stderr: "", exitCode: null, error: resp.error };
}

/**
 * The pool-backed executor. The script id doubles as the abort key (a
 * session's current script is the one an abort kills) and keys the
 * persistent-shell state dir (`<stateRoot>/harness/<sessionId>`).
 */
function poolExecutor(
  pool: WorkerPool,
  config: YogConfig,
  cliBinDir: string,
): (script: string, opts?: BashRequestOpts) => Promise<BashExecutionResult> {
  return async (script, opts) => {
    try {
      const sessionId = opts?.scriptId ?? "daemon";
      const resp = await pool.run(sessionId, script, {
        stateDir: opts?.stateDir ?? harnessStateDir(sessionId, config.stateRoot),
        ...(opts?.restore !== undefined ? { restore: opts.restore } : {}),
        ...(opts?.extraPath !== undefined && opts.extraPath.length > 0
          ? { extraPath: opts.extraPath }
          : {}),
        ...(cliBinDir !== "" ? { cliBin: cliBinDir } : {}),
      });
      return executorResult(resp);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * Snapshot persistence for the persistent shell: load returns the stored
 * snapshot (`undefined` on any failure — a degraded store means no
 * restore), save is best effort (a home write failure must not fail the
 * tool call).
 */
function stateBackedShellStore(state: AgentFSState): ShellStateProvider {
  return {
    async load(sessionId) {
      try {
        return await state.loadShellSnapshot(sessionId);
      } catch {
        return undefined;
      }
    },
    async save(sessionId, s) {
      try {
        await state.saveShellSnapshot(sessionId, s);
      } catch {
        // best effort: a home write failure must not fail the tool call
      }
    },
  };
}

/**
 * Wire the bash tool's executor + shell-state store when their boundaries
 * exist. Without a pool the executor stays unset (the tool reports "bash
 * executor not configured"); without agent state snapshots simply do not
 * persist.
 */
export function wireBashExecutor(
  config: YogConfig,
  wiring: {
    pool: WorkerPool | undefined;
    state: AgentFSState | undefined;
    cliBinDir: string;
  },
): void {
  const { pool, state, cliBinDir } = wiring;
  if (pool === undefined) return;
  setBashExecutor(poolExecutor(pool, config, cliBinDir));
  if (state !== undefined) setShellStateProvider(stateBackedShellStore(state));
}

/** The skill-PATH source: a session's loaded skills' `scripts/` dirs. */
export function skillPathProvider(skills: SkillManager | undefined): SkillPathProvider {
  return (sessionId) => (skills !== undefined ? skills.getScriptPathsFor(sessionId) : []);
}

/**
 * Wire every bash-tool seam the daemon owns: the executor (+ shell-state
 * store), the abort kill switch, and the skill-PATH provider.
 */
export function wireBashTool(
  config: YogConfig,
  wiring: {
    pool: WorkerPool | undefined;
    state: AgentFSState | undefined;
    skills: SkillManager | undefined;
    cliBinDir: string;
  },
): void {
  wireBashExecutor(config, wiring);
  setSkillPathProvider(skillPathProvider(wiring.skills));
  // Turn-abort kill chain: the abort endpoint kills the session's in-flight
  // bash script (script key = session id), which snapshots the persistent
  // shell state before the child dies.
  setBashAbort(async (sessionId) =>
    wiring.pool !== undefined ? wiring.pool.abortScript(sessionId) : false,
  );
}

/**
 * Unwire every bash-tool seam (daemon shutdown): the tool reports "bash
 * executor not configured" instead of touching a torn-down pool.
 */
export function unwireBashTool(): void {
  setBashExecutor(undefined);
  setShellStateProvider(undefined);
  setSkillPathProvider(undefined);
  setBashAbort(undefined);
}
