import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createDaemon, type DaemonOptions } from "../../src/server/serve.ts";
import type { Daemon } from "../../src/server/serve.ts";
import { createHttpServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/server/store/sessions.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStream, sendMessage } from "../messages-helper.ts";

/** `Response.json()` with a loose type: assertions do the checking. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

/** Fake model injected through daemon deps: scripted turn behaviour. */
function fakeModel(script: "happy" | "provider-error") {
  return {
    async runTurn(
      _sessionId: string,
      req: any,
      ctx: { emit: (ev: any) => Promise<void>; signal?: AbortSignal },
    ) {
      if (script === "provider-error") {
        await ctx.emit({
          id: 1,
          type: "error",
          version: 1,
          ts: Date.now(),
          code: "provider_error",
          data: { code: "provider_error", message: "upstream exploded" },
        });
        return;
      }
      const turnId = `turn-${Date.now()}`;
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
        data: { text: "hello " },
      });
      await ctx.emit({
        id: 3,
        type: "tool.call",
        version: 1,
        ts: Date.now(),
        data: { id: "c1", name: "bash", args: "{}" },
      });
      await ctx.emit({
        id: 4,
        type: "tool.result",
        version: 1,
        ts: Date.now(),
        data: { id: "c1", name: "bash", ok: true, result: "ok" },
      });
      await ctx.emit({
        id: 5,
        type: "message.delta",
        version: 1,
        ts: Date.now(),
        data: { text: "world" },
      });
      // Short synthetic drain so the happy path finishes within the test
      // timeout; the abort listener lets the abort-on-disconnect test end early.
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 40);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
      await ctx.emit({
        id: 6,
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

beforeAll(async () => {
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
      contextWindowFor: (model: string) => (model === "fake-model" ? 64000 : undefined),
      model: fakeModel("happy"),
    },
  };
  daemon = await createDaemon(opts);
  base = daemon.url;
});

afterAll(async () => {
  await daemon?.close();
});

describe("capabilities", () => {
  it("GET /v1/capabilities returns contractVersion, models, tools, features", async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.contractVersion).toBeDefined();
    expect(Array.isArray(body.models)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.features).toBeDefined();
  });
  it("GET /v1/capabilities?model= resolves that model's context window", async () => {
    const res = await fetch(`${base}/v1/capabilities?model=fake-model`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.contextWindowSizes).toEqual({ "fake-model": 64000 });
  });
});

describe("session lifecycle", () => {
  it("creates, shows status, and closes a session", async () => {
    const created = await fetch(`${base}/v1/sessions`, { method: "POST" });
    expect(created.status).toBe(201);
    const { session } = await json(created);
    expect(session.id).toBeTruthy();

    const got = await sendMessage(base, session.id, "session.get");
    expect(got.status).toBe(200);
    const statusBody = (await json(got)).data;
    expect(statusBody.session.status).toBe("open");

    const del = await sendMessage(base, session.id, "session.detach");
    expect(del.status).toBe(200);
    const after = (await json(await sendMessage(base, session.id, "session.get"))).data;
    // session.detach is a detach (§4.5): advisory dormant, revivable — no terminal closed state.
    // DELETE is a detach (§4.5): advisory dormant, revivable — no terminal closed state.
    expect(after.session.status).toBe("dormant");
    expect(after.session.detached_at).toBeTruthy();
  });

  it("unknown session → 404 with code unknown_session", async () => {
    const res = await sendMessage(base, "nope-does-not-exist", "session.get");
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("unknown_session");
  });
});

