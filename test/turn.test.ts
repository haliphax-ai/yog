import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { z } from "zod";
import { TurnEngine } from "../src/turn.ts";
import { RecordingSink, StdoutSink, type TurnEvent, type TurnUsage } from "../src/turn/sink.ts";
import { ToolRegistry, type ToolSpec } from "../src/toolkit/index.ts";
import { logger } from "../src/log.ts";

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
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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

  it("preserves the [tool] structured log diagnostic and the message replay", async () => {
    const errSpy = vi.spyOn(logger, "error");
    const sink = new RecordingSink();
    const messages = userMessages();

    await new TurnEngine(sink).run(fakeClient(scriptRounds), "test-model", messages, registry);

    expect(errSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "echo",
        args: '{"text":"hi"}',
        ok: true,
      }),
      expect.stringMatching(/^\[tool\] echo\(\{"text":"hi"\}\) -> /),
    );

    // Assistant replay + tool result are appended exactly as before.
    // Assistant replay + tool result are appended exactly as before, and the
    // final no-tool round's text is now appended too (plan §4.3).
    expect(messages).toHaveLength(4);
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
    const finalAssistant = messages[3]!;
    expect(finalAssistant.role).toBe("assistant");
    if (finalAssistant.role === "assistant") {
      expect(finalAssistant.content).toBe("Done");
      expect(finalAssistant.tool_calls).toBeUndefined();
      // The intermediate tool_calls row is untouched.
      const intermediate = messages[1]!;
      expect(intermediate.role).toBe("assistant");
      if (intermediate.role === "assistant" && intermediate.tool_calls) {
        expect(intermediate.tool_calls).toHaveLength(1);
      }
    }
  });
});

it("appends the final assistant text message on the no-tool-calls path", async () => {
  const sink = new RecordingSink();
  const messages = userMessages();

  // Single round, no tools: the model answers with text.
  const rounds: FakeChunk[][] = [
    [
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
    ],
  ];

  await new TurnEngine(sink).run(fakeClient(rounds), "test-model", messages, registry);

  // The caller's array now ends with the accumulated assistant text.
  expect(messages).toHaveLength(2);
  const last = messages[1]!;
  expect(last.role).toBe("assistant");
  if (last.role === "assistant") {
    expect(last.content).toBe("Hello world");
    expect(last.tool_calls).toBeUndefined();
  }

  // turn.finished is emitted AFTER the append (the caller diffs by index).
  const finished = sink.events.find((e) => e.type === "turn.finished")!;
  expect(finished).toBeDefined();
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

    // Abort is not a provider error: no `error` event, no `turn.finished` —
    // and the engine does NOT emit `turn.aborted` either: the abort is hard,
    // the adapter (or the CLI shell) frames the terminal event itself, so a
    // late engine event can never leak onto the next turn's stream.
    expect(sink.events.map((e) => e.type)).toEqual(["turn.started", "message.delta"]);
    expect(sink.events.some((e) => e.type === "error")).toBe(false);
    expect(sink.events.some((e) => e.type === "turn.aborted")).toBe(false);
  });
});

describe("TurnEngine maxRounds cap", () => {
  /** Endless tool-calling model: every round calls `echo`, never finishes. */
  function toolLoopClient(): OpenAI {
    return {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_loop",
                          function: { name: "echo", arguments: '{"text":"hi"}' },
                        },
                      ],
                    },
                  },
                ],
              };
            })(),
        },
      },
    } as unknown as OpenAI;
  }

  it("emits turn.finished with stopReason max_rounds when the cap is exhausted", async () => {
    const sink = new RecordingSink();
    const messages = userMessages();

    await new TurnEngine(sink).run(toolLoopClient(), "test-model", messages, registry, {
      maxRounds: 3,
    });

    const events = sink.events;
    expect(events[0]!.type).toBe("turn.started");
    // Three tool rounds execute (call+result each), then the terminal event.
    expect(events.filter((e) => e.type === "tool.call")).toHaveLength(3);
    expect(events.filter((e) => e.type === "tool.result")).toHaveLength(3);
    const last = events.at(-1)!;
    expect(last.type).toBe("turn.finished");
    if (last.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(last.data.stopReason).toBe("max_rounds");
    // The transcript keeps every executed round (hydratable for the next turn).
    const toolRows = messages.filter((m) => (m as { role?: string }).role === "tool");
    expect(toolRows).toHaveLength(3);
  });

  it("emits turn.finished without a stopReason on natural completion", async () => {
    const sink = new RecordingSink();
    await new TurnEngine(sink).run(
      fakeClient(scriptRounds),
      "test-model",
      userMessages(),
      registry,
    );
    const finished = sink.events.find((e) => e.type === "turn.finished");
    expect(finished).toBeDefined();
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.stopReason).toBeUndefined();
  });
});

