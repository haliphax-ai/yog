import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createDaemon, type DaemonOptions } from "../../src/server/serve.ts";
import { SessionStore } from "../../src/server/store/index.ts";
import { tools } from "../../src/register.ts";
import { createPreludeSink, HARNESS_NOTICE_TOOL } from "../../src/server/daemon/prelude.ts";
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
  dir = await mkdtemp(join(tmpdir(), "yog-prelude-"));
  store = await SessionStore.open(join(dir, "sessions.db"));
});

afterAll(async () => {
  store?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

/**
 * Build a daemon whose adapter bus and the fake's publish bus are THE SAME
 * EventEmitter (one shared bus per build) — otherwise the wire never sees
 * the turn's frames.
 */
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

async function newSession(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return ((await res.json()) as { session: { id: string } }).session.id;
}

describe("harness_notice prelude delivery (turn runner)", () => {
  it(
    "lands the notice pair between the prior transcript and the prompt",
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
        // First turn: establishes prior transcript ("one").
        await runTurnToEnd(daemon.url, sid, { prompt: "one" });
        // Queue notices while idle.
        prelude.push(sid, "background-jobs", "job A finished");
        prelude.push(sid, "background-jobs", "job B failed");
        // Second turn: the hydrated messages must carry the pair before "two".
        await runTurnToEnd(daemon.url, sid, { prompt: "two" });
        const call2 = fake.calls[1]!;
        // The notice pair sits between the prior transcript and the prompt:
        // indexes are prior..., call, result, user(prompt), assistant(ack).
        const resultIdx = call2.messages.findIndex((m: any) => m.role === "tool");
        expect(resultIdx).toBeGreaterThan(0);
        const callIdx = resultIdx - 1;
        const pairCall = call2.messages[callIdx] as any;
        expect(pairCall.tool_calls).toHaveLength(1);
        expect(pairCall.tool_calls[0].function.name).toBe(HARNESS_NOTICE_TOOL);
        expect(pairCall.tool_calls[0].function.arguments).toBe("{}");
        const pairResult = call2.messages[resultIdx] as any;
        expect(pairResult.tool_call_id).toBe(pairCall.tool_calls[0].id);
        const payload = JSON.parse(pairResult.content);
        expect(payload.hint).toContain("synthetic harness message");
        expect(payload.notices).toEqual([
          { kind: "background-jobs", body: "job A finished" },
          { kind: "background-jobs", body: "job B failed" },
        ]);
        // The user's prompt row stays pure: the hydrated tail is user(prompt)
        // followed by the model's terminal ack (the array mutates in place).
        const tail = call2.messages.slice(-2) as any[];
        expect(tail[0]!.role).toBe("user");
        expect(tail[0]!.content).toBe("two");
        expect(tail[1]!.role).toBe("assistant");
        // The queue drained once: the queued notices are gone.
        expect(prelude.drain(sid)).toBeUndefined();
      } finally {
        await daemon.close();
      }
    },
  );

  it(
    "delivers no pair when the queue is empty (default path unchanged)",
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
        await runTurnToEnd(daemon.url, sid, { prompt: "plain" });
        const call = fake.calls[0]!;
        expect(call.messages.some((m: any) => m.role === "tool")).toBe(false);
        // The engine mutates the array in place, so its tail is the final
        // assistant ack; the prompt row is the user row before it.
        expect(call.messages[call.messages.length - 1]).toEqual({
          role: "assistant",
          content: "ack",
        });
        expect(call.messages[call.messages.length - 2]).toEqual({
          role: "user",
          content: "plain",
        });
        expect(call.messages[0]).toEqual({ role: "user", content: "plain" });
      } finally {
        await daemon.close();
      }
    },
  );

  it("persists the pair under the turn id (it rides the batch)", { timeout: 30_000 }, async () => {
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
      const contents = transcript.map((m: any) => m.role);
      // The stored transcript now contains the notice pair exactly once.
      const noticeCalls = transcript.filter(
        (m: any) =>
          m.role === "assistant" &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls[0]?.function?.name === HARNESS_NOTICE_TOOL,
      );
      expect(noticeCalls).toHaveLength(1);
      const idx = transcript.indexOf(noticeCalls[0]);
      const answer = transcript[idx + 1] as any;
      expect(answer.role).toBe("tool");
      expect(answer.tool_call_id).toBe(noticeCalls[0].tool_calls[0].id);
      // Order: ...prior..., notice call, notice result, user prompt, assistant ack.
      expect(contents.slice(idx)).toEqual(["assistant", "tool", "user", "assistant"]);
      // An unanswered-call scan over the stored transcript is clean.
      const { unansweredToolCallIds } = await import("../../src/turn/index.ts");
      expect(unansweredToolCallIds(transcript as any).size).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it(
    "pins the pair's turn_events under the delivering turn, not the previous one",
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
        const second = await runTurnToEnd(daemon.url, sid, { prompt: "second" });
        const turns = await store.listTurns(sid);
        const prev = turns[0] as { id: number };
        const delivering = turns[1] as { id: number };
        // The pair rode the batch: the transcript rows carry the
        // delivering turn's id (not the previous turn's).
        const transcript = await store.getTranscript(sid);
        const call = transcript.find(
          (m: any) =>
            m.role === "assistant" &&
            Array.isArray(m.tool_calls) &&
            m.tool_calls[0]?.function?.name === HARNESS_NOTICE_TOOL,
        ) as any;
        expect(call.turnId).toBe(delivering.id);
        expect(call.turnId).not.toBe(prev.id);
        // The persisted event frames (publishPrelude) sit under the
        // delivering turn too — the replay-on-connect path filters by
        // turn id, so a misplaced row is invisible to reconnects.
        const events = await store.listEvents(sid);
        const pairEvents = events.filter((e: any) => e.turn_id === delivering.id);
        expect(pairEvents.some((e: any) => e.type === "turn.started")).toBe(true);
        // The previous turn holds ONLY its own events — no stray
        // harness_notice pair rows.
        const prevEvents = events.filter((e: any) => e.turn_id === prev.id);
        expect(
          prevEvents.some(
            (e: any) => e.type === "tool.call" && JSON.stringify(e.payload).includes("call_hn_"),
          ),
        ).toBe(false);
        void second;
      } finally {
        await daemon.close();
      }
    },
  );

  it(
    "keeps the delivered pair when the turn unwinds (never re-delivers)",
    { timeout: 30_000 },
    async () => {
      const failBus = new EventEmitter();
      failBus.setMaxListeners(0);
      const prelude = createPreludeSink();
      let turnNo = 0;
      const fake = orchestratorFromModel(
        () => {
          turnNo += 1;
          // Turn 1 unwinds mid-stream (the pair must survive); turn 2 acks.
          return scriptedClient(turnNo === 1 ? [[{ content: "part" }]] : [[{ content: "ack" }]], {
            failOn: 1,
            failCode: "rate_limited",
            failMessage: "boom",
          });
        },
        {
          store,
          bus: failBus,
          registry: tools,
          modelId: "fake-model",
          rateLimit: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
          prelude,
        },
      );
      const daemon = await buildDaemon(fake, prelude, failBus);
      try {
        const sid = await newSession(daemon.url);
        prelude.push(sid, "kind-u", "one shot");
        // Turn 1 fails at round 2 — the settled batch still carries the pair.
        const stream = await openStream(daemon.url, sid);
        const r = await sendMessage(daemon.url, sid, "turn.start", { prompt: "go" });
        expect(r.status).toBe(202);
        await r.json();
        await stream.collectUntil((fs) => fs.some((f) => f.event === "error"), 10_000);
        stream.abort();
        const transcript = await store.getTranscript(sid);
        const noticeCalls = transcript.filter(
          (m: any) =>
            m.role === "assistant" &&
            Array.isArray(m.tool_calls) &&
            m.tool_calls[0]?.function?.name === HARNESS_NOTICE_TOOL,
        );
        expect(noticeCalls).toHaveLength(1);
        // Nothing re-queued: the notice is not delivered again on turn 2.
        await runTurnToEnd(daemon.url, sid, { prompt: "again" });
        const transcript2 = await store.getTranscript(sid);
        const noticeCalls2 = transcript2.filter(
          (m: any) =>
            m.role === "assistant" &&
            Array.isArray(m.tool_calls) &&
            m.tool_calls[0]?.function?.name === HARNESS_NOTICE_TOOL,
        );
        expect(noticeCalls2).toHaveLength(1);
      } finally {
        await daemon.close();
      }
    },
  );
});

describe("wake-turn marker (the jobs manager turn row)", () => {
  it(
    "persists wake: true on the turn row and surfaces it through transcript.get",
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
        await runTurnToEnd(daemon.url, sid, { prompt: "normal" });
        // The wake turn: same executeTurn path, with the wake marker.
        await runTurnToEnd(daemon.url, sid, { prompt: "[background jobs] 1 finished", wake: true });
        const turns = await store.listTurns(sid);
        expect(turns).toHaveLength(2);
        expect(turns[0]!.request.wake).toBeUndefined();
        expect(turns[1]!.request.wake).toBe(true);
        // The transcript dump carries the marker on the wake turn only.
        const dump = (
          (await (await sendMessage(daemon.url, sid, "transcript.get")).json()) as {
            data?: { turns?: Array<{ turnId: number; wake?: boolean }> };
          }
        ).data;
        expect(dump!.turns).toHaveLength(2);
        expect(dump!.turns![0]!.wake).toBeUndefined();
        expect(dump!.turns![1]!.wake).toBe(true);
      } finally {
        await daemon.close();
      }
    },
  );
});
