/**
 * JobManager (yog#91) — fake-clock tests over the injected boundaries.
 *
 * The fake Scheduler drives the ladder/cap deterministically; the fake
 * orchestrator answers `isBusy` from a test-controlled flag and records
 * wake turns; the fake pool records rekeys/aborts/pids. Every ladder rule
 * in the slice spec is pinned here.
 */
import { describe, expect, it } from "vitest";
import { sendMessage } from "../messages-helper.ts";
import { JobManager } from "../../src/server/jobs/index.ts";
import type {
  JobManagerDeps,
  JobManagerOptions,
  SchedulerLike,
} from "../../src/server/jobs/index.ts";
import type { ToolResult } from "../../src/toolkit/index.ts";

/** Minimal handle shape the SchedulerLike contract returns. */
function fakeHandle(): { active: boolean; dueAt: number } {
  return { active: true, dueAt: 0 };
}

/** Deterministic clock + timer fake: time moves only when `advance` runs. */
function fakeScheduler() {
  let now = 1_000_000;
  interface Pending {
    dueAt: number;
    fn: () => void;
    canceled: boolean;
    handle: { active: boolean; dueAt: number };
  }
  const pending: Pending[] = [];
  const scheduler: SchedulerLike = {
    after(ms, fn) {
      const rec: Pending = { dueAt: now + ms, fn, canceled: false, handle: fakeHandle() };
      pending.push(rec);
      return rec.handle;
    },
    cancel(handle) {
      const rec = pending.find((p) => p.handle === handle);
      if (rec) rec.canceled = true;
    },
    now: () => now,
  };
  return {
    scheduler,
    get now() {
      return now;
    },
    /** Run every timer due at `to`; returns how many fired. */
    advance(to: number): number {
      let fired = 0;
      for (;;) {
        const next = pending
          .filter((p) => !p.canceled && p.dueAt <= to)
          .sort((a, b) => a.dueAt - b.dueAt)[0];
        if (next === undefined) break;
        next.canceled = true;
        now = Math.max(now, next.dueAt);
        fired += 1;
        next.fn();
      }
      now = Math.max(now, to);
      return fired;
    },
    /** Pending (not canceled) timer count. */
    get pendingCount(): number {
      return pending.filter((p) => !p.canceled).length;
    },
  };
}

/** Fake orchestrator: busy flag + recorded wake turns + idle callbacks. */
function fakeOrchestrator() {
  const wakes: Array<{ sessionId: string; prompt: string; model?: string; revive?: boolean }> = [];
  const idleCbs = new Map<string, Set<() => void>>();
  let busy = false;
  return {
    wakes,
    get busy() {
      return busy;
    },
    setBusy(v: boolean) {
      busy = v;
    },
    orchestrator: {
      isBusy: () => busy,
      onIdle: (_sid: string, cb: () => void) => {
        let set = idleCbs.get(_sid);
        if (set === undefined) {
          set = new Set();
          idleCbs.set(_sid, set);
        }
        set.add(cb);
        return () => set!.delete(cb);
      },
      runTurn(sessionId: string, req: Record<string, unknown>) {
        wakes.push({
          sessionId,
          prompt: String(req.prompt ?? ""),
          model: typeof req.model === "string" ? req.model : undefined,
          revive: req.revive === true,
        });
        return { promise: Promise.resolve({ ok: true }), abort: () => undefined };
      },
    },
    /** Fire the idle callbacks for a session (the tail settled). */
    fireIdle(sessionId: string) {
      for (const cb of idleCbs.get(sessionId) ?? []) cb();
    },
    get hasIdleSub() {
      return idleCbs.size > 0;
    },
  };
}

/** Fake pool: rekeys, aborts, pids — all recorded. */
function fakePool() {
  const rekeys: Array<[string, string]> = [];
  const aborts: string[] = [];
  return {
    rekeys,
    aborts,
    pool: {
      rekeyRun: (oldKey: string, newKey: string) => {
        rekeys.push([oldKey, newKey]);
        return true;
      },
      abortRun: (key: string) => {
        aborts.push(key);
        return Promise.resolve(true);
      },
      runPid: () => Promise.resolve({ pid: 4242, pgid: 4242 }),
    },
  };
}

