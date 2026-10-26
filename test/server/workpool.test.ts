import { afterAll, describe, expect, it } from "vitest";
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

  it("honours the YOG_WORKERS override and never drops below 1", () => {
    const prev = process.env["YOG_WORKERS"];
    try {
      process.env["YOG_WORKERS"] = "3";
      expect(pool().size).toBe(3);

      process.env["YOG_WORKERS"] = "0";
      expect(pool().size).toBe(1);

      process.env["YOG_WORKERS"] = "-7";
      expect(pool().size).toBe(1);
    } finally {
      if (prev === undefined) delete process.env["YOG_WORKERS"];
      else process.env["YOG_WORKERS"] = prev;
    }
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
