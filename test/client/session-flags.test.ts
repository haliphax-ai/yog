/**
 * `yog run --session` / `--resume`.
 *
 * The default one-shot flow stays untouched — create → turn → DELETE — but the
 * two new optional flags change it:
 *
 * - `--session <id>` reuses an existing session: no create POST, the turn runs
 *   on the given id, and the trailing DELETE is skipped (the session outlives
 *   the client process).
 * - `--resume` rehydrates locally before streaming: GET
 *   /v1/sessions/{id}/transcript first, render the prior history, then POST
 *   the new turn.
 *
 * The default-flow test pins the unchanged baseline; the flag tests pin the
 * new behavior landed in src/client/run.ts.
 */
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { runClient, type RunClientOptions, type RunResult } from "../../src/client/run.ts";

const MODEL = "openai-fake";
const PROMPT = "hello again, yog";
/** Session id the mock create endpoint hands out. */
const FRESH_ID = "sess-fresh";
/** Session id passed via `--session` (created by an earlier process). */
const REUSED_ID = "sess-existing";

/** Prior history the mock transcript endpoint serves (contract §4.6 shape). */
const PRIOR_MESSAGES = [
  { seq: 1, turnId: 1, ts: 1, role: "user", content: "prior question" },
  { seq: 2, turnId: 1, ts: 2, role: "assistant", content: "prior answer" },
];

/** One captured request: line + (for bodies) the raw JSON payload. */
interface RecordedRequest {
  method: string;
  path: string;
  body?: string;
}

/** Loopback server handle plus what it recorded while serving. */
interface MockServer {
  /** Origin, e.g. `http://127.0.0.1:54321` (no trailing slash). */
  base: string;
  requests: RecordedRequest[];
  server: Server;
}

function frame(type: string, data: unknown): string {
  return `event:${type}\ndata:${JSON.stringify({ type, data })}\n\n`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** `METHOD /path` lines, the assertion currency for request sequences. */
function seqOf(requests: RecordedRequest[]): string[] {
  return requests.map((r) => `${r.method} ${r.path}`);
}

/** Loopback mock v1 daemon serving the phase-6-era routes under test. */
function startMockServer(): Promise<MockServer> {
  const requests: RecordedRequest[] = [];

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const entry: RecordedRequest = { method: req.method ?? "GET", path };
    // Push on arrival so ordering reflects request order, not body-read order.
    requests.push(entry);

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => undefined);
    req.on("end", () => {
      if (chunks.length > 0) entry.body = Buffer.concat(chunks).toString("utf8");
      route(req, res);
    });

    const segs = path.split("/").filter(Boolean);

    function route(_req: unknown, res: ServerResponse): void {
      // GET /v1/capabilities
      if (entry.method === "GET" && segs[1] === "capabilities") {
        sendJson(res, 200, {
          contractVersion: "v1",
          models: [MODEL],
          tools: ["bash"],
          features: ["sse", "transcript"],
        });
        return;
      }

      // POST /v1/sessions — create (skipped when --session is given).
      if (entry.method === "POST" && segs.length === 2 && segs[1] === "sessions") {
        sendJson(res, 201, {
          session: { id: FRESH_ID, status: "open", created_at: 1, updated_at: Date.now() },
        });
        return;
      }

      // GET /v1/sessions/{id}/transcript — the rehydration dump.
      if (entry.method === "GET" && segs.length === 4 && segs[3] === "transcript") {
        sendJson(res, 200, {
          session: { id: segs[2], status: "open", created_at: 1, updated_at: Date.now() },
          messages: PRIOR_MESSAGES,
        });
        return;
      }

      // DELETE /v1/sessions/{id} — detach (must be skipped under --session).
      if (entry.method === "DELETE" && segs.length === 3 && segs[1] === "sessions") {
        sendJson(res, 200, {
          session: { id: segs[2], status: "dormant", created_at: 1, updated_at: Date.now() },
        });
        return;
      }

      // POST /v1/sessions/{id}/turns — complete SSE turn on any session id.
      if (entry.method === "POST" && segs.length === 4 && segs[3] === "turns") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame("turn.started", { turnId: "turn-1", model: MODEL, ts: 1 }));
        res.write(frame("message.delta", { text: "Hello " }));
        res.write(frame("tool.call", { id: "c1", name: "bash", args: "{}" }));
        res.write(frame("tool.result", { id: "c1", name: "bash", ok: true, result: "ok" }));
        res.write(frame("message.delta", { text: "world" }));
        res.write(frame("turn.finished", { turnId: "turn-1", durationMs: 12, stopReason: "stop" }));
        res.end();
        return;
      }

      sendJson(res, 404, {
        error: { code: "invalid_request", message: `no route: ${entry.method} ${path}` },
      });
    }
  });

  return new Promise<MockServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ base: `http://127.0.0.1:${port}`, requests, server });
    });
  });
}

/** Writable capturing everything written through a node stream. */
class Capture extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _enc: string, cb: (err?: Error | null) => void): void {
    this.text += String(chunk);
    cb();
  }
}

