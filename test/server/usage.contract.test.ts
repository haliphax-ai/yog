import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDaemon, type Daemon } from "../../src/server/serve.ts";
import { SessionStore } from "../../src/server/store/sessions.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** `Response.json()` with a loose type: assertions do the checking. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

const JSON_HEADERS = { "content-type": "application/json" };
const CAPABILITIES = {
  contractVersion: "v1",
  models: ["usage-model"],
  tools: ["bash"],
  features: ["sse", "transcript"],
};

/** Fake model (fallback path) that emits usage and round usage on tool results. */
function usageModel() {
  return {
    async runTurn(
      _sessionId: string,
      req: any,
      ctx: { emit: (ev: any) => Promise<void>; signal?: AbortSignal },
    ) {
      const messages = Array.isArray(req?.messages) ? req.messages : [];
      const turnId = "turn-usage";
      await ctx.emit({
        id: 1,
        type: "turn.started",
        version: 1,
        ts: Date.now(),
        data: { turnId, model: req.model ?? "usage-model", ts: Date.now() },
      });
      await ctx.emit({
        id: 2,
        type: "message.delta",
        version: 1,
        ts: Date.now(),
        data: { text: "checking" },
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
        data: {
          id: "c1",
          name: "bash",
          ok: true,
          result: { exitCode: 0 },
          usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        },
      });
      await ctx.emit({
        id: 5,
        type: "turn.finished",
        version: 1,
        ts: Date.now(),
        data: {
          turnId,
          durationMs: 3,
          usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        },
      });
      // §4.3: leave the caller's array complete before turn.finished.
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      });
      messages.push({
        role: "tool",
        tool_call_id: "c1",
        name: "bash",
        content: JSON.stringify({ exitCode: 0 }),
      });
    },
  };
}

let daemon: Daemon;
let base: string;
let store: SessionStore;
let storePath: string;

beforeAll(async () => {
  storePath = join(tmpdir(), `yog-usage-contract-${Date.now()}.db`);
  store = await SessionStore.open(storePath);
  daemon = await createDaemon({
    host: "127.0.0.1",
    port: 0,
    deps: { capabilities: CAPABILITIES, model: usageModel(), store },
  });
  base = daemon.url;
});

afterAll(async () => {
  await daemon?.close();
  store?.close();
});

async function newSession(): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, { method: "POST", headers: JSON_HEADERS });
  const { session } = await json(res);
  return session.id as string;
}

async function runTurn(id: string, prompt: string): Promise<void> {
  const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ prompt }),
  });
  expect(res.status).toBe(200);
  await res.text();
}

describe("conformance: per-turn usage + round usage on the wire", () => {
  it("transcript dump includes per-turn usage and no fabricated tool-row tokens", async () => {
    const id = await newSession();
    await runTurn(id, "do it");

    const res = await fetch(`${base}/v1/sessions/${id}/transcript`);
    const body = await json(res);
    const messages = body.messages as any[];
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);

    const toolRow = messages.find((m) => m.role === "tool");
    expect(toolRow.tokens).toBeUndefined();

    expect(Array.isArray(body.turns)).toBe(true);
    const turnMetric = body.turns[0];
    expect(turnMetric.turnId).toBeTypeOf("number");
    expect(turnMetric.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 22,
      total_tokens: 33,
    });
  });

  it("turn-status endpoint surfaces usage from the stored turn.finished event", async () => {
    const id = await newSession();
    await runTurn(id, "again");

    const res = await fetch(`${base}/v1/sessions/${id}/turns/turn-usage`);
    const body = await json(res);
    expect(body.turn.status).toBe("finished");
    expect(body.turn.usage).toEqual({ prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 });
    const finishedEvent = body.turn.events.find((e: any) => e.type === "turn.finished");
    expect(finishedEvent.data.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 22,
      total_tokens: 33,
    });
  });

  it("transcript has no turns array when no turn carries usage", async () => {
    const id = await newSession();
    const res = await fetch(`${base}/v1/sessions/${id}/transcript`);
    const body = await json(res);
    expect(body.turns).toBeUndefined();
  });
});
