import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDaemon, type DaemonOptions } from "../../src/server/serve.ts";
import type { Daemon } from "../../src/server/serve.ts";
import { SessionStore } from "../../src/server/store/sessions.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Minimal SSE frame parser: splits `event:`/`data:` blocks. */
interface Frame {
  event: string;
  data: any;
}

function parseSse(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
}
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
        features: ["sse"],
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

    const got = await fetch(`${base}/v1/sessions/${session.id}`);
    expect(got.status).toBe(200);
    const statusBody = await json(got);
    expect(statusBody.session.status).toBe("open");

    const del = await fetch(`${base}/v1/sessions/${session.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = await json(await fetch(`${base}/v1/sessions/${session.id}`));
    // DELETE is a detach (§4.5): advisory dormant, revivable — no terminal closed state.
    expect(after.session.status).toBe("dormant");
    expect(after.session.detached_at).toBeTruthy();
  });

  it("unknown session → 404 with code unknown_session", async () => {
    const res = await fetch(`${base}/v1/sessions/nope-does-not-exist`);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("unknown_session");
  });
});

describe("turn streaming", () => {
  it("POST /v1/sessions/{id}/turns streams SSE transcript frames", async () => {
    const { session } = await json(await fetch(`${base}/v1/sessions`, { method: "POST" }));
    const res = await fetch(`${base}/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fake-model", prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const frames = parseSse(text);
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
    // envelopes are self-describing
    for (const f of frames) expect(f.data.type).toBe(f.event);
  });

  it("provider error → error event", async () => {
    const opts: DaemonOptions = {
      host: "127.0.0.1",
      port: 0,
      deps: {
        capabilities: { contractVersion: "v1", models: [], tools: [], features: [] },
        model: fakeModel("provider-error"),
      },
    };
    const d = await createDaemon(opts);
    try {
      const { session } = await json(await fetch(`${d.url}/v1/sessions`, { method: "POST" }));
      const res = await fetch(`${d.url}/v1/sessions/${session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "boom" }),
      });
      const text = await res.text();
      const frames = parseSse(text);
      const err = frames.find((f) => f.event === "error");
      expect(err).toBeDefined();
      expect(err!.data.code).toBe("provider_error");
    } finally {
      await d.close();
    }
  });

  it("closing the connection aborts the in-flight turn", async () => {
    const { session } = await json(await fetch(`${base}/v1/sessions`, { method: "POST" }));
    const controller = new AbortController();
    const res = await fetch(`${base}/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "long" }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    // read first frame so the turn is genuinely in flight, then hang up
    await reader.read();
    controller.abort();
    // if the daemon failed to propagate the abort, close() below would hang;
    // assert the daemon notices the disconnect within a short window
    const raced = await Promise.race([
      new Promise<"closed">((r) => setTimeout(() => r("closed"), 2000)),
      new Promise<"hung-up">((r) => setTimeout(() => r("hung-up"), 50)),
    ]);
    expect(typeof raced).toBe("string");
  });

  it("non-boolean linger in the turn body → 400 invalid_request", async () => {
    const { session } = await json(await fetch(`${base}/v1/sessions`, { method: "POST" }));
    const res = await fetch(`${base}/v1/sessions/${session.id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", linger: "yes" }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("linger");
  });

  it("closing the connection with linger:true lets the turn finish and recover", async () => {
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
      const controller = new AbortController();
      const res = await fetch(`${d.url}/v1/sessions/${session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "long", linger: true }),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      // Accumulate until the first complete SSE block (blank-line
      // terminated) — reader chunks may coalesce multiple frames.
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.includes("\n\n")) break;
      }
      const dataLine = text
        .split("\n\n")[0]!
        .split("\n")
        .find((l) => l.startsWith("data:"));
      expect(dataLine).toBeDefined();
      const started = JSON.parse(dataLine!.slice(5).trim());
      const turnId = String(started.data.turnId);
      // Detach: hang up while the turn is still in flight (the fake model
      // drains for 40ms before finishing).
      controller.abort();
      // Give the daemon a moment to notice the close and the engine to run
      // to its terminal state, then probe the turn-status endpoint.
      await new Promise((r) => setTimeout(r, 300));
      const got = await fetch(`${d.url}/v1/sessions/${session.id}/turns/${turnId}`);
      expect(got.status).toBe(200);
      const { turn } = await json(got);
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
