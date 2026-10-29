/**
 * Conformance suite — exercises the v1 contract exactly like an external
 * client (plain Node `fetch` against an ephemeral daemon), never by
 * importing adapter internals.
 *
 * Boot: `createDaemon` with injected deps (same fake-model pattern as
 * `test/server/http.test.ts`) so no store, pool, OpenAI key, or FUSE mount
 * is needed. Covered contract surface:
 *
 *   GET    /v1/capabilities
 *   POST   /v1/sessions
 *   GET    /v1/sessions/{id}
 *   DELETE /v1/sessions/{id}
 *   POST   /v1/sessions/{id}/turns          (SSE transcript)
 *   GET    /v1/sessions/{id}/turns/{turnId} (turn-status recovery)
 *
 * plus the stable error-code → HTTP status mapping.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDaemon, type Daemon, type DaemonOptions } from "../src/server/serve.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/server/store/sessions.ts";

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
      const turnId = "turn-conf-1";
      await ctx.emit({
        id: 1,
        type: "turn.started",
        version: 1,
        ts: Date.now(),
        data: { turnId, model: req.model ?? "fake-model", ts: Date.now() },
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
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 20);
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

const CAPABILITIES = {
  contractVersion: "v1",
  models: ["conformance-model"],
  tools: ["bash"],
  features: ["sse"],
};

function optsWith(model: ReturnType<typeof fakeModel>, store: SessionStore): DaemonOptions {
  return {
    host: "127.0.0.1",
    port: 0,
    deps: { capabilities: CAPABILITIES, model, store },
  };
}

let daemon: Daemon;
let base: string;
let store: SessionStore | undefined;
let storePath: string;

beforeAll(async () => {
  storePath = join(tmpdir(), `yog-conf-${Date.now()}.db`);
  store = await SessionStore.open(storePath);
  daemon = await createDaemon(optsWith(fakeModel("happy"), store));
  base = daemon.url;
});

afterAll(async () => {
  await daemon?.close();
  store?.close();
});

/** POST /v1/sessions → session id. */
async function newSession(): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, { method: "POST" });
  expect(res.status).toBe(201);
  const { session } = await json(res);
  expect(session.id).toBeTruthy();
  return session.id as string;
}

describe("conformance: capabilities", () => {
  it("GET /v1/capabilities advertises contractVersion, models, tools, features", async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await json(res);
    expect(body.contractVersion).toBe("v1");
    expect(body.models).toContain("conformance-model");
    expect(body.tools).toContain("bash");
    expect(body.features).toContain("sse");
  });
});

describe("conformance: session lifecycle", () => {
  it("creates, shows status, and deletes a session", async () => {
    const id = await newSession();

    const got = await fetch(`${base}/v1/sessions/${id}`);
    expect(got.status).toBe(200);
    expect((await json(got)).session.status).toBe("open");

    const del = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await json(del)).session.status).toBe("dormant");

    // Detach is advisory (§4.5): nothing is forfeited, the session stays
    // readable, and there is no terminal `closed` state short of pruning.
    const after = await json(await fetch(`${base}/v1/sessions/${id}`));
    expect(after.session.status).toBe("dormant");
    expect(after.session.detached_at).toBeTruthy();
  });

  it("a turn on a dormant session implicitly revives it (status open, detached_at cleared)", async () => {
    const id = await newSession();
    await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    // Revive is implicit: the turn streams (no session_closed 409 — §4.6).
    expect(res.status).toBe(200);
    await res.text();

    const after = await json(await fetch(`${base}/v1/sessions/${id}`));
    expect(after.session.status).toBe("open");
    expect(after.session.detached_at).toBeNull();
  });
});

describe("conformance: SSE turn transcript", () => {
  it("POST /v1/sessions/{id}/turns streams a full transcript like an external client", async () => {
    const id = await newSession();
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "conformance-model", prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const frames = parseSse(await res.text());
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
    // Envelopes are self-describing and ordered: id monotonic, turnId announced.
    let prevId = 0;
    for (const f of frames) {
      expect(f.data.type).toBe(f.event);
      expect(f.data.id).toBeGreaterThan(prevId);
      prevId = f.data.id;
    }
    const started = frames.find((f) => f.event === "turn.started")!;
    expect(started.data.data.turnId).toBe("turn-conf-1");
    const text = frames
      .filter((f) => f.event === "message.delta")
      .map((f) => f.data.data.text)
      .join("");
    expect(text).toBe("hello world");
  }, 15_000);
});