/** Default options: short ladder for tests. */
function opts(over: Partial<JobManagerOptions> = {}): JobManagerOptions {
  return {
    detachMs: 100,
    maxJobsPerSession: 2,
    wakeLadderMs: [10, 20, 30],
    jobMaxMs: 1_000,
    toolOutputLimit: 500,
    modelId: "test-model",
    ...over,
  };
}

/** Build a manager wired to the fakes; returns the test handles. */
function build(over: { opts?: Partial<JobManagerOptions>; deps?: Partial<JobManagerDeps> } = {}) {
  const clock = fakeScheduler();
  const orch = fakeOrchestrator();
  const pool = fakePool();
  const audits: unknown[] = [];
  const preludes: Array<{ sessionId: string; kind: string; body: string }> = [];
  const preludeSink = (() => {
    const queued = new Map<string, Array<{ kind: string; body: string }>>();
    return {
      push(sessionId: string, kind: string, body: string) {
        preludes.push({ sessionId, kind, body });
        let q = queued.get(sessionId);
        if (q === undefined) {
          q = [];
          queued.set(sessionId, q);
        }
        q.push({ kind, body });
      },
      drain(sessionId: string) {
        const q = queued.get(sessionId);
        queued.delete(sessionId);
        return q;
      },
      clear(sessionId: string) {
        queued.delete(sessionId);
        preludes.length = 0;
      },
    };
  })();
  const deps: JobManagerDeps = {
    pool: pool.pool,
    orchestrator: orch.orchestrator,
    scheduler: clock.scheduler,
    recordSettled: async (rec) => {
      audits.push(rec);
    },
    prelude: preludeSink,
    modelFor: async () => "last-model",
    ...over.deps,
  };
  const manager = new JobManager(opts(over.opts), deps);
  return { manager, clock, orch, pool, audits, preludes };
}

/**
 * A deferred ToolResult the test resolves at will: the promise handed to
 * the policy as `DetachCall.result` — the same retained promise the
 * registry passes at detach.
 */
