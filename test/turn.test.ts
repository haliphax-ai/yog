import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { z } from "zod";
import { TurnEngine } from "../src/turn.ts";
import { RecordingSink, StdoutSink, type TurnEvent } from "../src/turn/sink.ts";
import { ToolRegistry, type ToolSpec } from "../src/toolkit/index.ts";

/** Shape of one streaming chunk as the engine consumes it. */
interface FakeDelta {
  content?: string;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface FakeChunk {
  choices: { delta: FakeDelta }[];
}

/**
 * Fake OpenAI client: each `create` call replays the next round's chunks as
 * an async stream, mirroring how the engine drives the real SDK.
 */
function fakeClient(rounds: FakeChunk[][], opts: { failOn?: number } = {}): OpenAI {
  let calls = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const round = calls++;
          if (opts.failOn === round) throw new Error("provider exploded");
          const chunks = rounds[round] ?? [];
          return (async function* () {
            for (const chunk of chunks) yield chunk;
          })();
        },
      },
    },
  } as unknown as OpenAI;
}

/** Echo tool used by the fake registry; returns a deterministic result. */
const echoTool: ToolSpec<{ text: string }> = {
  name: "echo",
  description: "Echo text back.",
  schema: z.object({ text: z.string() }).strict(),
  failure: (error) => ({ error }),
  run: async (args) => ({ echo: args["text"], exitCode: 0, runtimeMs: 1 }),
};

const registry = new ToolRegistry([echoTool]);

function userMessages(): ChatCompletionMessageParam[] {
  return [{ role: "user", content: "hi" }];
}

