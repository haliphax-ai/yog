/**
 * Injected-boundary adapters (yog#91): the manager receives structural
 * boundary fakes; these adapters normalize the optional injections into
 * total, always-callable views so the manager's logic stays branch-free
 * (a missing boundary degrades to a no-op instead of a guard clause at
 * every call site).
 */
import type { JobManagerDeps, PreludeSinkLike, SchedulerLike, WorkerPoolLike } from "./types.ts";

/** The typed orchestrator view the manager drives (structural boundary). */
export interface OrchestratorLike {
  isBusy?(sessionId: string): boolean;
  onIdle?(sessionId: string, cb: () => void): () => void;
  runTurn(
    sessionId: string,
    req: Record<string, unknown>,
  ): { promise: Promise<unknown>; abort: (reason?: unknown) => void };
}

/** Total (no-op) orchestrator view for a missing injection. */
export const NO_ORCHESTRATOR: OrchestratorLike = {
  runTurn: () => ({ promise: Promise.resolve(undefined), abort: () => undefined }),
};

/** Total (no-op) prelude view for a missing injection. */
export const NO_PRELUDE: PreludeSinkLike = {
  push: () => undefined,
  drain: () => undefined,
  clear: () => undefined,
};

/** Total (no-op) pool view for a missing injection. */
export const NO_POOL: WorkerPoolLike = {
  rekeyRun: () => false,
  abortRun: () => Promise.resolve(false),
};

/** The production scheduler (node timers, unref'd) when none is injected. */
export function nodeSchedulerLike(): SchedulerLike {
  return {
    after: (ms: number, fn: () => void) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer as unknown as { active: boolean; dueAt: number };
    },
    cancel: (handle: unknown) => clearTimeout((handle as { timer?: NodeJS.Timeout }).timer),
    now: () => Date.now(),
  };
}

/** The always-callable scheduler view (injected fake wins). */
export function schedulerView(deps: JobManagerDeps): SchedulerLike {
  return deps.scheduler ?? nodeSchedulerLike();
}

/** The always-callable orchestrator view (undefined when not wired). */
export function orchestratorView(deps: JobManagerDeps): OrchestratorLike | undefined {
  const o = deps.orchestrator as OrchestratorLike | undefined;
  if (o === undefined || typeof o.runTurn !== "function") return undefined;
  return o;
}

/** The always-callable pool view (no-op when not wired). */
export function poolView(deps: JobManagerDeps): WorkerPoolLike {
  const p = deps.pool as WorkerPoolLike | undefined;
  if (p === undefined || typeof p.abortRun !== "function") return NO_POOL;
  return p;
}

/** The always-callable prelude view (no-op when not wired). */
export function preludeView(deps: JobManagerDeps): PreludeSinkLike {
  return deps.prelude ?? NO_PRELUDE;
}