function deferred(): {
  promise: Promise<ToolResult>;
  resolve: (r: ToolResult) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (r: ToolResult) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<ToolResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Settle a job by resolving its deferred (then let microtasks run). */
async function settleJob(
  jobId: string,
  d: ReturnType<typeof deferred>,
  result: ToolResult,
): Promise<void> {
  d.resolve(result);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  void jobId;
}

/** The manager's private policy consult (the registry's exact seam). */
async function consultThreshold(
  manager: JobManager,
  call: {
    sessionId?: string;
    tool: string;
    argsJson: string | null;
    result: Promise<ToolResult>;
  },
): Promise<{ kind: string; jobId?: string; reason?: string }> {
  // Reach the armed module policy through the toolkit seam: the manager
  // arms it on wire(); read it back with the public getter.
  const { toolDetachPolicy } = await import("../../src/toolkit/index.ts");
  const policy = toolDetachPolicy();
  expect(policy).toBeDefined();
  return (await policy!.onThreshold(call)) as { kind: string; jobId?: string };
}

describe("JobManager (fake clock)", () => {
  it("detaches at the threshold: job row, pool rekey, pid stamp, ladder armed", async () => {
    const { manager, clock, orch, pool } = build();
    manager.wire();
    const ret = deferred();
    const verdict = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: '{"command":"sleep 30"}',
      result: ret.promise,
    })) as { kind: string; jobId: string };

    expect(verdict.kind).toBe("detach");
    const job = manager.job(verdict.jobId!);
    expect(job).toBeDefined();
    expect(job!.sessionId).toBe("s1");
    expect(job!.state).toBe("running");
    // Pool run retargeted: session key dropped for bg:<jobId>.
    expect(pool.rekeys).toEqual([["s1", `bg:${verdict.jobId}`]]);
    // The ladder is armed at rung 0 (10ms away on the fake clock).
    expect(clock.pendingCount).toBeGreaterThan(0);
    void orch;
  });

  it("slot exhaustion terminates the call immediately (no job row)", async () => {
    const { manager } = build({ opts: { maxJobsPerSession: 1 } });
    manager.wire();
    const ret = deferred();
    const first = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };
    expect(first.kind).toBe("detach");

    const second = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; reason: string };
    expect(second.kind).toBe("terminate");
    expect(second.reason).toContain("slot");
  });

  it("cap termination: bgJobMaxMs settles the job as terminated: max runtime", async () => {
    const { manager, clock, orch } = build({ opts: { jobMaxMs: 1_000 } });
    manager.wire();
    orch.setBusy(true); // keep the wake pending so we can inspect the job row
    const ret = deferred();
    const verdict = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };

    clock.advance(clock.now + 1_000); // cap fires
    const job = manager.job(verdict.jobId!);
    expect(job!.state).toBe("terminated");
    expect(job!.termReason).toBe("max runtime");
  });

  it("ladder: advance on empty wake, hold on delivery, reset only on queue clear", async () => {
    const { manager, clock, orch } = build({ opts: { wakeLadderMs: [10, 20, 30] } });
    manager.wire();
    orch.setBusy(true);
    const ret = deferred();
    const v = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };

    // Wake 1 fires with nothing finished: rung advances 0 → 1.
    clock.advance(clock.now + 10);
    expect(orch.wakes).toHaveLength(0);
    // Wake 2 fires with nothing finished: rung advances 1 → 2 (ceiling here).
    clock.advance(clock.now + 20);
    expect(orch.wakes).toHaveLength(0);

    // The job settles while a foreign turn is live → marked pending.
    const result: ToolResult = { stdout: "done", exitCode: 0 };
    await settleJob(v.jobId!, ret, result);
    expect(manager.job(v.jobId!)!.state).toBe("finished");

    // The session goes idle: the tail-settles callback delivers at once.
    orch.setBusy(false);
    orch.fireIdle("s1");
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.wakes).toHaveLength(1);
    expect(orch.wakes[0]!.sessionId).toBe("s1");
    expect(orch.wakes[0]!.prompt).toContain("background jobs");
    expect(orch.wakes[0]!.prompt).toContain(v.jobId!);
    expect(orch.wakes[0]!.revive).toBe(true);
    expect(orch.wakes[0]!.model).toBe("last-model");
  });

  it("batching: two jobs settle during a foreign turn → one shared wake prompt", async () => {
    const { manager, orch } = build();
    manager.wire();
    orch.setBusy(true);
    const ret = deferred();
    const a = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: '{"n":1}',
      result: ret.promise,
    })) as { kind: string; jobId: string };
    const b = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: '{"n":2}',
      result: ret.promise,
    })) as { kind: string; jobId: string };

    await settleJob(a.jobId!, ret, { stdout: "A", exitCode: 0 });
    await settleJob(b.jobId!, ret, { stdout: "B", exitCode: 0 });

    orch.setBusy(false);
    orch.fireIdle("s1");
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.wakes).toHaveLength(1);
    expect(orch.wakes[0]!.prompt).toContain(a.jobId!);
    expect(orch.wakes[0]!.prompt).toContain(b.jobId!);
    expect(orch.wakes[0]!.prompt).toContain("2 finished");
  });

  it("wake prompt truncates per-job streams against the tool-output budget", async () => {
    const { manager, orch } = build({ opts: { toolOutputLimit: 64 } });
    manager.wire();
    orch.setBusy(true);
    const ret = deferred();
    const v = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };
    await settleJob(v.jobId!, ret, {
      stdout: "x".repeat(500),
      stderr: "y".repeat(500),
      exitCode: 0,
    });
    orch.setBusy(false);
    orch.fireIdle("s1");
    await Promise.resolve();
    await Promise.resolve();
    const prompt = orch.wakes[0]!.prompt;
    expect(prompt).toContain("TRUNCATED");
    expect(prompt.length).toBeLessThan(2_000);
  });

  it("idle abort: jobs terminated, timers wiped, prelude queued, no wake turn", async () => {
    const { manager, clock, orch, pool, preludes } = build();
    manager.wire();
    orch.setBusy(true);
    const ret = deferred();
    const v = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };

    const count = manager.abortSessionJobs("s1");
    expect(count).toBe(1);
    const job = manager.job(v.jobId!);
    expect(job!.state).toBe("terminated");
    expect(job!.termReason).toBe("operator abort");
    // Job-keyed kill (the rekeyed run), never the session key.
    expect(pool.aborts).toContain(`bg:${v.jobId}`);
    // Timers wiped: only the cap timer remains canceled; no ladder pending.
    clock.advance(clock.now + 100_000);
    expect(orch.wakes).toHaveLength(0);
    // Prelude queued, no wake.
    expect(preludes).toEqual([
      { sessionId: "s1", kind: "background-jobs", body: `background jobs terminated: ${v.jobId}` },
    ]);
  });

  it("settled-but-undelivered jobs die silently on idle abort (no wake either)", async () => {
    const { manager, orch, preludes } = build();
    manager.wire();
    orch.setBusy(true);
    const ret = deferred();
    const v = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };
    await settleJob(v.jobId!, ret, { stdout: "late", exitCode: 0 });
    expect(manager.job(v.jobId!)!.state).toBe("finished");

    const count = manager.abortSessionJobs("s1");
    expect(count).toBe(1);
    expect(manager.job(v.jobId!)!.termReason).toBe("operator abort");
    orch.setBusy(false);
    orch.fireIdle("s1");
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.wakes).toHaveLength(0);
    expect(preludes).toHaveLength(1);
  });

  it("audit row per settled job (completion forensics)", async () => {
    const { manager, orch, audits } = build();
    manager.wire();
    orch.setBusy(true);
    const ret = deferred();
    const v = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: '{"command":"x"}',
      result: ret.promise,
    })) as { kind: string; jobId: string };
    await settleJob(v.jobId!, ret, { stdout: "out", exitCode: 0 });
    expect(audits).toHaveLength(1);
    const rec = audits[0] as { name: string; sessionId: string; result: unknown };
    expect(rec.name).toBe("bash");
    expect(rec.sessionId).toBe("s1");
    expect(rec.result).toEqual({ stdout: "out", exitCode: 0 });
  });

  it("purge: kills + drops records + clears preludes", async () => {
    const { manager, orch, pool, preludes } = build();
    manager.wire();
    orch.setBusy(true);
    const ret = deferred();
    const v = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };
    manager.purgeSession("s1");
    expect(pool.aborts).toContain(`bg:${v.jobId}`);
    expect(manager.job(v.jobId!)).toBeUndefined();
    expect(preludes).toHaveLength(0);
    // Delivering after a purge must not resurrect anything.
    orch.setBusy(false);
    orch.fireIdle("s1");
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.wakes).toHaveLength(0);
  });

  it("immediate delivery: a job settling while the session is idle wakes at once", async () => {
    const { manager, orch } = build();
    manager.wire();
    const ret = deferred();
    const v = (await consultThreshold(manager, {
      sessionId: "s1",
      tool: "bash",
      argsJson: null,
      result: ret.promise,
    })) as { kind: string; jobId: string };
    await settleJob(v.jobId!, ret, { stdout: "quick", exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(orch.wakes).toHaveLength(1);
    expect(orch.wakes[0]!.prompt).toContain(v.jobId!);
  });
});

