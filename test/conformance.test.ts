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

function optsWith(model: ReturnType<typeof fakeModel>): DaemonOptions {
  return {
    host: "127.0.0.1",
    port: 0,
    deps: { capabilities: CAPABILITIES, model },
  };
}

let daemon: Daemon;
let base: string;

beforeAll(async () => {
  daemon = await createDaemon(optsWith(fakeModel("happy")));
  base = daemon.url;
});

afterAll(async () => {
  await daemon?.close();
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
    expect((await json(del)).session.status).toBe("closed");

    const after = await json(await fetch(`${base}/v1/sessions/${id}`));
    expect(after.session.status).toBe("closed");
  });

  it("refuses a turn on a closed session (session_closed → 409)", async () => {
    const id = await newSession();
    await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).error.code).toBe("session_closed");
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
  it("GET /v1/sessions/{id}/turns/{turnId} resolves for a live session (recovery contract)", async () => {
    const id = await newSession();
    // The recovery endpoint is what a client hits when the SSE stream dies:
    // for a known session the route resolves (the adapter answers with the
    // turn's stored state, or a structured error for a turn it has no state
    // for — never a raw 404 route miss).
    const res = await fetch(`${base}/v1/sessions/${id}/turns/turn-conf-1`);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toContain("turn-conf-1");
  });

  it("unknown session on the recovery route → 404 unknown_session", async () => {
    const res = await fetch(`${base}/v1/sessions/nope/turns/turn-1`);
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("unknown_session");
  });
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
    const d = await createDaemon(optsWith(fakeModel("provider-error")));
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