describe("TurnEngine token usage", () => {
  it("requests usage from the model via stream_options.include_usage", async () => {
    let createOptions: unknown;
    const client = {
      chat: {
        completions: {
          create: async (opts: unknown) => {
            createOptions = opts;
            return (async function* () {
              yield { choices: [{ delta: { content: "Hello" } }] } satisfies FakeChunk;
            })();
          },
        },
      },
    } as unknown as OpenAI;
    const sink = new RecordingSink();
    await new TurnEngine(sink).run(client, "test-model", userMessages(), registry);
    expect(createOptions).toMatchObject({ stream_options: { include_usage: true } });
  });

  it("emits turn.finished.usage when the provider sends an usage-bearing final chunk", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        { choices: [{ delta: { content: "Hello" } }] },
        {
          choices: [{ delta: { content: "" } }],
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
        },
      ],
    ];
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", userMessages(), registry);
    const finished = sink.events.find((e) => e.type === "turn.finished");
    expect(finished?.type).toBe("turn.finished");
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
    });
  });

  it("omits usage from turn.finished when the provider sends none", async () => {
    const sink = new RecordingSink();
    await new TurnEngine(sink).run(
      fakeClient(scriptRounds),
      "test-model",
      userMessages(),
      registry,
    );
    const finished = sink.events.find((e) => e.type === "turn.finished");
    expect(finished?.type).toBe("turn.finished");
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.usage).toBeUndefined();
  });

  it("aggregates usage across rounds, keeping fields the final round omits", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "echo", arguments: '{"text":"hi"}' },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        },
      ],
      [
        {
          choices: [{ delta: { content: "Done" } }],
          usage: { total_tokens: 200 },
        },
      ],
    ];
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", userMessages(), registry);
    const finished = sink.events.find((e) => e.type === "turn.finished");
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 200,
    });
  });

  it("emits usage on the max_rounds terminal path", async () => {
    const sink = new RecordingSink();
    const loopClient: OpenAI = {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_loop",
                          function: { name: "echo", arguments: '{"text":"hi"}' },
                        },
                      ],
                    },
                  },
                ],
                usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
              } satisfies FakeChunk;
            })(),
        },
      },
    } as unknown as OpenAI;
    await new TurnEngine(sink).run(loopClient, "test-model", userMessages(), registry, {
      maxRounds: 2,
    });
    const finished = sink.events.find((e) => e.type === "turn.finished");
    expect(finished?.type).toBe("turn.finished");
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.stopReason).toBe("max_rounds");
    expect(finished.data.usage).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
    });
  });
});

describe("StdoutSink output parity", () => {
  it("writes byte-identical stdout text: deltas concatenated, one trailing newline", async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

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

describe("TurnEngine per-tool-call token attribution", () => {
  it("stamps the round's real usage (not an estimate) on tool.result events", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "echo", arguments: '{"text":"a"}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: "call_2", function: { name: "echo", arguments: '{"text":"b"}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { content: "" } }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        },
      ],
      [{ choices: [{ delta: { content: "Done" } }] }],
    ];
    const messages = userMessages();
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", messages, registry);
    const results = sink.events.filter((e) => e.type === "tool.result");
    expect(results).toHaveLength(2);
    for (const r of results) {
      if (r.type !== "tool.result") throw new Error("expected tool.result");
      // Round attribution, not per-call: identical real usage on both calls.
      expect(r.data.usage).toEqual({ prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 });
      // First round of a turn has no previous round to diff against.
      expect(r.data.promptDelta).toBeUndefined();
    }
    const finished = sink.events.find((e) => e.type === "turn.finished");
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.usage).toEqual({
      prompt_tokens: 5,
      completion_tokens: 10,
      total_tokens: 15,
    });
  });

  it("reports the prompt delta between consecutive rounds", async () => {
    const rounds: FakeChunk[][] = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "echo", arguments: '{"text":"a"}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { content: "" } }],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        },
      ],
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_2", function: { name: "echo", arguments: '{"text":"b"}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { content: "" } }],
          usage: { prompt_tokens: 160, completion_tokens: 6, total_tokens: 166 },
        },
      ],
      [{ choices: [{ delta: { content: "Done" } }] }],
    ];
    const sink = new RecordingSink();
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", userMessages(), registry);
    const results = sink.events.filter((e) => e.type === "tool.result");
    expect(results).toHaveLength(2);
    if (results[0]?.type !== "tool.result") throw new Error("expected tool.result");
    if (results[1]?.type !== "tool.result") throw new Error("expected tool.result");
    expect(results[0].data.promptDelta).toBeUndefined();
    expect(results[1].data.promptDelta).toBe(60);
    // Each round carries its own real usage, not the turn total.
    expect(results[0].data.usage?.prompt_tokens).toBe(100);
    expect(results[1].data.usage?.prompt_tokens).toBe(160);
  });

  it("omits usage when the provider sends none", async () => {
    const sink = new RecordingSink();
    await new TurnEngine(sink).run(
      fakeClient(scriptRounds),
      "test-model",
      userMessages(),
      registry,
    );
    const results = sink.events.filter((e) => e.type === "tool.result");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      if (r.type !== "tool.result") continue;
      expect(r.data.usage).toBeUndefined();
      expect(r.data.promptDelta).toBeUndefined();
    }
  });

  it("does not persist fabricated per-call token fields on tool messages", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "echo", arguments: '{"text":"a"}' } },
                ],
              },
            },
          ],
        },
        {
          choices: [{ delta: { content: "" } }],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        },
      ],
      [{ choices: [{ delta: { content: "Done" } }] }],
    ];
    const messages = userMessages();
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", messages, registry);
    const toolMsg = messages.find((m) => m.role === "tool") as unknown as {
      tokens?: number;
    };
    expect(toolMsg?.tokens).toBeUndefined();
  });
});