/** Round 1 streams text + an accumulated tool call; round 2 streams text. */
const scriptRounds: FakeChunk[][] = [
  [
    { choices: [{ delta: { content: "Hello" } }] },
    { choices: [{ delta: { content: " world" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_1", function: { name: "echo", arguments: '{"text"' } },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"hi"}' } }] } }] },
  ],
  [{ choices: [{ delta: { content: "Done" } }] }],
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TurnEngine event sequence", () => {
  it("emits the full ordered sequence with monotonic ids and contract envelopes", async () => {
    const sink = new RecordingSink();
    const messages = userMessages();

    await new TurnEngine(sink).run(fakeClient(scriptRounds), "test-model", messages, registry);

    const events = sink.events;
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "message.delta",
      "message.delta",
      "tool.call",
      "tool.result",
      "message.delta",
      "turn.finished",
    ]);

    // Envelope contract: monotonic per-turn ids, version 1, fresh timestamps.
    expect(events.map((e) => e.id)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.id).toBeGreaterThan(events[i - 1]!.id);
    }
    expect(events.every((e) => e.version === 1)).toBe(true);
    expect(events.every((e) => typeof e.ts === "number" && e.ts > 0)).toBe(true);

    const started = events[0]!;
    const rest = events.slice(1);
    expect(started.type).toBe("turn.started");
    if (started.type !== "turn.started") throw new Error("first event must be turn.started");
    expect(started.data.model).toBe("test-model");
    expect(started.data.turnId).toMatch(/^[0-9A-Za-z]{22}$/);

    expect(
      rest.filter((e) => e.type === "message.delta").map((e) => (e.data as { text: string }).text),
    ).toEqual(["Hello", " world", "Done"]);

    const call = events.find((e) => e.type === "tool.call")!;
    expect(call).toMatchObject({
      data: { id: "call_1", name: "echo", args: '{"text":"hi"}' },
    });

    const result = events.find((e) => e.type === "tool.result")!;
    expect(result).toMatchObject({ data: { id: "call_1", name: "echo", ok: true } });
    if (result.type === "tool.result") {
      expect(result.data.error).toBeUndefined();
      expect(result.data.result).toMatchObject({ echo: "hi", exitCode: 0 });
    }

    const finished = events.at(-1)!;
    expect(finished.type).toBe("turn.finished");
    if (finished.type === "turn.finished") {
      expect(finished.data.turnId).toBe(started.data.turnId);
      expect(finished.data.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("preserves the [tool] stderr diagnostic and the message replay", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const sink = new RecordingSink();
    const messages = userMessages();

    await new TurnEngine(sink).run(fakeClient(scriptRounds), "test-model", messages, registry);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/^\[tool] echo\(\{"text":"hi"\}\) -> /),
    );

    // Assistant replay + tool result are appended exactly as before.
    expect(messages).toHaveLength(3);
    const assistant = messages[1]!;
    expect(assistant.role).toBe("assistant");
    if (assistant.role === "assistant" && assistant.tool_calls) {
      expect(assistant.tool_calls[0]).toMatchObject({
        id: "call_1",
        function: { name: "echo", arguments: '{"text":"hi"}' },
      });
    }
    const toolMsg = messages[2]!;
    expect(toolMsg.role).toBe("tool");
    if (toolMsg.role === "tool") {
      expect(toolMsg.tool_call_id).toBe("call_1");
      expect(JSON.parse(toolMsg.content as string)).toMatchObject({ echo: "hi" });
    }
  });
});

describe("TurnEngine failure handling", () => {
  it("emits an error event when the provider throws, then rethrows", async () => {
    const sink = new RecordingSink();

    await expect(
      new TurnEngine(sink).run(
        fakeClient([], { failOn: 0 }),
        "test-model",
        userMessages(),
        registry,
      ),
    ).rejects.toThrow("provider exploded");

    expect(sink.events.map((e) => e.type)).toEqual(["turn.started", "error"]);
    const errorEvent = sink.events[1]!;
    expect(errorEvent.id).toBeGreaterThan(sink.events[0]!.id);
    if (errorEvent.type === "error") {
      expect(errorEvent.data.code).toBe("provider_error");
      expect(errorEvent.data.message).toBe("provider exploded");
    }
    expect(sink.events.some((e) => e.type === "turn.finished")).toBe(false);
  });

  it("propagates an in-flight abort without emitting a terminal error", async () => {
    const sink = new RecordingSink();
    const controller = new AbortController();
    const abortError = new Error("The operation was aborted");

    const abortClient: OpenAI = {
      chat: {
        completions: {
          create: () =>
            (async function* () {
              yield { choices: [{ delta: { content: "partial" } }] } satisfies FakeChunk;
              // Hang until the signal fires, then fail like the real SDK.
              await new Promise((_resolve, reject) => {
                if (controller.signal.aborted) reject(abortError);
                else
                  controller.signal.addEventListener("abort", () => reject(abortError), {
                    once: true,
                  });
              });
            })(),
        },
      },
    } as unknown as OpenAI;

    const running = new TurnEngine(sink).run(abortClient, "test-model", userMessages(), registry, {
      signal: controller.signal,
    });
    const assertion = expect(running).rejects.toBe(abortError);

    // Wait until the engine has started and streamed the first delta, then abort.
    await vi.waitFor(() =>
      expect(sink.events.map((e) => e.type)).toEqual(["turn.started", "message.delta"]),
    );
    controller.abort();
    await assertion;

    // Abort is not a provider error: no `error` event, no `turn.finished`.
    expect(sink.events.map((e) => e.type)).toEqual(["turn.started", "message.delta"]);
  });
});

describe("StdoutSink output parity", () => {
  it("writes byte-identical stdout text: deltas concatenated, one trailing newline", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    await new TurnEngine(new StdoutSink()).run(
      fakeClient(scriptRounds),
      "test-model",
      userMessages(),
      registry,
    );

    expect(out.join("")).toBe("Hello worldDone\n");
  });

  it("StdoutSink ignores non-renderable events", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    const sink = new StdoutSink();
    const base = { id: 0, version: 1, ts: Date.now() };
    await sink.emit({ ...base, type: "turn.started", data: { turnId: "t", model: "m", ts: 1 } });
    await sink.emit({ ...base, type: "tool.call", data: { id: "c", name: "echo", args: "{}" } });
    await sink.emit({ ...base, type: "tool.result", data: { id: "c", name: "echo", ok: true } });
    await sink.emit({ ...base, type: "error", data: { code: "internal", message: "boom" } });
    expect(out).toEqual([]);
  });
});

describe("RecordingSink", () => {
  it("captures the event sequence in arrival order", async () => {
    const sink = new RecordingSink();
    const events: TurnEvent[] = [
      { id: 0, type: "turn.started", version: 1, ts: 1, data: { turnId: "t", model: "m", ts: 1 } },
      { id: 1, type: "message.delta", version: 1, ts: 2, data: { text: "x" } },
    ];
    for (const ev of events) await sink.emit(ev);
    expect(sink.events).toEqual(events);
  });
});