describe("jobs.get message (adapter surface)", () => {
  it("lists a session's jobs and returns one job's detail; unknown id → unknown_job", async () => {
    const { manager, orch } = build();
    manager.wire();
    const { createHttpServer } = await import("../../src/server/http/index.ts");
    const { EventEmitter } = await import("node:events");
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    const server = createHttpServer({
      orchestrator: orch.orchestrator,
      bus,
      jobs: manager,
      capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`;

    // The messages channel resolves the session first (404 otherwise):
    // create the sessions the test addresses and capture their ids.
    const mk = async (): Promise<string> => {
      const res = await fetch(`${base}/v1/sessions`, { method: "POST", body: "{}" });
      return ((await res.json()) as any).session.id as string;
    };
    const sid1 = await mk();
    const sid2 = await mk();
    // No jobs yet → empty list (still 200).
    const empty = await sendMessage(base, sid1, "jobs.get");
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as any).data.jobs).toEqual([]);

    // Register two jobs (busy session → no delivery race).
    orch.setBusy(true);
    const a = deferred();
    const b = deferred();
    const va = (await consultThreshold(manager, {
      sessionId: sid1,
      tool: "bash",
      argsJson: '{"n":1}',
      result: a.promise,
    })) as { kind: string; jobId: string };
    const vb = (await consultThreshold(manager, {
      sessionId: sid2,
      tool: "bash",
      argsJson: '{"n":2}',
      result: b.promise,
    })) as { kind: string; jobId: string };

    // Session-scoped list: sess-1 sees only its own job.
    const list = await sendMessage(base, sid1, "jobs.get");
    const listData = ((await list.json()) as any).data;
    expect(listData.jobs).toHaveLength(1);
    expect(listData.jobs[0].id).toBe(va.jobId);

    // Detail: one job by id, including the running state.
    const detail = await sendMessage(base, sid1, "jobs.get", { jobId: va.jobId });
    const detailData = ((await detail.json()) as any).data;
    expect(detailData.job.id).toBe(va.jobId);
    expect(detailData.job.state).toBe("running");

    // Unknown id → 404 unknown_job.
    const missing = await sendMessage(base, sid1, "jobs.get", { jobId: "bg_nope" });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.code).toBe("unknown_job");

    // A manager-less daemon → 500 internal (mapped, like the skills types).
    const bare = createHttpServer({
      orchestrator: orch.orchestrator,
      bus,
      capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
    });
    await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
    const bareAddr = bare.address();
    const bareBase = `http://127.0.0.1:${bareAddr && typeof bareAddr === "object" ? bareAddr.port : 0}`;
    const bareRes0 = await fetch(`${bareBase}/v1/sessions`, { method: "POST", body: "{}" });
    const bareSid = ((await bareRes0.json()) as any).session.id as string;
    const bareRes = await sendMessage(bareBase, bareSid, "jobs.get");
    expect(bareRes.status).toBe(500);
    expect(((await bareRes.json()) as any).error.code).toBe("internal");
    void vb;

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => bare.close(() => resolve()));
  });

  it("advertises the background-jobs feature + jobs.get when the manager is wired", async () => {
    const { manager, orch } = build();
    manager.wire();
    const { createDaemon } = await import("../../src/server/serve.ts");
    const daemon = await createDaemon({
      port: 0,
      host: "127.0.0.1",
      deps: {
        orchestrator: orch.orchestrator,
        jobs: manager,
        capabilities: {
          contractVersion: "v1",
          models: ["m"],
          tools: ["bash"],
          features: [
            "messages",
            "stream",
            "transcript",
            "abort",
            "rate-limit-retry",
            "background-jobs",
          ],
        },
      } as any,
    });
    const res = await fetch(`${daemon.url}/v1/capabilities`);
    const caps: any = await res.json();
    expect(caps.features).toContain("background-jobs");
    // The dispatch table is transport-owned: jobs.get rides MESSAGE_TYPES.
    expect(caps.messageTypes).toContain("jobs.get");
    // The injected-deps path never composes the manager, so the user-facing
    // projection is empty (presence-in-commands IS availability; the
    // full-daemon test below covers the composed advertisement).
    expect(caps.commands).toEqual([]);
    await daemon.close();
  });

  it("a full daemon advertises the /jobs command (composition-root projection)", async () => {
    // The full composition (no injected deps) builds the real manager, so
    // the /jobs descriptor rides the capabilities advertisement.
    const { createDaemon } = await import("../../src/server/serve.ts");
    const daemon = await createDaemon({
      port: 0,
      host: "127.0.0.1",
      config: { stateRoot: "/tmp/yog-jobs-cli-caps-test" } as any,
    });
    const caps: any = await (await fetch(`${daemon.url}/v1/capabilities`)).json();
    const jobsCmd = (caps.commands as Array<{ name: string; message: string }>).find(
      (c) => c.name === "jobs",
    );
    expect(jobsCmd).toBeDefined();
    expect(jobsCmd!.message).toBe("jobs.get");
    await daemon.close();
  });

  it("a daemon without the manager does not advertise the /jobs command", async () => {
    const { orch } = build();
    const { createDaemon } = await import("../../src/server/serve.ts");
    const daemon = await createDaemon({
      port: 0,
      host: "127.0.0.1",
      deps: {
        orchestrator: orch.orchestrator,
        capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
      } as any,
    });
    const caps: any = await (await fetch(`${daemon.url}/v1/capabilities`)).json();
    expect(caps.commands.find((c: { name: string }) => c.name === "jobs")).toBeUndefined();
    await daemon.close();
  });

  it("a daemon without the manager does not advertise the /jobs command", async () => {
    const { orch } = build();
    const { createDaemon } = await import("../../src/server/serve.ts");
    const daemon = await createDaemon({
      port: 0,
      host: "127.0.0.1",
      deps: {
        orchestrator: orch.orchestrator,
        capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
      } as any,
    });
    const caps: any = await (await fetch(`${daemon.url}/v1/capabilities`)).json();
    expect(caps.commands.find((c: { name: string }) => c.name === "jobs")).toBeUndefined();
    await daemon.close();
  });
});

describe("turn.abort idle path (the backgroundJobs reply field)", () => {
  it("idle abort kills session jobs and reports the additive count", async () => {
    const { manager, orch } = build();
    manager.wire();
    const { createHttpServer } = await import("../../src/server/http/index.ts");
    const { EventEmitter } = await import("node:events");
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    // A no-op killTool boundary (nothing running in the foreground).
    const server = createHttpServer({
      orchestrator: {
        ...orch.orchestrator,
        abortTurn: async () => false,
      },
      bus,
      jobs: manager,
      capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${addr && typeof addr === "object" ? addr.port : 0}`;
    const created = await fetch(`${base}/v1/sessions`, { method: "POST", body: "{}" });
    const sid = ((await created.json()) as any).session.id as string;

    // Two jobs on the session (busy → no delivery race).
    orch.setBusy(true);
    const a = deferred();
    const b = deferred();
    const va = (await consultThreshold(manager, {
      sessionId: sid,
      tool: "bash",
      argsJson: null,
      result: a.promise,
    })) as { kind: string; jobId: string };
    const vb = (await consultThreshold(manager, {
      sessionId: sid,
      tool: "bash",
      argsJson: null,
      result: b.promise,
    })) as { kind: string; jobId: string };

    const res = await sendMessage(base, sid, "turn.abort");
    const body: any = await res.json();
    expect(body.data.status).toBe("idle");
    expect(body.data.aborted.backgroundJobs).toBe(2);
    // No wake turn follows the idle abort (busy flag irrelevant now).
    orch.setBusy(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(orch.wakes).toHaveLength(0);
    // The jobs died with the operator's abort.
    expect(manager.job(va.jobId!)!.termReason).toBe("operator abort");
    expect(manager.job(vb.jobId!)!.termReason).toBe("operator abort");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe("yog jobs agent-CLI command", () => {
  /** Two daemon-wide jobs: one settled, one running (a fake read surface). */
  function fakeJobsManager() {
    const jobs: Array<Record<string, unknown>> = [
      {
        id: "bg_a",
        sessionId: "s1",
        tool: "bash",
        argsJson: null,
        startedAt: 1_000,
        endedAt: 61_000,
        state: "finished" as const,
        result: { stdout: "done", exitCode: 0 },
        pid: 4242,
        delivered: true,
      },
      {
        id: "bg_b",
        sessionId: "s2",
        tool: "bash",
        argsJson: JSON.stringify({ command: "sleep 30" }),
        startedAt: 2_000,
        state: "running" as const,
      },
    ];
    return {
      allJobs: () => jobs,
      job: (id: string) => jobs.find((j) => j.id === id),
    };
  }

  it("lists daemon-wide jobs as rows (running rows carry elapsed, not runtime)", async () => {
    const { jobsCliCommand } = await import("../../src/server/daemon/jobs-cli.ts");
    let now = 62_000;
    const cmd = jobsCliCommand(fakeJobsManager() as never, () => now);
    const out = await cmd.execute([]);
    const rows = out.trimEnd().split("\n");
    expect(rows).toHaveLength(2);
    // Settled row: runtime = end - start. Running row: elapsed = now - start.
    expect(rows[0]).toBe("bg_a s1 bash finished 60s 4242");
    expect(rows[1]).toBe("bg_b s2 bash running 60s -");
    now = 63_000; // the running row's elapsed follows the clock
    expect((await cmd.execute(["list"]))!.trimEnd().split("\n")[1]).toBe(
      "bg_b s2 bash running 61s -",
    );
  });

  it("shows one job's detail with the settled result; unknown id says so", async () => {
    const { jobsCliCommand } = await import("../../src/server/daemon/jobs-cli.ts");
    const cmd = jobsCliCommand(fakeJobsManager() as never, () => 62_000);
    const detail = await cmd.execute(["bg_a"]);
    expect(detail).toContain("job bg_a");
    expect(detail).toContain("session: s1");
    expect(detail).toContain("pid: 4242");
    expect(detail).toContain("result:");
    expect(detail).toContain("done");
    const unknown = await cmd.execute(["bg_nope"]);
    expect(unknown).toContain("unknown job: bg_nope");
  });

  it("renders (none) for an empty daemon", async () => {
    const { jobsCliCommand } = await import("../../src/server/daemon/jobs-cli.ts");
    const cmd = jobsCliCommand({ allJobs: () => [], job: () => undefined } as never);
    expect(await cmd.execute([])).toBe("(none)\n");
  });
});
