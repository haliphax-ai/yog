import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerPool } from "../../src/server/workpool.ts";
import { shutdownAllWorkers, type BashRunOk, type WorkerResponse } from "../../src/worker/index.ts";

/** Narrow a WorkerResponse to the success variant for field access. */
function expectOk(r: WorkerResponse): asserts r is BashRunOk {
  if (!r.ok) throw new Error(`expected worker success: ${JSON.stringify(r)}`);
}

const stateDirs: string[] = [];
const pools: WorkerPool[] = [];

/** Create a pool and register it for teardown. */
function pool(options?: { size?: number }): WorkerPool {
  const p = new WorkerPool(options);
  pools.push(p);
  return p;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close().catch(() => {})));
  await shutdownAllWorkers();
  await Promise.all(stateDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("WorkerPool sizing", () => {
  it("defaults to the floor max(1, os.cpus().length - 1)", () => {
    const p = pool();
    expect(p.size).toBe(Math.max(1, cpus().length - 1));
  });

  it("honours an injected size and never drops below 1", () => {
    expect(pool({ size: 3 }).size).toBe(3);
    expect(pool({ size: 0 }).size).toBe(1);
    expect(pool({ size: -7 }).size).toBe(1);
  });
});

describe("WorkerPool execution", () => {
  it("runs a simple script through the underlying worker", async () => {
    const p = pool({ size: 1 });
    const r = await p.run("sess-exec", "echo hi", {});
    expectOk(r);
    expect(r.stdout.trim()).toBe("hi");
  }, 30000);
});

describe("WorkerPool soft pinning", () => {
  it("serves a session from one member unless busy and stays correct across reassignment", async () => {
    const p = pool({ size: 2 });
    const stateDir = await mkdtemp(join(tmpdir(), "yog-workpool-"));
    stateDirs.push(stateDir);

    // First run pins the session to a member and captures its snapshot.
    const first = await p.run("sess-pin", 'export YOG_PIN=kept; printf %s "$YOG_PIN"', {
      stateDir,
    });
    expectOk(first);
    expect(first.stdout).toBe("kept");
    const pinned = p.memberFor("sess-pin");
    expect(pinned).toBeDefined();

    // While the pinned member is busy with another session, the session is
    // served by a different member — but the restored snapshot keeps the
    // shell state correct after the reassignment.
    const blocker = p.run("sess-other", "sleep 1", { stateDir: `${stateDir}-other` });
    const second = await p.run("sess-pin", 'printf %s "$YOG_PIN"', {
      stateDir,
      restore: first.state,
    });
    expectOk(second);
    expect(second.stdout).toBe("kept");
    expect(p.memberFor("sess-pin")).not.toBe(pinned);

    // Once the pinned member is free again, the session lands back on it and
    // the state from the reassigned run carries over.
    await blocker;
    const third = await p.run("sess-pin", 'printf %s "$YOG_PIN"', {
      stateDir,
      restore: second.state,
    });
    expectOk(third);
    expect(third.stdout).toBe("kept");
    expect(p.memberFor("sess-pin")).toBe(pinned);
  }, 60000);
});

describe("WorkerPool run keys (bg-jobs prep)", () => {
  it("keeps the default path identical: no runKey keys everything on the session id", async () => {
    const p = pool({ size: 2 });
    const r = await p.run("sess-default", "echo default-ok", {});
    expectOk(r);
    expect(r.stdout.trim()).toBe("default-ok");
    // A session-keyed abort is the only key the run registered.
    await expect(p.abortRun("sess-default")).resolves.toBe(false); // already settled
    await expect(p.abortScript("sess-default")).resolves.toBe(false);
  }, 30000);

  it("rekeyRun retargets a live run so the session key can no longer abort it", async () => {
    const p = pool({ size: 2 });
    const stateDir = await mkdtemp(join(tmpdir(), "yog-workpool-key-"));
    stateDirs.push(stateDir);
    const slow = p.run("sess-rekey", "sleep 2.5", { stateDir });
    // Wait until the run is registered under the session key.
    await vi.waitFor(async () => {
      await expect(p.abortScript("sess-rekey")).resolves.toBe(true);
    });
    // Detach: retarget to the job key; the session key goes dead.
    expect(p.rekeyRun("sess-rekey", "bg:job-1")).toBe(true);
    expect(p.rekeyRun("sess-rekey", "bg:job-2")).toBe(false); // nothing left there
    await expect(p.abortScript("sess-rekey")).resolves.toBe(false);
    // The job key hits the same worker: the kill lands (the run settles).
    await expect(p.abortRun("bg:job-1")).resolves.toBe(true);
    const r = await slow;
    expectOk(r);
    // After the run settles, the job key is gone too.
    await expect(p.abortRun("bg:job-1")).resolves.toBe(false);
  }, 30000);

  it("abortRun addresses the right member when two runs are live on different members", async () => {
    const p = pool({ size: 2 });
    const stateDir = await mkdtemp(join(tmpdir(), "yog-workpool-two-"));
    stateDirs.push(stateDir);
    // Two long runs pinned to different members (the first pins member 0,
    // the second finds it busy and takes member 1).
    const a = p.run("sess-a", "sleep 2.5", { stateDir });
    const b = p.run("sess-b", "sleep 2.5", { stateDir });
    await vi.waitFor(async () => {
      await expect(p.abortScript("sess-a")).resolves.toBe(true);
      await expect(p.abortScript("sess-b")).resolves.toBe(true);
    });
    expect(p.memberFor("sess-a")).not.toBe(p.memberFor("sess-b"));
    // Killing key B leaves A alive; then killing A settles both.
    await expect(p.abortRun("sess-b")).resolves.toBe(true);
    const rb = await b;
    expectOk(rb);
    await expect(p.abortRun("sess-a")).resolves.toBe(true);
    const ra = await a;
    expectOk(ra);
  }, 30000);
});
