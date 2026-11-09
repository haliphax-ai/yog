import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon, type DaemonOptions } from "../../src/server/serve.ts";
import type { Daemon } from "../../src/server/serve.ts";
import { SessionStore } from "../../src/server/store/sessions.ts";
import { newSessionId } from "../../src/state/index.ts";
import { openStream, runTurnToEnd, sendMessage } from "../messages-helper.ts";

/** Fake model that captures the `messages` argument it receives. */
function capturingModel() {
  const captured: { messages: any[]; prompt: string; model: string }[] = [];
  return {
    captured,
    async runTurn(
      _sessionId: string,
      req: any,
      ctx: { emit: (ev: any) => Promise<void>; signal?: AbortSignal },
    ) {
      captured.push({
        messages: req.messages ?? [],
        prompt: req.prompt,
        model: req.model ?? "fake",
      });
      const turnId = newSessionId();
      await ctx.emit({
        id: 1,
        type: "turn.started",
        version: 1,
        ts: Date.now(),
        data: { turnId, model: req.model ?? "fake", ts: Date.now() },
      });
      await ctx.emit({
        id: 2,
        type: "message.delta",
        version: 1,
        ts: Date.now(),
        data: { text: "ack" },
      });
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 30);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      await ctx.emit({
        id: 3,
        type: "turn.finished",
        version: 1,
        ts: Date.now(),
        data: { turnId, durationMs: 1 },
      });
    },
  };
}

let daemon: Daemon;
let base: string;
let dir: string;
let store: SessionStore;
let model: ReturnType<typeof capturingModel>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-exec-"));
  store = await SessionStore.open(join(dir, "sessions.db"));
  model = capturingModel();
  const opts: DaemonOptions = {
    host: "127.0.0.1",
    port: 0,
    deps: {
      capabilities: {
        contractVersion: "v1",
        models: ["fake-model"],
        tools: ["bash"],
        features: ["messages", "stream"],
      },
      store: store as any,
      model: model as any,
    },
  };
  daemon = await createDaemon(opts);
  base = daemon.url;
});

afterAll(async () => {
  await daemon?.close();
  store?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("executeTurn (http fallback hydrate/persist path — model dep, no orchestrator)", () => {
  it("hydrates prior transcript and persists this turn's messages", async () => {
    const sessionRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const session = (await sessionRes.json()) as { session: { id: string } };
    const sid = session.session.id;

    const r1 = await runTurnToEnd(base, sid, { prompt: "hello" });
    r1.abort();
    expect(r1.startRes.status).toBe(202);

    const r2 = await runTurnToEnd(base, sid, { prompt: "world" });
    r2.abort();
    expect(r2.startRes.status).toBe(202);

    const captured = model.captured as {
      messages: any[];
      prompt: string;
      model: string;
    }[];
    expect(captured).toHaveLength(2);
    const turn2Messages = captured[1]!.messages;
    const userMsgs = turn2Messages.filter((m) => m.role === "user");
    expect(userMsgs.some((m) => m.content === "hello")).toBe(true);
    expect(userMsgs.some((m) => m.content === "world")).toBe(true);

    const transcript = await store.getTranscript(sid);
    const roles = transcript.map((m: any) => m.role);
    expect(roles.filter((r) => r === "user")).toHaveLength(2);
  });

  it("does not bleed transcript across sessions", async () => {
    const mk = async () => {
      const r = await fetch(`${base}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      return ((await r.json()) as { session: { id: string } }).session.id;
    };
    const a = await mk();
    const b = await mk();

    const ra = await runTurnToEnd(base, a, { prompt: "alpha" });
    ra.abort();
    const rb = await runTurnToEnd(base, b, { prompt: "beta" });
    rb.abort();

    const ta = await store.getTranscript(a);
    const tb = await store.getTranscript(b);
    expect(ta.some((m: any) => m.content === "beta")).toBe(false);
    expect(tb.some((m: any) => m.content === "alpha")).toBe(false);
  });

  it("persists the failed turn's rows on a provider failure (yog#42: no rewind)", async () => {
    const sessionRes = await fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const sid = ((await sessionRes.json()) as { session: { id: string } }).session.id;

    const before = await store.getTranscript(sid);
    expect(before).toHaveLength(0);

    // A realistic 429 mid-turn: promise rejection, no terminal emit first
    // (the synthesized `error` envelope is the adapter's job).
    const failModel = {
      async runTurn(_sessionId: string, req: any, ctx: { emit: (ev: any) => Promise<void> }) {
        await ctx.emit({
          id: 1,
          type: "turn.started",
          version: 1,
          ts: Date.now(),
          data: { turnId: "t-fail-1", model: "fake", ts: Date.now() },
        });
        // Simulate a partial tool round landing in the transcript before
        // the failure: an assistant row announcing a call that never
        // gets its `tool` answer (the heal path must stub it).
        const messages = Array.isArray(req?.messages) ? req.messages : [];
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_fail", type: "function", function: { name: "bash", arguments: "{}" } },
          ],
        });
        const err = new Error("429 rate limited") as Error & { code?: string };
        err.code = "rate_limited";
        throw err;
      },
    };
    const failDaemon = await createDaemon({
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: {
          contractVersion: "v1",
          models: ["fake-model"],
          tools: ["bash"],
          features: ["messages", "stream"],
        },
        store: store as any,
        model: failModel as any,
      },
    });
    try {
      const stream = await openStream(failDaemon.url, sid);
      const r = await sendMessage(failDaemon.url, sid, "turn.start", { prompt: "fail" });
      expect(r.status).toBe(202);
      await r.json();
      const frames = await stream.collectUntil((fs) => fs.some((f) => f.event === "error"), 10_000);
      stream.abort();
      const errFrame = frames.find((f) => f.event === "error");
      expect(errFrame).toBeDefined();
      expect(errFrame!.data.data.code).toBe("rate_limited");
      // Wait for the terminal settle (persist + finishTurn) to land before
      // asserting — the turn runs in the background (202 at once).
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 3000;
        const tick = async (): Promise<void> => {
          const turns = await store.listTurns(sid);
          if (turns.at(-1)?.status !== "running" || Date.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(() => void tick(), 25);
        };
        void tick();
      });
    } finally {
      await failDaemon.close();
    }

    const turns = await store.listTurns(sid);
    expect(turns.at(-1)?.status).toBe("error");
    expect(turns.at(-1)?.finished_at).not.toBeNull();
    const after = await store.getTranscript(sid);
    // The failed turn no longer rewinds: prompt + assistant announcement +
    // healed stub all survive (`transcript.get` returns only persisted
    // rows, so this is exactly the rehydrate dump's content).
    expect(after.map((m: any) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(after[0]?.content).toBe("fail");
    expect(after[1]?.tool_calls?.[0]?.id).toBe("call_fail");
    expect(after[2]?.tool_call_id).toBe("call_fail");
    expect(JSON.parse(after[2]?.content ?? "{}")).toMatchObject({ error: expect.any(String) });
  });
});