describe("TurnEngine onUsage (cut-point usage)", () => {
  it("reports accumulated usage as it arrives on a normal finish", async () => {
    const seen: TurnUsage[] = [];
    const rounds: FakeChunk[][] = [
      [
        {
          choices: [{ delta: { content: "Hi" } }],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        },
      ],
    ];
    await new TurnEngine(new RecordingSink()).run(
      fakeClient(rounds),
      "test-model",
      userMessages(),
      registry,
      {
        onUsage: (u) => void seen.push(u),
      },
    );
    expect(seen).toEqual([{ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }]);
  });

  it("captures usage at the cut point when the turn aborts mid-stream", async () => {
    const seen: TurnUsage[] = [];
    const client = {
      chat: {
        completions: {
          create: (args: { signal?: AbortSignal }) =>
            (async function* () {
              yield {
                choices: [{ delta: { content: "x" } }],
                usage: { total_tokens: 20 },
              } satisfies FakeChunk;
              await new Promise<void>((_resolve, reject) => {
                if (args.signal?.aborted) {
                  reject(new Error("aborted"));
                  return;
                }
                args.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
              });
            })(),
        },
      },
    } as unknown as OpenAI;
    const ac = new AbortController();
    const runPromise = new TurnEngine(new RecordingSink()).run(
      client,
      "test-model",
      userMessages(),
      registry,
      {
        signal: ac.signal,
        isAborted: () => ac.signal.aborted,
        onUsage: (u) => void seen.push(u),
      },
    );
    setTimeout(() => ac.abort(), 20);
    await expect(runPromise).rejects.toThrow("aborted");
    expect(seen.at(-1)).toEqual({ total_tokens: 20 });
  });
});

