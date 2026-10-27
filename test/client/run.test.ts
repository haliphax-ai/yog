/**
 * Phase 5 RED tests: `yog run` as a pure network client (PLAN.md §7).
 *
 * A mock HTTP/SSE server (node:http, 127.0.0.1, ephemeral port) plays the
 * daemon. The client must walk the ratified flow —
 *
 *   (optional) GET /v1/capabilities
 *     → POST   /v1/sessions
 *     → POST   /v1/sessions/{id}/turns   (SSE)
 *     → DELETE /v1/sessions/{id}
 *
 * — write `message.delta` text to stdout, tool activity to stderr, exit 0/1,
 * print a friendly `yog serve` error when the server is unreachable, and fall
 * back to `GET /v1/sessions/{id}/turns/{turnId}` when the SSE stream dies
 * mid-turn.
 *
 * These tests are intentionally written against the *stub* client (`readSseStream`
 * never calls its handlers; `runClient` rejects with 'not implemented'), so they
 * fail until Phase 5 lands the real implementation.
 */
import type { ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { runClient, type RunClientOptions, type RunResult } from "../../src/client/run.ts";

const MODEL = "openai-fake";
const PROMPT = "hello, yog";

/** Loopback server handle plus what it recorded while serving. */
interface MockServer {
  /** Origin, e.g. `http://127.0.0.1:54321` (no trailing slash). */
  base: string;
  requests: { method: string; path: string }[];
  server: Server;
}

function frame(type: string, data: unknown): string {
  return `event:${type}\ndata:${JSON.stringify({ type, data })}\n\n`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * Mock v1 daemon. `script` decides what POST …/turns does:
 *
 * - `complete`: normal SSE run, then a clean connection end.
 * - `interrupted`: emit turnId + one delta, then destroy the socket (no
 *   `turn.finished`); the turn-status endpoint must supply the terminal state.
 * - `error`: terminal `error` event (upstream/model failure).
 * - `never-connect`: the port is never listened on.
 */
function startMockServer(
  script: "complete" | "interrupted" | "error" | "never-connect",
): Promise<MockServer> {
  const requests: MockServer["requests"] = [];

  if (script === "never-connect") {
    // Bind an ephemeral port, note it, then release it without listening so
    // the address is genuinely refused afterwards.
    const probe = createServer();
    return new Promise<MockServer>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve({ base: `http://127.0.0.1:${port}`, requests, server: probe }));
      });
    });
  }

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    requests.push({ method: req.method ?? "GET", path });

    const segs = path.split("/").filter(Boolean);

    // GET /v1/capabilities
    if (req.method === "GET" && segs[1] === "capabilities") {
      sendJson(res, 200, {
        contractVersion: "v1",
        models: [MODEL],
        tools: ["bash"],
        features: ["sse"],
      });
      return;
    }

    // POST /v1/sessions
    if (req.method === "POST" && segs.length === 2 && segs[1] === "sessions") {
      sendJson(res, 201, {
        session: { id: "sess-1", status: "open", created_at: Date.now(), updated_at: Date.now() },
      });
      return;
    }

    // DELETE /v1/sessions/{id}
    if (req.method === "DELETE" && segs.length === 3 && segs[1] === "sessions") {
      sendJson(res, 200, {
        session: { id: segs[2], status: "closed", created_at: 1, updated_at: Date.now() },
      });
      return;
    }

    // GET /v1/sessions/{id}/turns/{turnId} — terminal turn state (recovery).
    if (
      req.method === "GET" &&
      segs.length === 5 &&
      segs[1] === "sessions" &&
      segs[3] === "turns"
    ) {
      sendJson(res, 200, {
        turn: {
          turnId: segs[4],
          status: "finished",
          stopReason: "stop",
          events: [
            { id: 1, type: "message.delta", version: 1, ts: 1, data: { text: "recovered" } },
            {
              id: 2,
              type: "turn.finished",
              version: 1,
              ts: 2,
              data: { turnId: segs[4], durationMs: 5 },
            },
          ],
        },
      });
      return;
    }

    // POST /v1/sessions/{id}/turns — SSE transcript.
    if (
      req.method === "POST" &&
      segs.length === 4 &&
      segs[1] === "sessions" &&
      segs[3] === "turns"
    ) {
      if (script === "error") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame("error", { code: "provider_error", message: "upstream exploded" }));
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(frame("turn.started", { turnId: "turn-1", model: MODEL, ts: 1 }));

      if (script === "interrupted") {
        // Tear the connection down mid-stream (no turn.finished) only after
        // the last frame has reached the kernel — destroying synchronously
        // right after write() can discard the queued bytes before transmit.
        res.write(frame("message.delta", { text: "partial " }), () => {
          res.socket?.destroy();
        });
        return;
      }

      res.write(frame("message.delta", { text: "Hello " }));
      res.write(frame("tool.call", { id: "c1", name: "bash", args: "{}" }));
      res.write(frame("tool.result", { id: "c1", name: "bash", ok: true, result: "ok" }));
      res.write(frame("message.delta", { text: "world" }));
      res.write(frame("turn.finished", { turnId: "turn-1", durationMs: 12, stopReason: "stop" }));
      res.end();
      return;
    }

    sendJson(res, 404, {
      error: { code: "invalid_request", message: `no route: ${req.method} ${path}` },
    });
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