function opts(
  base: string,
  stdout: Writable,
  stderr: Writable,
  extra?: Partial<RunClientOptions>,
): RunClientOptions {
  return { baseUrl: base, model: MODEL, prompt: PROMPT, stdout, stderr, ...extra };
}

const servers: MockServer[] = [];

async function mock(): Promise<MockServer> {
  const s = await startMockServer();
  servers.push(s);
  return s;
}

afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.server.close(() => resolve()))),
  );
});

describe("runClient default flow (no flags)", () => {
  it("still walks capabilities → create → turn → close in order", async () => {
    const { base, requests } = await mock();

    const stdout = new Capture();
    const stderr = new Capture();
    const result = await runClient(opts(base, stdout, stderr));

    expect(result.exitCode).toBe(0);
    expect(seqOf(requests)).toEqual([
      "GET /v1/capabilities",
      "POST /v1/sessions",
      "POST /v1/sessions/sess-fresh/turns",
      "DELETE /v1/sessions/sess-fresh",
    ]);
  }, 15_000);
});

describe("runClient --session <id>", () => {
  it("skips create, POSTs the turn to the given id, and skips the trailing DELETE", async () => {
    const { base, requests } = await mock();

    const stdout = new Capture();
    const stderr = new Capture();
    const result = await runClient(opts(base, stdout, stderr, { session: REUSED_ID }));

    const seq = seqOf(requests);
    // The session already exists server-side: nothing may be created...
    expect(seq).not.toContain("POST /v1/sessions");
    // ...the turn runs on the reused id...
    expect(seq).toContain(`POST /v1/sessions/${REUSED_ID}/turns`);
    // ...and the session outlives the client process: no trailing DELETE.
    expect(seq.some((r) => r.startsWith("DELETE /v1/sessions/"))).toBe(false);
    expect(result.exitCode).toBe(0);
  }, 15_000);

  it("never sends history: the turn body carries only prompt/model", async () => {
    const { base, requests } = await mock();

    const stdout = new Capture();
    const stderr = new Capture();
    await runClient(opts(base, stdout, stderr, { session: REUSED_ID }));

    const turn = requests.find((r) => r.path === `/v1/sessions/${REUSED_ID}/turns`);
    expect(turn).toBeDefined();
    const body = JSON.parse(turn!.body ?? "{}") as Record<string, unknown>;
    expect(body["prompt"]).toBe(PROMPT);
    expect(body["model"]).toBe(MODEL);
    // Clients never send history: no messages array on the wire.
    expect(body["messages"]).toBeUndefined();
  }, 15_000);
});

describe("runClient --resume", () => {
  it("GETs the transcript before the turn and renders prior history first", async () => {
    const { base, requests } = await mock();

    const stdout = new Capture();
    const stderr = new Capture();
    const result = await runClient(opts(base, stdout, stderr, { resume: true }));

    expect(result.exitCode).toBe(0);
    const seq = seqOf(requests);
    // --resume without --session still creates its own session, then rehydrates.
    const createAt = seq.indexOf("POST /v1/sessions");
    const transcriptAt = seq.indexOf(`GET /v1/sessions/${FRESH_ID}/transcript`);
    const turnAt = seq.indexOf(`POST /v1/sessions/${FRESH_ID}/turns`);
    expect(transcriptAt).toBeGreaterThan(createAt);
    // The transcript GET must happen before the new turn is streamed.
    expect(transcriptAt).toBeGreaterThanOrEqual(0);
    expect(turnAt).toBeGreaterThan(transcriptAt);

    // Prior history was rendered before the new turn's streamed deltas.
    expect(stdout.text).toContain("prior question");
    expect(stdout.text).toContain("prior answer");
    expect(stdout.text.indexOf("prior answer")).toBeLessThan(stdout.text.indexOf("Hello"));
  }, 15_000);
});

describe("runClient --session + --resume", () => {
  it("rehydrates then continues on the reused id without create or DELETE", async () => {
    const { base, requests } = await mock();

    const stdout = new Capture();
    const stderr = new Capture();
    const result = await runClient(
      opts(base, stdout, stderr, { session: REUSED_ID, resume: true }),
    );

    expect(result.exitCode).toBe(0);
    const seq = seqOf(requests);
    expect(seq).not.toContain("POST /v1/sessions");
    const transcriptAt = seq.indexOf(`GET /v1/sessions/${REUSED_ID}/transcript`);
    const turnAt = seq.indexOf(`POST /v1/sessions/${REUSED_ID}/turns`);
    expect(transcriptAt).toBeGreaterThanOrEqual(0);
    expect(turnAt).toBeGreaterThan(transcriptAt);
    expect(seq.some((r) => r.startsWith("DELETE /v1/sessions/"))).toBe(false);

    // Rehydrated history rendered, then the continuation streamed.
    expect(stdout.text).toContain("prior question");
    expect(stdout.text).toContain("prior answer");
    expect(stdout.text.indexOf("prior answer")).toBeLessThan(stdout.text.indexOf("Hello"));
  }, 15_000);
});