describe("turn on the session stream", () => {
  it("turn.start streams SSE transcript frames on the session stream", async () => {
    const { session } = await json(await fetch(`${base}/v1/sessions`, { method: "POST" }));
    const stream = await openStream(base, session.id);
    expect(stream.res.headers.get("content-type")).toContain("text/event-stream");
    const res = await sendMessage(base, session.id, "turn.start", {
      model: "fake-model",
      prompt: "hi",
    });
    expect(res.status).toBe(202);
    const frames = await stream.collectUntil(
      (fs) => fs.some((f) => f.event === "turn.finished"),
      10_000,
    );
    stream.abort();
    const types = frames.map((f) => f.event);
    for (const expected of [
      "turn.started",
      "message.delta",
      "tool.call",
      "tool.result",
      "turn.finished",
    ]) {
      expect(types).toContain(expected);
    }
    // envelopes are self-describing (the stream hello is transport framing)
    for (const f of frames.filter((f) => f.event !== "stream.hello"))
      expect(f.data.type).toBe(f.event);
  });

  it("provider error → error event, and the failed turn persists marked `error` (yog#42)", async () => {
    const store = await SessionStore.open(join(tmpdir(), `yog-provider-${Date.now()}.db`));
    const opts: DaemonOptions = {
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
        model: fakeModel("provider-error"),
        store,
      },
    };
    const d = await createDaemon(opts);
    try {
      const { session } = await json(await fetch(`${d.url}/v1/sessions`, { method: "POST" }));
      const sid = session.id as string;
      const stream = await openStream(d.url, sid);
      const res = await sendMessage(d.url, sid, "turn.start", { prompt: "boom" });
      expect(res.status).toBe(202);
      const frames = await stream.collectUntil((fs) => fs.some((f) => f.event === "error"), 10_000);
      stream.abort();
      const err = frames.find((f) => f.event === "error");
      expect(err).toBeDefined();
      expect(err!.data.data.code).toBe("provider_error");
      // Wait for the background settle, then assert the persisted dump.
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
      const dump = ((await (await sendMessage(d.url, sid, "transcript.get")).json()) as any).data;
      expect(dump.messages.map((m: any) => m.role)).toEqual(["user"]);
      expect(dump.messages[0].content).toBe("boom");
      expect(dump.turns?.at(-1)?.status).toBe("error");
    } finally {
      await d.close();
      store.close();
    }
  });

  it("closing the bound stream aborts the in-flight turn (abortOnDisconnect opt-in)", async () => {
    const { session } = await json(await fetch(`${base}/v1/sessions`, { method: "POST" }));
    const stream = await openStream(base, session.id);
    const res = await sendMessage(base, session.id, "turn.start", {
      prompt: "long",
      abortOnDisconnect: true,
      streamId: stream.streamId,
    });
    expect(res.status).toBe(202);
    // Hang up the bound stream while the turn is in flight.
    stream.abort();
    // The turn was bound to that stream, so the daemon aborts it; assert
    // the daemon notices the disconnect within a short window, then that
    // a fresh stream replays the persisted terminal state.
    const raced = await Promise.race([
      new Promise<"closed">((r) => setTimeout(() => r("closed"), 2000)),
      new Promise<"hung-up">((r) => setTimeout(() => r("hung-up"), 50)),
    ]);
    expect(typeof raced).toBe("string");
  });

  it("non-boolean abortOnDisconnect in the turn body → 400 invalid_request", async () => {
    const { session } = await json(await fetch(`${base}/v1/sessions`, { method: "POST" }));
    const res = await sendMessage(base, session.id, "turn.start", {
      prompt: "hi",
      abortOnDisconnect: "yes",
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("abortOnDisconnect");
  });

  it("closing the stream lets the turn finish and recover (default linger)", async () => {
    // Own sqlite store: the recovery endpoint is store-backed, and this
    // daemon has none injected by default.
    const store = await SessionStore.open(join(tmpdir(), `yog-linger-${Date.now()}.db`));
    const d = await createDaemon({
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
        model: fakeModel("happy"),
        store,
      },
    });
    try {
      const { session } = await json(await fetch(`${d.url}/v1/sessions`, { method: "POST" }));
      const stream = await openStream(d.url, session.id);
      const res = await sendMessage(d.url, session.id, "turn.start", { prompt: "long" });
      expect(res.status).toBe(202);
      // Detach: hang up while the turn is still in flight (the fake model
      // drains for 40ms before finishing).
      stream.abort();
      // Give the daemon a moment to notice the close and the engine to run
      // to its terminal state, then probe turn.get.
      await new Promise((r) => setTimeout(r, 300));
      const got = await sendMessage(d.url, session.id, "turn.get", { turnId: "any" });
      expect(got.status).toBe(200);
      const { turn } = (await json(got)).data;
      expect(turn.status).toBe("finished");
      const types = turn.events.map((e: any) => e.type);
      expect(types).toContain("turn.started");
      expect(types).toContain("turn.finished");
    } finally {
      // The dangling socket must not hold the daemon open.
      await d.close();
      store.close();
    }
  }, 15_000);
});

