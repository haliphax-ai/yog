import type { ToolResult } from "../../toolkit/index.ts";
/**
 * Shared shapes for the background-jobs domain (yog#91): the in-memory job
 * row, the per-session scheduling state, the injected dependencies, and the
 * config-derived options the composition root resolves.
 */

/** A detached job's lifecycle state. */
export type JobState = "running" | "finished" | "terminated";

/** Why a job was terminated (never set for a plain finish). */
export type JobTermReason =
  | "max runtime"
  | "no free background-job slot"
  | "max concurrent jobs"
  | "operator abort"
  | "detach policy failed";

/** One background job (in-memory row — nothing survives a restart). */
export interface BackgroundJob {
  /** The job id (the `bg:<jobId>` pool run key and the `backgroundJobId` row). */
  readonly id: string;
  /** Owning session id. */
  readonly sessionId: string;
  /** Tool name (e.g. `bash`). */
  readonly tool: string;
  /** Raw JSON arguments exactly as the registry received them. */
  readonly argsJson: string | null;
  /** The call's start (detach) time, epoch ms. */
  readonly startedAt: number;
  /** The settle time, epoch ms (unset while running). */
  endedAt?: number;
  /** Lifecycle state. */
  state: JobState;
  /** The retained (capped) result once the call settles. */
  result?: ToolResult;
  /** The worker wrapper child's pid (`kill -- -<pid>`), when known. */
  pid?: number;
  /** Termination reason (state `terminated` only). */
  termReason?: JobTermReason;
  /** True once the result has been delivered in a wake prompt. */
  delivered?: boolean;
}

/** Per-session scheduling state: slots, rung, timers. */
export interface JobSessionState {
  /** Live (undelivered, unsettled) job count against the slot cap. */
  running: number;
  /** Current wake-ladder rung index (0 = first). */
  rung: number;
  /** The armed ladder timer (one per session at most). */
  ladderTimer?: { readonly active: boolean; readonly dueAt: number };
  /** Jobs settled but not yet delivered (ride the next wake). */
  pending: string[];
}

/** Injected dependencies — every boundary optional so tests can fake it. */
export interface JobManagerDeps {
  /** Bash worker pool (rekey, pid ops, session-keyed kills). */
  pool?: WorkerPoolLike | unknown;
  /** Turn orchestration (isBusy gate + wake-turn delivery). */
  orchestrator?:
    | {
        isBusy?(sessionId: string): boolean;
        onIdle?(sessionId: string, cb: () => void): () => void;
        runTurn(
          sessionId: string,
          req: Record<string, unknown>,
        ): {
          promise: Promise<unknown>;
          abort: (reason?: unknown) => void;
        };
      }
    | unknown;
  /** Per-session prelude notices (idle-abort termination). */
  prelude?: PreludeSinkLike;
  /** Deterministic time (fake-clock tests inject a Scheduler). */
  scheduler?: SchedulerLike;
  /** Settled-job audit rows (agentfs tool_calls). */
  recordSettled?: (rec: {
    name: string;
    parameters?: unknown;
    result?: unknown;
    error?: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    sessionId: string;
  }) => Promise<void>;
  /**
   * Live job-lifecycle events (the client's drawer runs off the SSE
   * stream, not a poll): `emit(sessionId, envelope)` publishes onto the
   * session's stream channel. Structural: the real bus, a fake in tests.
   */
  jobEvents?(sessionId: string, envelope: { type: string; data: Record<string, unknown> }): void;
  /** The last turn's model id per session (wake turns reuse it). */
  modelFor?: (sessionId: string) => Promise<string | undefined> | string | undefined;
}

/** The prelude-sink surface the manager uses (structural, not nominal). */
export interface PreludeSinkLike {
  push(sessionId: string, kind: string, body: string): void;
  pushResult(sessionId: string, kind: string, body: string, tool: string, result: unknown): void;
  drain(
    sessionId: string,
  ): Array<{ kind: string; body: string; tool?: string; result?: unknown }> | undefined;
  clear(sessionId: string): void;
}

/** The scheduler surface the manager uses (structural; real or fake). */
export interface SchedulerLike {
  after(ms: number, fn: () => void): { readonly active: boolean; readonly dueAt: number };
  cancel(handle: unknown): void;
  now(): number;
}

/** Resolved, injected options (from config at the composition root). */
export interface JobManagerOptions {
  /** Detach threshold (config `bgDetachMs`). */
  readonly detachMs: number;
  /** Per-session slot cap (config `bgMaxJobsPerSession` ?? pool default). */
  readonly maxJobsPerSession: number;
  /** Daemon-wide job ceiling (config `bgMaxJobsTotal` ?? 4 × slot default). */
  readonly maxJobsTotal: number;
  /** Graduated wake ladder (config `bgWakeLadderMs`). */
  readonly wakeLadderMs: readonly number[];
  /** Per-job lifetime cap (config `bgJobMaxMs`). */
  readonly jobMaxMs: number;
  /** Settled-job retention (config `bgJobTtlMs` ?? 24h). */
  readonly jobTtlMs: number;
  /** Per-job serialized char budget in wake prompts (toolOutputLimit). */
  readonly toolOutputLimit: number;
  /**
   * The max jobs one wake turn delivers (a per-wake BATCH cap, on top of
   * the per-job `toolOutputLimit` truncation): an unbounded batch
   * multiplies the per-job budget into a context-window overflow. Jobs
   * beyond the cap stay pending and ride the next wake turn.
   */
  readonly maxJobsPerWake: number;
  /** The session model id (wake-turn model when no last turn is known). */
  readonly modelId: string;
}

/** The worker-pool surface the manager uses (structural, not nominal). */
export interface WorkerPoolLike {
  /** Retarget a live run (detach-time rekey). */
  rekeyRun(oldKey: string, newKey: string): boolean;
  /** Kill the script running under a key (job-keyed / session-keyed). */
  abortRun(key: string): Promise<boolean>;
  /** Out-of-band pid query (`bash.pid`), when the pool exposes it. */
  runPid?(key: string): Promise<{ pid: number | null; pgid: number | null }>;
}
