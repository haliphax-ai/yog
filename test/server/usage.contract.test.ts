import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createDaemon, type Daemon, type DaemonOptions } from "../../src/server/serve.ts";
import { SessionStore } from "../../src/server/store/index.ts";
import { tools } from "../../src/register.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  orchestratorFromModel,
  runTurnToEnd,
  scriptedClient,
  sendMessage,
} from "../messages-helper.ts";

/** `Response.json()` with a loose type: assertions do the checking. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

const JSON_HEADERS = { "content-type": "application/json" };
const CAPABILITIES = {
  contractVersion: "v1",
  models: ["usage-model"],
  tools: ["bash"],
  features: ["messages", "stream", "transcript"],
};

/**
 * Engine script (one turn): a bash tool round whose final chunk carries the
 * round's real usage (it lands on tool.result AND the running total), then
 * a bare round whose usage chunk closes the turn on turn.finished — the
 * transcript ends with exactly (user, assistant tool_calls, tool). The
 * client is built per turn (the factory runs once per executeTurn call).
 */
function usageClientFactory() {
  return () =>
    scriptedClient([
      [
        {
          tool_calls: [
            {
              index: 0,
              id: "c1",
              function: { name: "bash", arguments: '{"command":"echo round"}' },
            },
          ],
          usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        },
      ],
      [{ usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } }],
    ]);
}

let daemon: Daemon;
let base: string;
let store: SessionStore;
let storePath: string;

beforeAll(async () => {
  storePath = join(tmpdir(), `yog-usage-contract-${Date.now()}.db`);
  store = await SessionStore.open(storePath);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const fake = orchestratorFromModel(usageClientFactory(), {
    store,
    bus,
    registry: tools,
    modelId: "usage-model",
    rateLimit: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
  });
  const opts: DaemonOptions = {
    host: "127.0.0.1",
    port: 0,
    deps: { capabilities: CAPABILITIES, orchestrator: fake.orchestrator, store, bus },
  };
  daemon = await createDaemon(opts);
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
  const { startRes, abort } = await runTurnToEnd(base, id, { prompt });
  abort();
  expect(startRes.status).toBe(202);
}
async function transcriptDump(id: string): Promise<any> {
  const res = await sendMessage(base, id, "transcript.get");
  expect(res.status).toBe(200);
  return (await json(res)).data;
}
async function turnGet(id: string, turnId: string): Promise<any> {
  const res = await sendMessage(base, id, "turn.get", { turnId });
  expect(res.status).toBe(200);
  return (await json(res)).data;
}

describe("conformance: per-turn usage + round usage on the wire", () => {
  it("transcript dump includes per-turn usage and no fabricated tool-row tokens", async () => {
    const id = await newSession();
    await runTurn(id, "do it");

    const body = await transcriptDump(id);
    const messages = body.messages as any[];
    const roles = messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);

    const toolRow = messages.find((m) => m.role === "tool");
    expect(toolRow.tokens).toBeUndefined();
    // Round attribution rides the tool result row itself — the same
    // usage/promptDelta the live tool.result envelope carried — so
    // rehydration renders the same per-result counts as the live stream.
    expect(toolRow.usage).toEqual({
      prompt_tokens: 11,
      completion_tokens: 22,
      total_tokens: 33,
    });

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

    const body = await turnGet(id, "any");
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
    const body = await transcriptDump(id);
    expect(body.turns).toBeUndefined();
  });

  it("tool rows without a stored tool.result round omit usage/promptDelta", async () => {
    // No-usage path: the fake model only emits usage on some turns. Seed a
    // tool row directly (pre-usage legacy shape) and assert the dump leaves
    // round attribution off rather than inventing it.
    const id = await newSession();
    const turn = (await store.addTurn(id, {
      role: "user",
      content: "legacy",
      status: "finished",
    })) as any;
    await store.appendMessages(id, [
      {
        role: "tool",
        tool_call_id: "legacy-1",
        name: "bash",
        content: "{}",
      } as any,
    ]);
    await store.finishTurn(id, turn.id, "finished");

    const body = await transcriptDump(id);
    const toolRow = (body.messages as any[]).find((m) => m.role === "tool");
    expect(toolRow).toBeDefined();
    expect(toolRow.usage).toBeUndefined();
    expect(toolRow.promptDelta).toBeUndefined();
  });
});
