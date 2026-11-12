import { afterEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { z } from "zod";
import {
  TurnEngine,
  isRateLimitError,
  parseRateLimitResetMs,
  rateLimitDelayMs,
  rateLimitHints,
  resolveRateLimitPolicy,
} from "../src/turn.ts";
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
  id?: string;
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

  it("heals announced-but-unanswered calls on a provider failure mid-stream (yog#42)", async () => {
    // A 429 landing mid-stream, after the model announced a tool call
    // but before the round completed: the heal path reconstructs the
    // assistant row and stubs the call, so the persisted batch stays
    // hydratable for the next turn (providers reject dangling calls).
    const sink = new RecordingSink();
    const messages = userMessages();
    const midStream429: OpenAI = {
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
                          id: "call_429mid",
                          function: { name: "echo", arguments: '{"text":"hi"}' },
                        },
                      ],
                    },
                  },
                ],
              };
              throw new Error("429 rate limited");
            })(),
        },
      },
    } as unknown as OpenAI;
    const healed: string[] = [];
    await expect(
      new TurnEngine(sink).run(midStream429, "test-model", messages, registry, {
        sessionId: "provider-mid-stream",
        onHeal: (ids) => void healed.push(...ids),
      }),
    ).rejects.toThrow("429 rate limited");
    expect(sink.events.map((e) => e.type)).toEqual(["turn.started", "error"]);
    if (sink.events[1]?.type === "error") {
      expect(sink.events[1].data.code).toBe("provider_error");
    }
    // Reconstructed assistant row + healed stub, no dangling calls.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(healed).toEqual(["call_429mid"]);
    const assistant = messages[1] as { tool_calls?: Array<{ id?: string }> };
    expect(assistant.tool_calls?.[0]?.id).toBe("call_429mid");
    const stub = messages[2] as { tool_call_id?: string; content?: string };
    expect(stub.tool_call_id).toBe("call_429mid");
    expect(stub.content).toContain('"error"');
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


describe("TurnEngine native usage capture (plan §3.3)", () => {
  it("captures details, request id, and cost verbatim on turn.finished", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        { choices: [{ delta: { content: "Hello" } }] },
        {
          id: "gen_abc123",
          choices: [{ delta: { content: "" } }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 7 },
            completion_tokens_details: { reasoning_tokens: 2 },
            cost: 0.25,
          } as FakeChunk["usage"] & Record<string, unknown>,
        },
      ],
    ];
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", userMessages(), registry);
    const finished = sink.events.find((e) => e.type === "turn.finished");
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 4,
      total_tokens: 14,
      requestId: "gen_abc123",
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 2 },
      cost: 0.25,
    });
  });

  it("drops malformed extras instead of coercing them", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        { choices: [{ delta: { content: "Hi" } }] },
        {
          choices: [{ delta: { content: "" } }],
          usage: {
            prompt_tokens: 5,
            prompt_tokens_details: { cached_tokens: "many" },
            cost: "free",
          } as FakeChunk["usage"] & Record<string, unknown>,
        },
      ],
    ];
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", userMessages(), registry);
    const finished = sink.events.find((e) => e.type === "turn.finished");
    if (finished?.type !== "turn.finished") throw new Error("expected turn.finished");
    expect(finished.data.usage).toEqual({ prompt_tokens: 5 });
  });

  it("stamps round usage (with details) on tool.result events", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "echo", arguments: '{"text":"hi"}' } },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 5,
            total_tokens: 35,
            prompt_tokens_details: { cached_tokens: 12 },
          } as FakeChunk["usage"] & Record<string, unknown>,
        },
      ],
      [{ choices: [{ delta: { content: "Done" } }] }],
    ];
    await new TurnEngine(sink).run(fakeClient(rounds), "test-model", userMessages(), registry);
    const result = sink.events.find((e) => e.type === "tool.result");
    if (result?.type !== "tool.result") throw new Error("expected tool.result");
    expect(result.data.usage).toMatchObject({ prompt_tokens: 30, prompt_tokens_details: { cached_tokens: 12 } });
  });

  it("carries the last known usage on the terminal error event", async () => {
    const sink = new RecordingSink();
    const rounds: FakeChunk[][] = [
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "echo", arguments: '{"text":"hi"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 77, completion_tokens: 6, total_tokens: 83 },
        },
      ],
      [
        { choices: [{ delta: { content: "" } }], usage: { prompt_tokens: 90 } },
      ],
    ];
    await expect(
      new TurnEngine(sink).run(fakeClient(rounds, { failOn: 1 }), "test-model", userMessages(), registry),
    ).rejects.toThrow("provider exploded");
    const err = sink.events.find((e) => e.type === "error");
    if (err?.type !== "error") throw new Error("expected error event");
    expect(err.data.usage).toEqual({ prompt_tokens: 77, completion_tokens: 6, total_tokens: 83 });
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

