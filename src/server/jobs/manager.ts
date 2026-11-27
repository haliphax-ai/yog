/**
 * JobManager — the background-jobs integration point (yog#91).
 *
 * The manager arms the toolkit's detach policy ({@link setToolDetachPolicy})
 * and owns everything after the threshold: per-session slots, the graduated
 * wake ladder, the per-job cap, and wake-turn delivery. Jobs are in-memory
 * only — the tool call does not survive a daemon restart, so neither do
 * jobs, timers, or rungs (completion forensics land in agentfs audit rows
 * via the injected recorder).
 *
 * Detach (the threshold race finds a free slot): the call's retained result
 * promise is registered as the job's eventual outcome, the live pool run is
 * rekeyed under `bg:<jobId>` (session-keyed aborts can never kill it), the
 * job's `pid` is stamped from the out-of-band pid query, a cap timer is
 * armed, and the wake ladder runs. The call resolves inline with the
 * synthetic `{backgroundJobId}` row, so the transcript never has a dangling
 * `tool_call_id`. No free slot → the call is terminated immediately (bash:
 * session-keyed kill; generic tools: abandoned) — error result, no job row.
 *
 * Wake ladder (`bgWakeLadderMs`): advance one rung when a wake fires with
 * nothing settled; hold at the current rung when jobs settled since the
 * last wake; reset to rung 0 only when the queue clears. Jobs that settle
 * while a turn is live are marked pending and ride the next wake, batched
 * into one shared prompt. A wake turn is an ordinary turn (`revive: true`,
 * so dormant sessions reopen): own row, events, SSE, rate-limit handling.
 *
 * Idle abort (`turn.abort` with no live turn) kills every job for the
 * session, wipes timers, resets the rung, and queues a prelude notice —
 * no wake turn. The abort reply gains the additive `aborted.backgroundJobs`
 * count. `session.detach {purge:true}` kills the same way and then drops
 * the records (no zombie wakes against a purged session).
 *
 * Every boundary is injected (pool, orchestrator, prelude sink, scheduler,
 * recorder, model lookup — all structural types), so fake-clock tests drive
 * the whole ladder deterministically and the composition root stays the
 * only place that knows the concrete boundaries.
 */
import {
  setToolDetachPolicy,
  type DetachCall,
  type ToolDetachPolicy,
  type ToolResult,
  type DetachVerdict,
} from "../../toolkit/index.ts";
import { newSessionId } from "../../state/index.ts";
import type { BackgroundJob, JobSessionState, JobTermReason } from "./types.ts";
import type { JobManagerDeps, JobManagerOptions } from "./types.ts";
import type { PreludeSinkLike, SchedulerLike, WorkerPoolLike } from "./types.ts";
import {
  orchestratorView,
  poolView,
  preludeView,
  schedulerView,
  type OrchestratorLike,
} from "./adapters.ts";
import { buildWakePrompt, settleNoticeResult, settleSeconds } from "./wake.ts";
import {
  advanceRung,
  collectPending,
  queueCleared,
  rungDelayMs,
  sliceToWakeCap,
} from "./ladder.ts";
import type { AbortContext } from "./abort.ts";
import { jobSettledEvent, jobStartedEvent } from "./events.ts";
import { PRUNE_SWEEP_MS, pruneExpiredJobs } from "./prune.ts";

export class JobManager {
  readonly #opts: JobManagerOptions;
  readonly #deps: JobManagerDeps;
  /** Every job, daemon-wide (the CLI/jobs surface reads daemon-wide too). */
  readonly #jobs = new Map<string, BackgroundJob>();
  /** Per-session scheduling state (slots, rung, ladder timer, pending). */
  readonly #sessions = new Map<string, JobSessionState>();
  /** Per-session orchestrator idle subscriptions (one live at a time). */
  readonly #idleSubs = new Map<string, () => void>();
  /** Per-job cap timers (canceled at settle/terminate, not at unwire-only). */
  readonly #capTimers = new Map<string, { readonly active: boolean; readonly dueAt: number }>();
  /** The hourly settled-job TTL sweep (re-arms itself; one live at most). */
  #pruneTimer?: { readonly active: boolean; readonly dueAt: number };
  /** The fixed sweep cadence: one hour (the TTL itself is configurable). */
  static readonly PRUNE_SWEEP_MS = PRUNE_SWEEP_MS;
  /** Resolved boundary views (no-op when the injection is absent). */
  readonly #sched: SchedulerLike;
  readonly #orch: OrchestratorLike | undefined;
  readonly #poolView: WorkerPoolLike;
  readonly #preludeView: PreludeSinkLike;
  #policyArmed = false;

