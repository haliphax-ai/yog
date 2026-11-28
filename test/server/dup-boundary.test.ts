import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createDaemon, type DaemonOptions } from "../../src/server/serve.ts";
import { SessionStore } from "../../src/server/store/index.ts";
import { tools } from "../../src/register.ts";
import { createPreludeSink } from "../../src/server/daemon/prelude.ts";
import {
  openStream,
  orchestratorFromModel,
  runTurnToEnd,
  scriptedClient,
  sendMessage,
} from "../messages-helper.ts";

/** Scripted single-round client: every turn answers "ack" with no tools. */
function ackClientFactory(): (sid: string) => any {
  return () => scriptedClient([[{ content: "ack" }]]);
}

let dir: string;
let store: SessionStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-dup-"));
  store = await SessionStore.open(join(dir, "sessions.db"));
});

afterAll(async () => {
  store?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

function buildDaemon(
  fake: ReturnType<typeof orchestratorFromModel>,
  prelude: any,
  bus = new EventEmitter(),
) {
  bus.setMaxListeners(0);
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
      store,
      orchestrator: fake.orchestrator,
      bus,
    },
  };
  return createDaemon(opts);
}

async function newSession(url: string): Promise<string> {
  const res = await fetch(`${url}/v1/sessions`, { method: "POST" });
  const body = (await res.json()) as { session?: { id?: string } };
  return body.session!.id!;
}

describe("batch boundary: no re-persisted prior row", () => {
  it(
    "a user turn's batch starts at its prompt, not a copy of the prior prose",
    { timeout: 30_000 },
    async () => {
      const bus = new EventEmitter();
      bus.setMaxListeners(0);
      const prelude = createPreludeSink();
      const fake = orchestratorFromModel(ackClientFactory(), {
        store,
        bus,
        registry: tools,
        modelId: "fake-model",
        prelude,
      });
      const daemon = await buildDaemon(fake, prelude, bus);
      try {
        const sid = await newSession(daemon.url);
        await runTurnToEnd(daemon.url, sid, { prompt: "first" });
        await runTurnToEnd(daemon.url, sid, { prompt: "second" });
        const transcript = await store.getTranscript(sid);
        const contents = transcript.map((m: any) => `${m.role}:${m.content ?? ""}`);
        // Expected: user:first, assistant:ack, user:second, assistant:ack.
        expect(contents).toEqual(["user:first", "assistant:ack", "user:second", "assistant:ack"]);
      } finally {
        await daemon.close();
      }
    },
  );

  it(
    "a wake turn's batch is [pair, prompt, rounds, prose] — no prior-row copy",
    { timeout: 30_000 },
    async () => {
      const bus = new EventEmitter();
      bus.setMaxListeners(0);
      const prelude = createPreludeSink();
      const fake = orchestratorFromModel(ackClientFactory(), {
        store,
        bus,
        registry: tools,
        modelId: "fake-model",
        prelude,
      });
      const daemon = await buildDaemon(fake, prelude, bus);
      try {
        const sid = await newSession(daemon.url);
        await runTurnToEnd(daemon.url, sid, { prompt: "first" });
        prelude.push(sid, "kind-x", "notice body");
        await runTurnToEnd(daemon.url, sid, { prompt: "second" });
        const transcript = await store.getTranscript(sid);
        const shapes = transcript.map(
          (m: any) =>
            m.role +
            (Array.isArray(m.tool_calls) && m.tool_calls[0]?.function?.name === "harness_notice"
              ? ":pair-call"
              : ""),
        );
        // Expected: user, assistant, pair-call, tool, user(prompt), assistant.
        expect(shapes).toEqual([
          "user",
          "assistant",
          "assistant:pair-call",
          "tool",
          "user",
          "assistant",
        ]);
      } finally {
        await daemon.close();
      }
    },
  );
});