describe("TurnEngine 429 rate-limit retry", () => {
  /** Build an SDK-shaped 429: status + Headers-like `.get()`. */
  function rateLimitError(
    headers: Record<string, string> = {},
    message = "429 rate limited",
  ): Error {
    const err = new Error(message) as Error & {
      status: number;
      code: string;
      headers: { get(n: string): string | null };
    };
    err.name = "RateLimitError";
    err.status = 429;
    err.code = "rate_limit_exceeded";
    err.headers = {
      get: (n: string) => {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === n.toLowerCase());
        return key === undefined ? null : headers[key]!;
      },
    };
    return err;
  }

  const noSleep = async (): Promise<void> => {};
  const fastPolicy = {
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 1000,
    backoffFactor: 2,
    jitterRatio: 0,
    sleep: noSleep,
    random: () => 0,
  };

  it("isRateLimitError recognises status/code/name, not a bare 429 message", () => {
    expect(isRateLimitError(rateLimitError())).toBe(true);
    expect(isRateLimitError(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error("x"), { code: "rate_limited" }))).toBe(true);
    expect(isRateLimitError(new Error("429 rate limited"))).toBe(false);
    expect(isRateLimitError(new Error("provider exploded"))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
  });

  it("parses x-ratelimit-reset durations and Retry-After hints", () => {
    expect(parseRateLimitResetMs("20ms")).toBe(20);
    expect(parseRateLimitResetMs("1m20s")).toBe(80_000);
    expect(parseRateLimitResetMs("2h0s0ms")).toBe(7_200_000);
    expect(parseRateLimitResetMs("garbage")).toBeUndefined();
    const err = rateLimitError({
      "Retry-After": "2",
      "x-ratelimit-reset-tokens": "1m20s",
      "x-ratelimit-reset-requests": "20ms",
    });
    expect(rateLimitHints(err)).toEqual({ retryAfterMs: 2000, resetMs: 80_000 });
    // Server hint wins over exponential, clamped to maxDelayMs.
    expect(rateLimitDelayMs(err, 1, { ...fastPolicy, maxDelayMs: 5000 })).toBe(5000);
  });

  it("falls back to exponential backoff when no hint is present", () => {
    const err = rateLimitError();
    expect(rateLimitDelayMs(err, 1, fastPolicy)).toBe(10);
    expect(rateLimitDelayMs(err, 2, fastPolicy)).toBe(20);
    expect(rateLimitDelayMs(err, 3, fastPolicy)).toBe(40);
  });

  it("resolveRateLimitPolicy defaults and clamps", () => {
    const p = resolveRateLimitPolicy(undefined);
    expect(p.maxAttempts).toBe(6);
    expect(p.baseDelayMs).toBe(1000);
    expect(p.maxDelayMs).toBe(60_000);
    expect(resolveRateLimitPolicy({ maxAttempts: 0 }).maxAttempts).toBe(1);
  });

  it("retries a 429 at create() with the identical transcript and signals rate_limited", async () => {
    const sink = new RecordingSink();
    const messages = userMessages();
    const seen: unknown[][] = [];
    let calls = 0;
    const client: OpenAI = {
      chat: {
        completions: {
          create: async (body: any) => {
            seen.push(structuredClone(body.messages));
            calls += 1;
            if (calls === 1) throw rateLimitError({ "Retry-After": "1" });
            return (async function* () {
              yield { choices: [{ delta: { content: "hi" } }] };
            })();
          },
        },
      },
    } as unknown as OpenAI;

    await new TurnEngine(sink).run(client, "test-model", messages, registry, {
      rateLimit: { ...fastPolicy, maxDelayMs: 5000 },
    });

    expect(calls).toBe(2);
    // The retry resubmitted the identical transcript (no synthetic message).
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[1]).toEqual([{ role: "user", content: "hi" }]);
    const types = sink.events.map((e) => e.type);
    expect(types).toEqual(["turn.started", "rate_limited", "message.delta", "turn.finished"]);
    const limited = sink.events[1]!;
    expect(limited.type).toBe("rate_limited");
    if (limited.type === "rate_limited") {
      expect(limited.data.attempt).toBe(1);
      expect(limited.data.maxAttempts).toBe(4);
      expect(limited.data.delayMs).toBe(1000);
      expect(limited.data.retryAfterMs).toBe(1000);
      expect(limited.data.round).toBe(0);
      expect(limited.data.status).toBe(429);
      expect(limited.data.providerMessage).toContain("429");
    }
    const finished = sink.events.at(-1)!;
    expect(finished.type).toBe("turn.finished");
    if (finished.type === "turn.finished") expect(finished.data.rateLimitRetries).toBe(1);
    // No transcript healing, no synthetic rows: just user + final assistant.
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    // Event ids stay monotonic across the backoff.
    expect(sink.events.map((e) => e.id)).toEqual([0, 1, 2, 3]);
  });

  it("retries a 429 mid-tool-loop without re-executing the tool or duplicating rows", async () => {
    let toolRuns = 0;
    const countingTool: ToolSpec<{ text: string }> = {
      name: "echo",
      description: "Echo text back.",
      schema: z.object({ text: z.string() }).strict(),
      failure: (error) => ({ error }),
      run: async (args) => {
        toolRuns += 1;
        return { echo: args["text"], exitCode: 0, runtimeMs: 1 };
      },
    };
    const countingRegistry = new ToolRegistry([countingTool]);
    const sink = new RecordingSink();
    const messages = userMessages();
    let calls = 0;
    const client: OpenAI = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            if (calls === 2) throw rateLimitError();
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
              yield { choices: [{ delta: { content: "Done" } }] };
            })();
          },
        },
      },
    } as unknown as OpenAI;

    await new TurnEngine(sink).run(client, "test-model", messages, countingRegistry, {
      rateLimit: fastPolicy,
    });

    expect(calls).toBe(3);
    expect(toolRuns).toBe(1);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(messages.some((m) => m.role === "user")).toBe(true);
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    const limited = sink.events.filter((e) => e.type === "rate_limited");
    expect(limited).toHaveLength(1);
    expect((limited[0] as any).data.round).toBe(1);
    expect(sink.events.at(-1)?.type).toBe("turn.finished");
  });

  it("exhausts to a terminal rate_limited error after maxAttempts", async () => {
    const sink = new RecordingSink();
    let calls = 0;
    const client: OpenAI = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            throw rateLimitError();
          },
        },
      },
    } as unknown as OpenAI;

    await expect(
      new TurnEngine(sink).run(client, "test-model", userMessages(), registry, {
        rateLimit: { ...fastPolicy, maxAttempts: 3 },
      }),
    ).rejects.toThrow("429");

    expect(calls).toBe(3);
    expect(sink.events.filter((e) => e.type === "rate_limited")).toHaveLength(2);
    const terminal = sink.events.at(-1)!;
    expect(terminal.type).toBe("error");
    if (terminal.type === "error") expect(terminal.data.code).toBe("rate_limited");
  });

  it("does not retry non-429 failures from create()", async () => {
    const sink = new RecordingSink();
    let calls = 0;
    const client: OpenAI = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            throw new Error("provider exploded");
          },
        },
      },
    } as unknown as OpenAI;

    await expect(
      new TurnEngine(sink).run(client, "test-model", userMessages(), registry, {
        rateLimit: fastPolicy,
      }),
    ).rejects.toThrow("provider exploded");

    expect(calls).toBe(1);
    expect(sink.events.some((e) => e.type === "rate_limited")).toBe(false);
    const terminal = sink.events.at(-1)!;
    expect(terminal.type).toBe("error");
    if (terminal.type === "error") expect(terminal.data.code).toBe("provider_error");
  });

  it("does not retry a failure after streaming has begun (mid-stream stays terminal)", async () => {
    const sink = new RecordingSink();
    let calls = 0;
    const client: OpenAI = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            return (async function* () {
              yield { choices: [{ delta: { content: "partial" } }] };
              throw rateLimitError();
            })();
          },
        },
      },
    } as unknown as OpenAI;

    await expect(
      new TurnEngine(sink).run(client, "test-model", userMessages(), registry, {
        rateLimit: fastPolicy,
      }),
    ).rejects.toThrow("429");

    expect(calls).toBe(1);
    expect(sink.events.some((e) => e.type === "rate_limited")).toBe(false);
    expect(sink.events.map((e) => e.type)).toEqual(["turn.started", "message.delta", "error"]);
  });

  it("aborts promptly during backoff without another create()", async () => {
    const sink = new RecordingSink();
    const controller = new AbortController();
    let calls = 0;
    const client: OpenAI = {
      chat: {
        completions: {
          create: async () => {
            calls += 1;
            throw rateLimitError();
          },
        },
      },
    } as unknown as OpenAI;

    const running = new TurnEngine(sink).run(client, "test-model", userMessages(), registry, {
      signal: controller.signal,
      // Long real delay: the abort must interrupt it, not wait it out.
      rateLimit: {
        maxAttempts: 5,
        baseDelayMs: 60_000,
        maxDelayMs: 60_000,
        backoffFactor: 2,
        jitterRatio: 0,
      },
    });
    const assertion = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(sink.events.some((e) => e.type === "rate_limited")).toBe(true));
    controller.abort();
    await assertion;

    expect(calls).toBe(1);
    expect(sink.events.some((e) => e.type === "error")).toBe(false);
    expect(sink.events.some((e) => e.type === "turn.finished")).toBe(false);
  });

  it("passes maxRetries: 0 so the SDK does not retry invisibly", async () => {
    const sink = new RecordingSink();
    const optionsSeen: unknown[] = [];
    const client: OpenAI = {
      chat: {
        completions: {
          create: async (_body: any, opts: any) => {
            optionsSeen.push(opts);
            return (async function* () {
              yield { choices: [{ delta: { content: "ok" } }] };
            })();
          },
        },
      },
    } as unknown as OpenAI;

    await new TurnEngine(sink).run(client, "test-model", userMessages(), registry, {
      rateLimit: fastPolicy,
    });
    expect(optionsSeen[0]).toMatchObject({ maxRetries: 0 });
  });
});