  constructor(opts: JobManagerOptions, deps: JobManagerDeps = {}) {
    this.#opts = opts;
    this.#deps = deps;
    this.#sched = schedulerView(deps);
    this.#orch = orchestratorView(deps);
    this.#poolView = poolView(deps);
    this.#preludeView = preludeView(deps);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Arm the module-level detach policy (the toolkit seam). Idempotent: the
   * policy is armed once; the latest manager wins (same pattern as the
   * output budgets).
   */
  wire(): void {
    if (this.#policyArmed) return;
    this.#policyArmed = true;
    setToolDetachPolicy(this.#policy());
    this.#armPruneSweep();
  }

  /** Disarm the detach policy and cancel every timer/subscription. */
  unwire(): void {
    if (this.#policyArmed) setToolDetachPolicy(undefined);
    this.#policyArmed = false;
    this.#cancelAllTimers();
  }

  /** Tear down: unwire + drop state (daemon shutdown). */
  close(): void {
    this.unwire();
    this.#jobs.clear();
    this.#sessions.clear();
    this.#capTimers.clear();
  }

  /** Cancel every ladder + cap timer and idle subscription (owned only). */
  #cancelAllTimers(): void {
    for (const st of this.#sessions.values()) {
      if (st.ladderTimer !== undefined) {
        this.#sched.cancel(st.ladderTimer);
        st.ladderTimer = undefined;
      }
    }
    for (const handle of this.#capTimers.values()) this.#sched.cancel(handle);
    this.#capTimers.clear();
    if (this.#pruneTimer !== undefined) {
      this.#sched.cancel(this.#pruneTimer);
      this.#pruneTimer = undefined;
    }
    for (const unsub of this.#idleSubs.values()) unsub();
    this.#idleSubs.clear();
  }

  /** Arm the hourly settled-job sweep (re-arms itself after each pass). */
  #armPruneSweep(): void {
    if (this.#pruneTimer !== undefined) return;
    this.#pruneTimer = this.#sched.after(JobManager.PRUNE_SWEEP_MS, () => {
      this.#pruneTimer = undefined;
      pruneExpiredJobs(this.#stateCtx(), this.#opts.jobTtlMs);
      this.#armPruneSweep();
    });
  }

  /** The shared state view (PruneContext; AbortContext extends it). */
  #stateCtx(): {
    jobs: Map<string, BackgroundJob>;
    sessions: Map<string, JobSessionState>;
    idleSubs: Map<string, () => void>;
    sched: SchedulerLike;
  } {
    return {
      jobs: this.#jobs,
      sessions: this.#sessions,
      idleSubs: this.#idleSubs,
      sched: this.#sched,
    };
  }

  // ── injected boundaries (structural, optional) ───────────────────────────

  // ── read surfaces (the agent surface slice consumes these) ───────────────

  /** Jobs for one session, in start order. */
  jobsFor(sessionId: string): BackgroundJob[] {
    return [...this.#jobs.values()].filter((j) => j.sessionId === sessionId);
  }

  /** Every live job, daemon-wide (the agent-CLI has no session context). */
  allJobs(): BackgroundJob[] {
    return [...this.#jobs.values()];
  }

  /** One job by id. */
  job(id: string): BackgroundJob | undefined {
    return this.#jobs.get(id);
  }

  #session(sessionId: string): JobSessionState {
    let st = this.#sessions.get(sessionId);
    if (st === undefined) {
      st = { running: 0, rung: 0, pending: [] };
      this.#sessions.set(sessionId, st);
    }
    return st;
  }

  // ── operator abort (turn.abort while idle) + purge ───────────────────────

  /** The operator-view the abort/purge/wake-stop operators share. */
  #abortCtx(): AbortContext {
    return {
      ...this.#stateCtx(),
      capTimers: this.#capTimers,
      poolView: this.#poolView,
      preludeView: this.#preludeView,
      recordAudit: (job) => this.#recordAudit(job),
      emitEvent: (sessionId, envelope) => this.#emitJobEvent(sessionId, envelope),
    };
  }

  /**
   * Kill every job for the session (idle abort): terminate, wipe timers,
   * reset the rung, and queue the prelude notice — no wake turn. Returns
   * the number of jobs terminated (the reply's `aborted.backgroundJobs`).
   */
  /** The operator view (the abort/purge/wake-stop free functions' state). */
  operator(): AbortContext {
    return this.#abortCtx();
  }

  // ── the detach policy (the toolkit seam) ─────────────────────────────────

  /**
   * The policy the registry consults at every threshold. Free slot →
   * register + rekey + stamp pid + arm timers and answer `detach`; slots
   * full → terminate (bash: session-keyed kill; generic: abandon).
   */
  #policy(): ToolDetachPolicy {
    return {
      thresholdMs: this.#opts.detachMs,
      onThreshold: async (call: DetachCall): Promise<DetachVerdict> => {
        const sessionId = call.sessionId;
        if (sessionId === undefined) {
          // Non-session callers (the CLI path): nothing manages them.
          return { kind: "terminate", reason: "background jobs are session-scoped" };
        }
        const st = this.#session(sessionId);
        // Capacity = live + undelivered pendings (both hold the job's
        // result in memory and both are owed a wake): a slot frees at
        // settle, but the job stays under the cap until DELIVERED — or a
        // busy session piles pendings past its slots and floods the next
        // wake turn.
        if (st.running + st.pending.length >= this.#opts.maxJobsPerSession) {
          return await this.#terminateVerdict(sessionId, "no free background-job slot");
        }
        if (this.#totalUnsettled() >= this.#opts.maxJobsTotal) {
          return await this.#terminateVerdict(sessionId, "max concurrent jobs");
        }
        return await this.#detachVerdict(call, sessionId, st);
      },
    };
  }

  /** No free capacity: kill the call via the session key (bash) / abandon. */
  async #terminateVerdict(sessionId: string, reason: JobTermReason): Promise<DetachVerdict> {
    await this.#poolView?.abortRun(sessionId).catch(() => false);
    return { kind: "terminate", reason };
  }

  /** The daemon-wide count of unsettled jobs (running + undelivered). */
  #totalUnsettled(): number {
    let total = 0;
    for (const st of this.#sessions.values()) total += st.running + st.pending.length;
    return total;
  }

  /** Free slot: register the job, hand over the result, arm the timers. */
  async #detachVerdict(
    call: DetachCall,
    sessionId: string,
    st: JobSessionState,
  ): Promise<DetachVerdict> {
    const job: BackgroundJob = {
      id: `bg_${newSessionId()}`,
      sessionId,
      tool: call.tool,
      argsJson: call.argsJson,
      // The call's TRUE wall-clock start (stamped by the registry when
      // the tool run began, and carried on DetachCall): elapsed/duration
      // is TOTAL runtime — threshold-to-settle is only the background tail.
      startedAt: call.startedAt,
      state: "running",
    };
    this.#register(job, st);
    this.#retainResult(job.id, call.result);
    return { kind: "detach", jobId: job.id };
  }

