import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkerClient,
  decodeFrame,
  encodeFrame,
  type BashRunOk,
  type WorkerResponse,
} from "../src/worker/index.ts";

const clients = new Set<WorkerClient>();

async function startWorker(): Promise<WorkerClient> {
  const client = await WorkerClient.start();
  clients.add(client);
  return client;
}

afterAll(async () => {
  await Promise.all([...clients].map((c) => c.close().catch(() => {})));
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Narrow a WorkerResponse to the success variant for field access. */
function expectOk(r: WorkerResponse): asserts r is BashRunOk {
  if (!r.ok) throw new Error("expected worker success");
}

describe("protocol framing", () => {
  it("encodeFrame produces one JSONL line", () => {
    expect(encodeFrame(7, { type: "bash.run", script: "echo hi" })).toBe(
      '{"id":7,"payload":{"type":"bash.run","script":"echo hi"}}\n',
    );
  });

  it("decodeFrame round-trips", () => {
    const line = encodeFrame(3, { ok: true, stdout: "x", stderr: "", exitCode: 0 });
    const frame = decodeFrame(line);
    expect(frame).toEqual({
      id: 3,
      payload: { ok: true, stdout: "x", stderr: "", exitCode: 0 },
    });
  });

  it("decodeFrame ignores blank lines", () => {
    expect(decodeFrame("  \n")).toBeUndefined();
  });

  it("decodeFrame throws on malformed JSON", () => {
    expect(() => decodeFrame("{not json\n")).toThrow(/malformed worker frame/);
  });
});

describe("WorkerClient", () => {
  it("runs a script and returns stdout", async () => {
    const client = await startWorker();
    const r = await client.runBash("printf hello");
    expectOk(r);
    expect(r.stdout).toBe("hello");
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
  });

  it("captures stderr separately", async () => {
    const client = await startWorker();
    const r = await client.runBash("echo oops >&2");
    expectOk(r);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("oops\n");
    expect(r.exitCode).toBe(0);
  });

  it("reports a failing script's exit code", async () => {
    const client = await startWorker();
    const r = await client.runBash("exit 7");
    expectOk(r);
    expect(r.exitCode).toBe(7);
  });

  it("persists cwd, exported vars, and functions across calls", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yog-worker-state-"));
    const client = await startWorker();
    try {
      const r1 = await client.runBash(
        "cd /tmp && export FOO=bar && myfn() { echo fn-ok; }",
        stateDir,
      );
      expectOk(r1);
      expect(r1.exitCode).toBe(0);

      const r2 = await client.runBash('printf "%s|%s|" "$PWD" "$FOO"; myfn', stateDir);
      expectOk(r2);
      expect(r2.stdout).toBe("/tmp|bar|fn-ok\n");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("correlates concurrent responses by id", async () => {
    const client = await startWorker();
    const jobs = Array.from({ length: 8 }, (_, i) => client.runBash(`echo job-${i}`));
    const results = await Promise.all(jobs);
    results.forEach((r, i) => {
      expectOk(r);
      expect(r.stdout.trim()).toBe(`job-${i}`);
    });
  });

  it("close() kills a running bash child promptly", async () => {
    const client = await startWorker();
    const pending = client.runBash("sleep 30");
    // Attach the rejection handler before close() rejects it, so the
    // rejection has a handler from the start.
    const pendingResult = expect(pending).rejects.toThrow(/worker closed/);
    await sleep(250);
    const t0 = Date.now();
    await client.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    await pendingResult;
  });

  it("runBash after close rejects", async () => {
    const client = await startWorker();
    await client.close();
    await expect(client.runBash("echo x")).rejects.toThrow(/worker closed/);
  });

  it("falls back to the harness user when dropping to the agent is not possible", async () => {
    const prevUid = process.env["YOG_AGENT_UID"];
    const prevGid = process.env["YOG_AGENT_GID"];
    process.env["YOG_AGENT_UID"] = String(process.getuid?.() ?? 0 + 1);
    process.env["YOG_AGENT_GID"] = String(process.getgid?.() ?? 0 + 1);
    try {
      // No CAP_SETUID here (tests run unprivileged), so the privileged spawn
      // should fail and the worker should come up as the harness user anyway.
      const client = await startWorker();
      const r = await client.runBash("echo ok");
      expectOk(r);
      expect(r.stdout).toBe("ok\n");
    } finally {
      if (prevUid === undefined) delete process.env["YOG_AGENT_UID"];
      else process.env["YOG_AGENT_UID"] = prevUid;
      if (prevGid === undefined) delete process.env["YOG_AGENT_GID"];
      else process.env["YOG_AGENT_GID"] = prevGid;
    }
  });

  it("restores a prior snapshot before running", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yog-worker-restore-"));
    const client = await startWorker();
    try {
      const r = await client.runBash('printf "%s|%s|" "$PWD" "$FOO"; myfn', stateDir, {
        cwd: "/tmp",
        env: "export FOO=bar\n",
        functions: "myfn() { echo fn-ok; }\n",
      });
      expectOk(r);
      expect(r.stdout).toBe("/tmp|bar|fn-ok\n");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("WorkerClient abort", () => {
  it("abortBash returns false when the worker is idle", async () => {
    const client = await startWorker();
    await expect(client.abortBash()).resolves.toBe(false);
  });

  it("kills a running bash child promptly and snapshots shell state", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "yog-worker-abort-"));
    const client = await startWorker();
    try {
      const pending = client.runBash("cd /tmp && export ABORTED_VAR=yes && sleep 30", stateDir);
      // The child exists as soon as the wrapper is up; under parallel test
      // load that can take longer than a fixed sleep, so poll for it.
      const t0 = Date.now();
      let aborted = false;
      while (Date.now() - t0 < 5000) {
        if (await client.abortBash()) {
          aborted = true;
          break;
        }
        await sleep(100);
      }
      expect(aborted).toBe(true);
      // The child dies quickly: the pending run settles well under its 30s.
      const r = await Promise.race([pending, sleep(3000).then(() => null)]);
      expect(r).not.toBeNull();
      expect(r!.ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(5000);

      // The wrapper's EXIT trap captured cwd/env before the child died.
      const next = await client.runBash('printf "%s|%s" "$PWD" "$ABORTED_VAR"', stateDir);
      expectOk(next);
      expect(next.stdout).toBe("/tmp|yes");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
      await client.close();
    }
  });
});