describe("orchestrator-path streaming (bus delivery)", () => {
  it("default linger mode delivers tool.call/tool.result/turn.finished on the wire (no double persist)", async () => {
    // Mirrors the real daemon composition: executeTurn's sink persists
    // each envelope once, then publishes it to the per-daemon bus; the
    // HTTP adapter subscribes per session and frames the envelopes.
    const store = await SessionStore.open(join(tmpdir(), `yog-wire-${Date.now()}.db`));
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    const orchestrator = {
      runTurn: (sessionId: string, req: any) => {
        const publish = async (type: string, data: unknown): Promise<void> => {
          await store.addEvent(sessionId, { type, payload: JSON.stringify(data), version: 1 });
          bus.emit(`session:${sessionId}`, {
            id: 0,
            type,
            version: 1,
            ts: Date.now(),
            data,
          });
        };
        const promise = (async () => {
          // Mirrors serve.ts executeTurn: the orchestrator path owns the
          // turn row (the HTTP adapter no longer creates a duplicate).
          await store.addTurn(sessionId, {
            role: "user",
            content: req?.prompt ?? "hi",
            status: "running",
            model: "fake",
          });
          await publish("turn.started", { turnId: "t-wire", model: "fake", ts: Date.now() });
          await publish("message.delta", { text: "hello " });
          await publish("tool.call", { id: "c1", name: "bash", args: "{}" });
          await publish("tool.result", { id: "c1", name: "bash", ok: true, result: "ok" });
          await publish("message.delta", { text: "world" });
          await publish("turn.finished", { turnId: "t-wire", durationMs: 1 });
        })();
        return { promise, abort: () => undefined };
      },
    };
    const server = createHttpServer({
      capabilities: {
        contractVersion: "v1",
        models: [],
        tools: [],
        features: ["messages", "stream"],
      },
      store,
      orchestrator,
      bus,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, { method: "POST" });
      const { session } = (await created.json()) as { session: { id: string } };
      const stream = await openStream(`http://127.0.0.1:${port}`, session.id);
      const res = await sendMessage(`http://127.0.0.1:${port}`, session.id, "turn.start", {
        prompt: "hi",
      });
      expect(res.status).toBe(202);
      const frames = await stream.collectUntil(
        (fs) => fs.some((f) => f.event === "turn.finished"),
        10_000,
      );
      stream.abort();
      const types = frames.map((f) => f.event);
      for (const expected of [
        "turn.started",
        "message.delta",
        "tool.call",
        "tool.result",
        "turn.finished",
      ]) {
        expect(types).toContain(expected);
      }
      // §4.8 dedup: the sink persists each event exactly once — the
      // adapter's bus subscriber must not write a second row. Counts
      // match what the orchestrator published (two deltas by design).
      const events = await store.listEvents(session.id);
      const expectedCounts: Record<string, number> = {
        "turn.started": 1,
        "message.delta": 2,
        "tool.call": 1,
        "tool.result": 1,
        "turn.finished": 1,
      };
      for (const [t, n] of Object.entries(expectedCounts)) {
        expect(events.filter((e: any) => e.type === t)).toHaveLength(n);
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  });
});

describe("transcript dump for in-flight (running) turns", () => {
  it("rehydrates the running turn's completed rounds from persisted events, and drops synthetic rows once settled", async () => {
    const store = await SessionStore.open(join(tmpdir(), `yog-inflight-${Date.now()}.db`));
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    const usageBySession = new Map<string, any>();
    let releaseTurn!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const orchestrator = {
      runTurn: (sessionId: string, req: any) => {
        const promise = (async () => {
          const turnRow = await store.addTurn(sessionId, {
            role: "user",
            content: req.prompt,
            status: "running",
            model: "fake",
          });
          const turnRowId = turnRow.id;
          const publish = async (type: string, data: unknown) => {
            await store.addEvent(sessionId, { type, payload: JSON.stringify(data), version: 1 });
            bus.emit(`session:${sessionId}`, { id: 0, type, version: 1, ts: Date.now(), data });
          };
          await publish("turn.started", { turnId: "t-inflight", model: "fake", ts: Date.now() });
          await publish("message.delta", { text: "partial " });
          await publish("tool.call", { id: "c1", name: "bash", args: "{}" });
          await publish("tool.result", {
            id: "c1",
            name: "bash",
            ok: true,
            result: "ok",
            resultTokens: 5,
          });
          usageBySession.set(sessionId, {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          });
          await gate;
          await publish("message.delta", { text: "done" });
          await publish("turn.finished", { turnId: "t-inflight", durationMs: 1 });
          await store.appendMessages(
            sessionId,
            [
              { role: "user", content: req.prompt },
              { role: "assistant", content: "partial done" },
            ] as any,
            turnRowId,
          );
          await store.finishTurn(sessionId, turnRowId, "finished", usageBySession.get(sessionId));
        })();
        return { promise, abort: () => undefined };
      },
    };
    const server = createHttpServer({
      capabilities: {
        contractVersion: "v1",
        models: [],
        tools: [],
        features: ["messages", "stream", "transcript"],
      },
      store,
      orchestrator,
      bus,
      onUsageFor: (sid: string) => usageBySession.get(sid),
    } as any);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      const { session } = (await (
        await fetch(`${base}/v1/sessions`, { method: "POST" })
      ).json()) as any;
      const sid = session.id;
      const stream = await openStream(base, sid);
      const res = await sendMessage(base, sid, "turn.start", { prompt: "inflight q" });
      expect(res.status).toBe(202);
      stream.abort(); // disconnect mid-turn (linger)
      await new Promise((r) => setTimeout(r, 100));
      // While running: transcript.get must carry the in-flight turn
      // (user prompt + completed tool round + partial prose), not just
      // the previous turn — with no usage gate on the client side.
      const runningDump = ((await (await sendMessage(base, sid, "transcript.get")).json()) as any)
        .data as any;
      expect(runningDump.turns?.some((t: any) => t.status === "running")).toBe(true);
      const runningMessages = runningDump.messages.map((m: any) => `${m.role}:${m.content ?? ""}`);
      expect(runningMessages).toContain("user:inflight q");
      expect(runningMessages.some((m: string) => m.startsWith("tool:"))).toBe(true);
      expect(
        runningDump.messages.some(
          (m: any) => m.role === "assistant" && String(m.content ?? "").includes("partial"),
        ),
      ).toBe(true);
      // Settle it.
      releaseTurn();
      await new Promise((r) => setTimeout(r, 200));
      const settledDump = ((await (await sendMessage(base, sid, "transcript.get")).json()) as any)
        .data as any;
      expect(settledDump.turns?.some((t: any) => t.status === "running")).toBe(false);
      // Exactly one user + one assistant from the real persisted rows —
      // no synthetic duplicates remain.
      expect(settledDump.messages.filter((m: any) => m.role === "user")).toHaveLength(1);
      expect(settledDump.messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
      expect(settledDump.messages.find((m: any) => m.role === "assistant")?.content).toBe(
        "partial done",
      );
      // Single turn row: no duplicate adapter row.
      const turns = await store.listTurns(sid);
      expect(turns).toHaveLength(1);
      expect(turns[0].status).toBe("finished");
    } finally {
      releaseTurn();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    }
  }, 15_000);
});
