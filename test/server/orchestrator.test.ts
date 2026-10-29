import { describe, expect, it } from "vitest";
import { SessionOrchestrator } from "../../src/server/index.ts";
import type { TurnRequest } from "../../src/server/orchestrator.ts";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface TurnRecord {
  sessionId: string;
  prompt: string;
  start: number;
  end: number;
}

/**
 * Fake slow tool/model: records start/end wall-clock times for every turn
 * it executes and then blocks for `ms`. Injected into the orchestrator so
 * we can observe whether turns from different sessions overlap while turns
 * within one session stay strictly ordered.
 */
function makeSlowFakeTurn(ms: number) {
  const records: TurnRecord[] = [];
  const executeTurn = async (sessionId: string, req: TurnRequest) => {
    const rec: TurnRecord = {
      sessionId,
      prompt: String(req.prompt),
      start: Date.now(),
      end: 0,
    };
    records.push(rec);
    await delay(ms);
    rec.end = Date.now();
    return { ok: true, sessionId, prompt: req.prompt };
  };
  return { records, executeTurn };
}

describe("SessionOrchestrator concurrency", () => {
  it("runs turns for two sessions started together with overlapping wall-clock time", async () => {
    const { records, executeTurn } = makeSlowFakeTurn(150);
    const orchestrator = new SessionOrchestrator({ executeTurn });

    // Two sessions started together, each with a slow turn.
    const a = orchestrator.runTurn("session-a", { prompt: "turn a" });
    const b = orchestrator.runTurn("session-b", { prompt: "turn b" });

    expect(typeof a.abort).toBe("function");
    expect(typeof b.abort).toBe("function");

    await Promise.all([a.promise, b.promise]);

    expect(records).toHaveLength(2);
    const [ra, rb] = records as [TurnRecord, TurnRecord];
    expect(ra.sessionId).toBe("session-a");
    expect(rb.sessionId).toBe("session-b");

    // The turns must actually interleave: each turn starts before the
    // other one ends (overlapping wall-clock intervals). If the server
    // serialized sessions, the second turn would only start after the
    // first finished and this would fail.
    const overlap = Math.min(ra.end, rb.end) - Math.max(ra.start, rb.start);
    expect(overlap).toBeGreaterThan(0);

    // Both turns must be in flight at the same moment: the later start
    // happens strictly before the earlier end.
    expect(Math.max(ra.start, rb.start)).toBeLessThan(Math.min(ra.end, rb.end));

    // Total elapsed must be well under the sum of the two delays
    // (2 × 150 ms), proving they ran in parallel, not back-to-back.
    const total = Math.max(ra.end, rb.end) - Math.min(ra.start, rb.start);
    expect(total).toBeLessThan(150 + 150);
  });

  it("keeps a third session independent too (no hidden global lock)", async () => {
    const { records, executeTurn } = makeSlowFakeTurn(100);
    const orchestrator = new SessionOrchestrator({ executeTurn });

    const handles = ["s1", "s2", "s3"].map((id, i) =>
      orchestrator.runTurn(id, { prompt: `turn ${i}` }),
    );
    await Promise.all(handles.map((h) => h.promise));

    expect(records).toHaveLength(3);
    // All three must have started before any of them finished.
    const lastStart = Math.max(...records.map((r) => r.start));
    const firstEnd = Math.min(...records.map((r) => r.end));
    expect(lastStart).toBeLessThan(firstEnd);
  });
});

describe("SessionOrchestrator per-session FIFO", () => {
  it("runs two turns on the same session in submission order", async () => {
    const records: TurnRecord[] = [];
    // Deliberately make the FIRST turn slow and the SECOND fast: if the
    // orchestrator is a proper FIFO queue, submission order wins anyway.
    const executeTurn = async (sessionId: string, req: TurnRequest) => {
      const rec: TurnRecord = {
        sessionId,
        prompt: String(req.prompt),
        start: Date.now(),
        end: 0,
      };
      records.push(rec);
      await delay(req.prompt === "first" ? 150 : 10);
      rec.end = Date.now();
      return { ok: true };
    };
    const orchestrator = new SessionOrchestrator({ executeTurn });

    const first = orchestrator.runTurn("same-session", { prompt: "first" });
    const second = orchestrator.runTurn("same-session", { prompt: "second" });

    await Promise.all([first.promise, second.promise]);

    expect(records).toHaveLength(2);
    const [r1, r2] = records as [TurnRecord, TurnRecord];

    // Submission order preserved: "first" starts before "second".
    expect(r1.prompt).toBe("first");
    expect(r2.prompt).toBe("second");
    expect(r1.start).toBeLessThanOrEqual(r2.start);

    // Strict FIFO: within a session the second turn must not start until
    // the first one has finished (no intra-session overlap).
    expect(r2.start).toBeGreaterThanOrEqual(r1.end);

    // And the completion order matches submission order too.
    expect(r1.end).toBeLessThanOrEqual(r2.end);
  });
});

describe("SessionOrchestrator abortTurn", () => {
  it("aborts an in-flight turn and signals executeTurn", async () => {
    let sawSignal = false;
    const executeTurn = async (
      _sessionId: string,
      _req: TurnRequest,
      ctx?: { signal?: AbortSignal },
    ) => {
      await new Promise<void>((resolve) => {
        ctx?.signal?.addEventListener("abort", () => {
          sawSignal = true;
          resolve();
        });
        setTimeout(resolve, 5000);
      });
      return { ok: true };
    };
    const orchestrator = new SessionOrchestrator({ executeTurn });

    const handle = orchestrator.runTurn("abort-me", { prompt: "slow" });
    await delay(20); // let the turn start
    const aborted = await orchestrator.abortTurn("abort-me");

    expect(aborted).toBe(true);
    expect(sawSignal).toBe(true);
    await expect(handle.promise).rejects.toThrow(/abort/);
  });

  it("returns false when the session has no live turn", async () => {
    const orchestrator = new SessionOrchestrator({ executeTurn: async () => ({}) });
    await expect(orchestrator.abortTurn("no-turn-here")).resolves.toBe(false);
  });

  it("runs killTool before the abort signal fans out", async () => {
    const order: string[] = [];
    const executeTurn = async (
      _sessionId: string,
      _req: TurnRequest,
      ctx?: { signal?: AbortSignal },
    ) => {
      await new Promise<void>((resolve) => {
        ctx?.signal?.addEventListener("abort", () => {
          order.push("signal");
          resolve();
        });
        setTimeout(resolve, 5000);
      });
      return {};
    };
    const orchestrator = new SessionOrchestrator({ executeTurn });
    orchestrator.runTurn("kill-order", { prompt: "slow" });
    await delay(20);
    await orchestrator.abortTurn("kill-order", () => {
      order.push("killTool");
      return true;
    });
    expect(order).toEqual(["killTool", "signal"]);
  });
});