describe("conformance: turn-status recovery endpoint", () => {
  it("recovers full terminal turn state from sqlite after SSE completes", async () => {
    const id = await newSession();
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "conformance-model", prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    const started = frames.find((f) => f.event === "turn.started");
    expect(started).toBeDefined();
    const turnId = String(started!.data.data.turnId);
    // The SSE stream is over: terminal state must be recoverable from the
    // store-backed route, exactly as a client that lost the stream would.
    const got = await fetch(`${base}/v1/sessions/${id}/turns/${turnId}`);
    expect(got.status).toBe(200);
    const { turn } = await json(got);
    expect(turn.status).toBe("finished");
    expect(typeof turn.model).toBe("string");
    expect(typeof turn.created_at).toBe("number");
    expect("finished_at" in turn).toBe(true);
    expect("duration_ms" in turn).toBe(true);
    const types = turn.events.map((e: any) => e.type);
    for (const expected of [
      "turn.started",
      "message.delta",
      "tool.call",
      "tool.result",
      "turn.finished",
    ]) {
      expect(types).toContain(expected);
    }
    for (const e of turn.events) {
      expect(e.id).toBeGreaterThan(0);
      expect(typeof e.version).toBe("number");
      expect(typeof e.ts).toBe("number");
      expect(e.data).toBeDefined();
    }
  }, 15_000);

  it("unknown session on the recovery route → 404 unknown_session", async () => {
    const res = await fetch(`${base}/v1/sessions/nope/turns/turn-1`);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("unknown_session");
  });

  it("session with a missing turn → 404 invalid_request", async () => {
    const id = await newSession();
    const res = await fetch(`${base}/v1/sessions/${id}/turns/nope`);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("nope");
  });
});

describe("conformance: persistence across restart", () => {
  it("session and stored turn events survive a daemon restart", async () => {
    const id = await newSession();
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "conformance-model", prompt: "hi" }),
    });
    expect(res.status).toBe(200);
    const frames = parseSse(await res.text());
    const started = frames.find((f) => f.event === "turn.started");
    expect(started).toBeDefined();
    const turnId = String(started!.data.data.turnId);

    await daemon.close();
    store!.close();

    // Boot a second daemon over the same sqlite file: everything persisted
    // must still be reachable.
    const store2 = await SessionStore.open(storePath);
    daemon = await createDaemon(optsWith(fakeModel("happy"), store2));
    store = store2;
    base = daemon.url;

    const sess = await fetch(`${base}/v1/sessions/${id}`);
    expect(sess.status).toBe(200);
    expect((await json(sess)).session.id).toBe(id);

    const got = await fetch(`${base}/v1/sessions/${id}/turns/${turnId}`);
    expect(got.status).toBe(200);
    const { turn } = await json(got);
    expect(turn.status).toBe("finished");
    const types = turn.events.map((e: any) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.finished");
  }, 15_000);
});

describe("conformance: error-code mapping", () => {
  it("unknown session → 404 unknown_session", async () => {
    const res = await fetch(`${base}/v1/sessions/nope`);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("unknown_session");
  });

  it("malformed turn body → 400 invalid_request", async () => {
    const id = await newSession();
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("invalid_request");
  });

  it("unknown route → 400 invalid_request", async () => {
    const res = await fetch(`${base}/v1/nope`);
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("invalid_request");
  });

  it("missing bearer token → 401 unauthorized when YOG_API_TOKEN is set", async () => {
    process.env.YOG_API_TOKEN = "conformance-secret";
    try {
      const res = await fetch(`${base}/v1/capabilities`);
      expect(res.status).toBe(401);
      expect((await json(res)).error.code).toBe("unauthorized");
      const ok = await fetch(`${base}/v1/capabilities`, {
        headers: { authorization: "Bearer conformance-secret" },
      });
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.YOG_API_TOKEN;
    }
  });

  it("provider failure surfaces as a terminal SSE error event (provider_error → 502 semantics)", async () => {
    const providerStore = await SessionStore.open(
      join(tmpdir(), `yog-conf-provider-${Date.now()}.db`),
    );
    const d = await createDaemon(optsWith(fakeModel("provider-error"), providerStore));
    try {
      const created = await json(await fetch(`${d.url}/v1/sessions`, { method: "POST" }));
      const res = await fetch(`${d.url}/v1/sessions/${created.session.id}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "boom" }),
      });
      expect(res.status).toBe(200); // stream opens; failure is in-band
      const frames = parseSse(await res.text());
      const err = frames.find((f) => f.event === "error");
      expect(err).toBeDefined();
      expect(err!.data.data.code).toBe("provider_error");
      expect(err!.data.code).toBe("provider_error");
    } finally {
      await d.close();
    }
  }, 15_000);
});