  /** Register the job: row, slot, pool rekey, pid stamp, cap + ladder. */
  #register(job: BackgroundJob, st: JobSessionState): void {
    this.#jobs.set(job.id, job);
    st.running += 1;
    // Retarget the live run under bg:<jobId> so session-keyed aborts can
    // never kill it (the pool drops the session key on rekey).
    this.#poolView.rekeyRun(job.sessionId, `bg:${job.id}`);
    // Stamp the pid out of band (never queues behind the serial chain).
    void this.#stampPid(job.id);
    // The client's drawer runs off the stream, not a poll: job.started
    // carries the fields the row renders (runtime is computed from
    // startedAt until a settled event stamps the real duration).
    this.#emitJobEvent(job.sessionId, jobStartedEvent(job));
    // Cap timer + wake ladder at rung 0 (when nothing is armed yet).
    this.#armCap(job.id);
    this.#armLadder(job.sessionId);
  }

  /** Retain the call's result promise as the job's eventual outcome. */
  #retainResult(jobId: string, result: Promise<ToolResult>): void {
    void result.then(
      (value) => this.#settle(jobId, value, undefined),
      (err: unknown) => this.#settle(jobId, undefined, err),
    );
  }

  /** Stamp the job's pid via the pool's out-of-band query, best effort. */
  async #stampPid(jobId: string): Promise<void> {
    const { runPid } = this.#poolView;
    if (runPid === undefined) return;
    try {
      const ids = await runPid(`bg:${jobId}`);
      const job = this.#jobs.get(jobId);
      if (job !== undefined && ids.pid !== null) job.pid = ids.pid;
    } catch {
      // Forensics only: a missing pid is not a failure.
    }
  }

  /** Arm (or re-arm) the per-job cap timer (`bgJobMaxMs`). */
  #armCap(jobId: string): void {
    const handle = this.#sched.after(this.#opts.jobMaxMs, () => {
      this.#capTimers.delete(jobId);
      this.#terminate(jobId, "max runtime");
    });
    this.#capTimers.set(jobId, handle);
  }

  /** Terminate a running job: pool-keyed kill (bash) or plain abandon. */
  #terminate(jobId: string, reason: JobTermReason): void {
    const job = this.#stampTerminated(jobId, reason);
    if (job === undefined) return;
    // Bash jobs die via the job-keyed abort; generic tools are abandoned.
    void this.#poolView.abortRun(`bg:${jobId}`).catch(() => undefined);
    this.#recordAudit(job);
    this.#markPending(job);
    void this.#maybeDeliver(job.sessionId);
  }

  /** Stamp a running job terminated + release its slot/cap (no delivery). */
  #stampTerminated(jobId: string, reason: JobTermReason): BackgroundJob | undefined {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.state !== "running") return undefined;
    job.state = "terminated";
    job.termReason = reason;
    job.endedAt = this.#sched.now();
    const st = this.#session(job.sessionId);
    st.running = Math.max(0, st.running - 1);
    this.#cancelCap(jobId);
    return job;
  }

  /** Cancel one job's cap timer (no-op when none is armed). */
  #cancelCap(jobId: string): void {
    const cap = this.#capTimers.get(jobId);
    if (cap === undefined) return;
    this.#sched.cancel(cap);
    this.#capTimers.delete(jobId);
  }

  // ── settle + pending + delivery ──────────────────────────────────────────

  /** The retained result promise settled: record the outcome, maybe deliver. */
  #settle(jobId: string, result: ToolResult | undefined, err: unknown): void {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.state !== "running") return;
    job.endedAt = this.#sched.now();
    this.#cancelCap(jobId);
    job.state = "finished";
    job.result =
      err !== undefined
        ? { error: err instanceof Error ? err.message : String(err) }
        : (result ?? {});
    const st = this.#session(job.sessionId);
    st.running = Math.max(0, st.running - 1);
    this.#recordAudit(job);
    // The human-facing completion signal: the notice IS the job's tool
    // outcome, delivered as the INVERSE of its detach — a synthetic call
    // (the original call's name + arguments) paired to the call's TRUE
    // result. The client's standard pairing renders the real tool
    // component (bash jobs get the bash chunk), and the model sees a
    // well-formed tool round. No user-message parsing anywhere.
    this.#preludeView.pushResult(job.sessionId, {
      kind: "background jobs",
      // The body is just the completion signal; the exit code and TRUE
      // total runtime live in the paired result (the client's bash chunk
      // header already renders both) — repeating them here duplicated the
      // result and quoted background-only time.
      body: `job ${job.id} finished`,
      tool: job.tool,
      argsJson: job.argsJson,
      result: job.result,
      exemptFromClamp: true,
    });
    this.#emitJobEvent(job.sessionId, jobSettledEvent(job));
    this.#markPending(job);
    void this.#maybeDeliver(job.sessionId);
  }

  /** Publish one job-lifecycle envelope on the session's stream channel.
   *  Best effort by contract: the sink (the bus) never throws; a hostile
   *  fake's throw is the caller's bug, not a drawer concern. */
  #emitJobEvent(
    sessionId: string,
    envelope: { type: string; data: Record<string, unknown> },
  ): void {
    this.#deps.jobEvents?.(sessionId, envelope);
  }

  #recordAudit(job: BackgroundJob): void {
    const { recordSettled } = this.#deps;
    if (recordSettled === undefined) return;
    void auditRecord(job, () => this.#sched.now(), recordSettled).catch(() => undefined);
  }

  /**
   * Queue a settled job for delivery (once), and make sure someone wakes
   * the delivery when the session's tail settles: the orchestrator's
   * `onIdle` fires when the tail settles with no newer turn chained, which
   * covers jobs that settle while a foreign turn (or the wake turn itself)
   * is live.
   */
  #markPending(job: BackgroundJob): void {
    if (job.delivered) return;
    const st = this.#session(job.sessionId);
    if (!st.pending.includes(job.id)) st.pending.push(job.id);
    this.#subscribeIdle(job.sessionId);
  }

  /** Subscribe the tail-settles delivery (one live subscription/session). */
  #subscribeIdle(sessionId: string): void {
    if (this.#idleSubs.has(sessionId)) return;
    const orch = this.#orch;
    if (orch?.onIdle === undefined) return;
    const unsub = orch.onIdle(sessionId, () => {
      this.#idleSubs.delete(sessionId);
      void this.#maybeDeliver(sessionId);
    });
    this.#idleSubs.set(sessionId, unsub);
  }

  /**
   * Deliver pending jobs when the session is idle: one wake turn, one
   * shared prompt, capped at `maxJobsPerWake` jobs (the overflow stays
   * pending and rides the next wake). Busy sessions keep their pending
   * set (rides the next wake or the tail-settles callback).
   */
  async #maybeDeliver(sessionId: string): Promise<void> {
    const st = this.#session(sessionId);
    const orch = this.#orch;
    if (st.pending.length === 0 || orch === undefined) return;
    if (orch.isBusy?.(sessionId) === true) return;
    const jobs = collectPending((id) => this.#jobs.get(id), st.pending);
    if (jobs.length === 0) return;
    // Context-window guard: cap the BATCH of jobs a wake turn delivers.
    // Each job carries its already-truncated streams (up to ~50k serialized
    // chars), so an unbounded batch multiplies that budget: 203 detached
    // jobs once produced a 3.2 MB prompt (turn 635, session fe74e3b7) and a
    // guaranteed 400 from the provider. The cap slices BEFORE the prompt
    // is built (the header must count the delivered slice, not the queue);
    // the overflow stays pending and rides the next wake turn.
    const slice = sliceToWakeCap(jobs, st.pending, this.#opts.maxJobsPerWake);
    st.pending = slice.pending;
    const deliverable = slice.delivered;
    const prompt = buildWakePrompt(deliverable, this.#opts.toolOutputLimit);
    if (prompt === undefined) return;
    for (const job of deliverable) job.delivered = true;
    // Rung resets only when the queue clears; otherwise the rung holds.
    if (queueCleared([...this.#jobs.values()], sessionId)) this.#resetRung(sessionId);
    await this.#runWakeTurn(sessionId, orch, prompt);
    // A deferred overflow rides the same hot-loop guard: the ladder timer
    // re-arms at the current rung and delivers the next slice.
    this.#armLadder(sessionId);
  }

  /** Reset the rung to 0 and drop the ladder timer (queue cleared). */
  #resetRung(sessionId: string): void {
    this.#session(sessionId).rung = 0;
    this.#cancelLadder(sessionId);
  }

  /** Cancel the session's ladder timer, if one is armed. */
  #cancelLadder(sessionId: string): void {
    const st = this.#session(sessionId);
    if (st.ladderTimer === undefined) return;
    this.#sched.cancel(st.ladderTimer);
    st.ladderTimer = undefined;
  }

  /** Fire one wake turn (ordinary turn: own row, events, SSE, revive). */
  async #runWakeTurn(sessionId: string, orch: OrchestratorLike, prompt: string): Promise<void> {
    const lookedUp = await this.#deps.modelFor?.(sessionId);
    const model = lookedUp ?? this.#opts.modelId;
    // The `wake` marker rides the turn row: the transcript summary carries
    // it (turnSummaryRow), so a client can style the wake prompt row as
    // harness-internal instead of user-typed.
    const handle = orch.runTurn(sessionId, { prompt, model, revive: true, wake: true });
    void handle.promise.catch(() => undefined);
  }

  /** Arm the ladder timer at the current rung (never two at once). */
  #armLadder(sessionId: string): void {
    const st = this.#session(sessionId);
    const live = [...this.#jobs.values()].some((j) => j.sessionId === sessionId && !j.delivered);
    if (!live || st.ladderTimer !== undefined) return;
    const ms = rungDelayMs(this.#opts.wakeLadderMs, st.rung);
    st.ladderTimer = this.#sched.after(ms, () => {
      st.ladderTimer = undefined;
      this.#onWake(sessionId);
    });
  }

  /** A wake fired: advance the rung when nothing settled, then deliver. */
  #onWake(sessionId: string): void {
    const st = this.#session(sessionId);
    if (st.pending.length === 0) {
      // Nothing finished since the last wake: advance toward the ceiling.
      st.rung = advanceRung(this.#opts.wakeLadderMs, st.rung);
    }
    void this.#maybeDeliver(sessionId);
    // Keep waking at the (possibly advanced) rung while jobs are live —
    // a hung job occupies its slot and the ladder tops out at the ceiling.
    this.#armLadder(sessionId);
  }
}

/** The audit row one settled job produces (shape per ToolCallRecord). */
function auditRecord(
  job: BackgroundJob,
  now: () => number,
  record: (rec: {
    name: string;
    parameters?: unknown;
    result?: unknown;
    error?: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
    sessionId: string;
  }) => Promise<void>,
): Promise<void> {
  const endedAt = job.endedAt ?? now();
  return record({
    name: job.tool,
    parameters: job.argsJson ?? undefined,
    result: job.result,
    error: typeof job.result?.error === "string" ? job.result.error : undefined,
    startedAt: job.startedAt,
    completedAt: endedAt,
    durationMs: Math.max(0, endedAt - job.startedAt),
    sessionId: job.sessionId,
  });
}