function opts(base: string, stdout: Writable, stderr: Writable): RunClientOptions {
  return { baseUrl: base, model: MODEL, prompt: PROMPT, stdout, stderr };
}

async function run(base: string): Promise<RunResult> {
  const stdout = new Capture();
  const stderr = new Capture();
  return runClient(opts(base, stdout, stderr));
}

const servers: MockServer[] = [];

async function mock(
  script: "complete" | "interrupted" | "error" | "never-connect",
): Promise<MockServer> {
  const s = await startMockServer(script);
  servers.push(s);
  return s;
}

afterAll(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.server.close(() => resolve()))),
  );
});

describe("runClient request sequence", () => {
  it("walks capabilities → session → turn → close in order", async () => {
    const { base, requests } = await mock("complete");

    await run(base);

    const seq = requests.map((r) => `${r.method} ${r.path}`);
    const expected = [
      "GET /v1/capabilities",
      "POST /v1/sessions",
      "POST /v1/sessions/sess-1/turns",
      "DELETE /v1/sessions/sess-1",
    ];
    expect(seq).toEqual(expected);
  }, 15_000);
});

describe("runClient stream output", () => {
  it("writes concatenated message.delta text to stdout and tool activity to stderr", async () => {
    const { base } = await mock("complete");
    const stdout = new Capture();
    const stderr = new Capture();

    await runClient(opts(base, stdout, stderr));

    expect(stdout.text).toBe("Hello world");
    const logLines = stderr.text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const call = logLines.find((l) => l.event?.type === "tool.call");
    expect(call).toBeDefined();
    expect(call!.event.data).toMatchObject({ id: "c1", name: "bash", args: "{}" });
    const result = logLines.find((l) => l.event?.type === "tool.result");
    expect(result).toBeDefined();
    expect(result!.event.data).toMatchObject({ id: "c1", name: "bash", ok: true, result: "ok" });
    // Assistant transcript must not leak into the status stream.
    expect(stderr.text).not.toContain("Hello world");
  }, 15_000);

  it("still closes the session when the turn fails (exit code 1)", async () => {
    const { base, requests } = await mock("error");

    const stdout = new Capture();
    const stderr = new Capture();
    const result = await runClient(opts(base, stdout, stderr));

    expect(result.exitCode).toBe(1);
    expect(stderr.text.length).toBeGreaterThan(0);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toContain("DELETE /v1/sessions/sess-1");
  }, 15_000);
});

describe("runClient exit codes", () => {
  it("exits 0 on a successful turn", async () => {
    const { base } = await mock("complete");

    const result = await run(base);

    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
  }, 15_000);

  it("exits 1 when the server reports an error event", async () => {
    const { base } = await mock("error");

    const result = await run(base);

    expect(result.exitCode).toBe(1);
    expect(result.error).toBeTypeOf("string");
  }, 15_000);
});

describe("runClient unreachable server", () => {
  it("rejects with a friendly error mentioning `yog serve`", async () => {
    const { base } = await mock("never-connect");

    const stdout = new Capture();
    const stderr = new Capture();

    await expect(runClient(opts(base, stdout, stderr))).rejects.toThrow(/yog serve/);
  }, 15_000);

  it("still resolves with exit code 1 when told not to throw", async () => {
    const { base } = await mock("never-connect");

    const stdout = new Capture();
    const stderr = new Capture();
    const result = await runClient({ ...opts(base, stdout, stderr), throwOnError: false });

    expect(result.exitCode).toBe(1);
    expect(result.error).toMatch(/yog serve/);
    expect(stderr.text).toMatch(/yog serve/);
  }, 15_000);
});

describe("runClient turnId fallback", () => {
  it("recovers terminal state via GET /v1/sessions/{id}/turns/{turnId} when the stream is interrupted", async () => {
    const { base, requests } = await mock("interrupted");
    const stdout = new Capture();
    const stderr = new Capture();

    const result = await runClient(opts(base, stdout, stderr));

    const seq = requests.map((r) => `${r.method} ${r.path}`);
    // The client knows the turnId from turn.started and asks for its terminal state.
    expect(seq).toContain("GET /v1/sessions/sess-1/turns/turn-1");

    // The interrupted delta is kept, and the recovery endpoint supplies the rest.
    expect(stdout.text).toBe("partial recovered");
    expect(result.exitCode).toBe(0);
    expect(result.recoveredVia).toBe("turn-status");
  }, 15_000);
});