describe("TurnEngine abort of an active tool call (issue #35)", () => {
  /** Tool that never settles: only an abort can unwind its call. */
  const hangingTool: ToolSpec<{ text: string }> = {
    name: "echo",
    description: "Hang forever.",
    schema: z.object({ text: z.string() }).strict(),
    failure: (error) => ({ error }),
    run: async () => new Promise<Record<string, unknown>>(() => undefined),
  };
  const hangingRegistry = new ToolRegistry([hangingTool]);

  function toolCallClient(ids: string[]): OpenAI {
    return {
      chat: {
        completions: {
          create: async () =>
            (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: ids.map((id, i) => ({
                        index: i,
                        id,
                        function: { name: "echo", arguments: '{"text":"hi"}' },
                      })),
                    },
                  },
                ],
              };
            })(),
        },
      },
    } as unknown as OpenAI;
  }

  function danglingIds(messages: ChatCompletionMessageParam[]): string[] {
    const announced = new Set<string>();
    for (const m of messages) {
      const rec = m as { role?: string; tool_calls?: Array<{ id?: string }> };
      if (rec.role === "assistant" && Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls) {
          if (typeof tc?.id === "string") announced.add(tc.id);
        }
      }
    }
    for (const m of messages) {
      const rec = m as { role?: string; tool_call_id?: string };
      if (rec.role === "tool" && typeof rec.tool_call_id === "string") {
        announced.delete(rec.tool_call_id);
      }
    }
    return [...announced];
  }

  function stubIds(messages: ChatCompletionMessageParam[]): string[] {
    return messages
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id: string }).tool_call_id)
      .filter((id) => {
        const row = messages.find(
          (x) => x.role === "tool" && (x as { tool_call_id?: string }).tool_call_id === id,
        ) as { content?: string } | undefined;
        return typeof row?.content === "string" && row.content.includes('"error"');
      });
  }

  it("synthetically resolves a hanging tool call aborted via isAborted alone (no signal)", async () => {
    const sink = new RecordingSink();
    const messages = userMessages();
    let aborted = false;
    const healed: string[] = [];
    const run = new TurnEngine(sink).run(
      toolCallClient(["call_1"]),
      "test-model",
      messages,
      hangingRegistry,
      {
        sessionId: "abort-predicate-only",
        isAborted: () => aborted,
        abortReason: "turn aborted by operator",
        onHeal: (ids) => void healed.push(...ids),
      },
    );
    await vi.waitFor(() => expect(sink.events.some((e) => e.type === "tool.call")).toBe(true));
    aborted = true;
    await expect(run).rejects.toThrow("tool call aborted");
    // The announced call was synthetically resolved: no dangling ids, the
    // stub ids reported via onHeal match the tool rows in the transcript.
    expect(danglingIds(messages)).toEqual([]);
    expect(healed).toEqual(["call_1"]);
    expect(stubIds(messages)).toEqual(["call_1"]);
  });

  it("synthetically resolves every call when a multi-call round aborts mid-stream", async () => {
    const sink = new RecordingSink();
    const messages = userMessages();
    const ac = new AbortController();
    const hangingStreamClient: OpenAI = {
      chat: {
        completions: {
          create: (args: { signal?: AbortSignal }) =>
            (async function* () {
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        { index: 0, id: "call_a", function: { name: "echo", arguments: '{"t' } },
                        { index: 1, id: "call_b", function: { name: "echo", arguments: '{"t' } },
                      ],
                    },
                  },
                ],
              };
              await new Promise<void>((_resolve, reject) => {
                if (args.signal?.aborted) {
                  reject(new Error("aborted"));
                  return;
                }
                args.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
                  once: true,
                });
              });
            })(),
        },
      },
    } as unknown as OpenAI;
    const healed: string[] = [];
    const run = new TurnEngine(sink).run(hangingStreamClient, "test-model", messages, registry, {
      sessionId: "abort-mid-stream-multi",
      signal: ac.signal,
      isAborted: () => ac.signal.aborted,
      onHeal: (ids) => void healed.push(...ids),
    });
    await new Promise((r) => setTimeout(r, 50));
    ac.abort(new Error("turn aborted by operator"));
    await expect(run).rejects.toThrow();
    // Both announced calls were reconstructed and stubbed — neither dangles.
    expect(danglingIds(messages)).toEqual([]);
    expect(new Set(healed)).toEqual(new Set(["call_a", "call_b"]));
    const assistantRows = messages.filter(
      (m) => m.role === "assistant" && (m as { tool_calls?: unknown }).tool_calls !== undefined,
    );
    expect(
      assistantRows.flatMap((m) =>
        ((m as { tool_calls: Array<{ id: string }> }).tool_calls ?? []).map((tc) => tc.id),
      ),
    ).toEqual(expect.arrayContaining(["call_a", "call_b"]));
  });

  it("treats a throwing tool as a failure result (tool.result), not a turn failure", async () => {
    const throwingTool: ToolSpec<{ text: string }> = {
      name: "echo",
      description: "Always throws.",
      schema: z.object({ text: z.string() }).strict(),
      failure: (error) => ({ error }),
      run: async () => {
        throw new Error("tool blew up");
      },
    };
    const throwingRegistry = new ToolRegistry([throwingTool]);
    const sink = new RecordingSink();
    const messages = userMessages();
    let calls = 0;
    const client: OpenAI = {
      chat: {
        completions: {
          create: async () => {
            calls++;
            if (calls === 1) {
              return (async function* () {
                yield {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: "call_1",
                            function: { name: "echo", arguments: '{"text":"hi"}' },
                          },
                        ],
                      },
                    },
                  ],
                };
              })();
            }
            return (async function* () {
              yield { choices: [{ delta: { content: "done" } }] };
            })();
          },
        },
      },
    } as unknown as OpenAI;
    const ac = new AbortController();
    await new TurnEngine(sink).run(client, "test-model", messages, throwingRegistry, {
      sessionId: "throwing-tool",
      signal: ac.signal,
      isAborted: () => ac.signal.aborted,
    });
    expect(sink.events.map((e) => e.type)).toContain("tool.result");
    expect(sink.events.some((e) => e.type === "error")).toBe(false);
    expect(sink.events.at(-1)?.type).toBe("turn.finished");
    expect(danglingIds(messages)).toEqual([]);
  });
});
