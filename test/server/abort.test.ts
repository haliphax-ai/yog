/**
 * turn.abort message — operator-driven turn abort, end to end.
 *
 * Composition under test mirrors the real daemon: store + executeTurn
 * (TurnEngine over a scripted OpenAI client) + SessionOrchestrator, injected
 * as HTTP deps. The abort must kill the model stream, unwind the turn, heal
 * the transcript (stub tool messages for unanswered tool calls), settle the
 * turn row, and report status to the caller.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { createHttpServer } from "../../src/server/http.ts";
import { SessionOrchestrator } from "../../src/server/orchestrator.ts";
import { SessionStore } from "../../src/server/store/sessions.ts";
import { TurnEngine } from "../../src/turn.ts";
import { tools } from "../../src/register.ts";
import { setBashExecutor } from "../../src/toolkit/index.ts";
import type { TurnUsage } from "../../src/turn/sink.ts";
import { openStream, sendMessage } from "../messages-helper.ts";

/** `Response.json()` with a loose type: assertions do the checking. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}
/** `data` payload of a messages envelope response. */
async function dataOf(res: Response): Promise<any> {
  return (await json(res)).data;
}

/**
 * Fake OpenAI client: round 1 streams a bash tool call, then hangs until the
 * request's abort signal fires — exactly how the real SDK behaves when the
 * turn's signal aborts an in-flight stream.
 */
function hangingToolCallClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: (args: { signal?: AbortSignal }) =>
          (async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_hang",
                        function: { name: "bash", arguments: '{"command":"sleep 30"}' },
                      },
                    ],
                  },
                },
              ],
            };
            await new Promise<void>((_resolve, reject) => {
              if (args.signal?.aborted) {
                reject(new Error("The operation was aborted"));
                return;
              }
              args.signal?.addEventListener(
                "abort",
                () => reject(new Error("The operation was aborted")),
                { once: true },
              );
            });
          })(),
      },
    },
  } as unknown as OpenAI;
}

/**
 * Fake OpenAI client that streams one text delta then hangs until the turn's
 * abort signal fires — the mid-model-stream abort case: no tool call was
 * ever announced, so the unwind has nothing to heal.
 */
function proseThenHangClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: (args: { signal?: AbortSignal }) =>
          (async function* () {
            yield { choices: [{ delta: { content: "working... " } }] };
            await new Promise<void>((_resolve, reject) => {
              if (args.signal?.aborted) {
                reject(new Error("The operation was aborted"));
                return;
              }
              args.signal?.addEventListener(
                "abort",
                () => reject(new Error("The operation was aborted")),
                { once: true },
              );
            });
          })(),
      },
    },
  } as unknown as OpenAI;
}

/** Fake OpenAI client that streams a tool call + a usage-bearing final chunk,
 *  then hangs until the abort signal fires — the abort-after-usage case. */
function hangingToolCallWithUsageClient(): OpenAI {
  return {
    chat: {
      completions: {
        create: (args: { signal?: AbortSignal }) =>
          (async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_hang",
                        function: { name: "bash", arguments: '{"command":"sleep 30"}' },
                      },
                    ],
                  },
                },
              ],
            };
            yield {
              choices: [{ delta: { content: "" } }],
              usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
            };
            await new Promise<void>((_resolve, reject) => {
              if (args.signal?.aborted) {
                reject(new Error("The operation was aborted"));
                return;
              }
              args.signal?.addEventListener(
                "abort",
                () => reject(new Error("The operation was aborted")),
                { once: true },
              );
            });
          })(),
      },
    },
  } as unknown as OpenAI;
}

let dir: string;
let store: SessionStore;
let server: Server;
let base: string;
let bus: EventEmitter;
/** Selectable fake client: the default streams a tool call; the mid-stream
 *  scenario swaps in the prose-only client (nothing to heal). */
let activeClientFactory = hangingToolCallClient;
/** Usage as of the last cut point, per session (mirrors serve.ts). */
const usageBySession = new Map<string, TurnUsage | undefined>();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-abort-"));
  store = await SessionStore.open(join(dir, "sessions.db"));
  // The adapter subscribes to this bus for SSE delivery; the executeTurn
  // sink below publishes to it — the same composition as serve.ts.
  bus = new EventEmitter();
  bus.setMaxListeners(0);
  usageBySession.clear();

  // The bash tool's executor models a tool call in flight that never
  // settles (the thing an abort must rescue): the registry's signal race
  // rejects it when the turn aborts, and the engine's heal path stubs the
  // unanswered call.
  setBashExecutor(() => new Promise(() => undefined));

  const executeTurn = async (
    sessionId: string,
    req: Record<string, unknown>,
    ctx: { signal?: AbortSignal } = {},
  ): Promise<{ turnId: string | null }> => {
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    const prior = (await store.getTranscript(sessionId)) as unknown as ChatCompletionMessageParam[];
    const messages: ChatCompletionMessageParam[] = [...prior, { role: "user", content: prompt }];
    const startLen = prior.length;
    const turnRow = await store.addTurn(sessionId, {
      role: "user",
      content: prompt,
      status: "running",
      model: "fake",
    });
    const turnRowId = (turnRow as { id?: number }).id ?? null;

    let turnId: string | null = null;
    const sink = {
      async emit(ev: any): Promise<void> {
        if (ev.type === "turn.started") turnId = ev.data.turnId;
        await store.addEvent(sessionId, {
          type: ev.type,
          payload: JSON.stringify(ev.data),
          version: ev.version,
        });
        bus.emit(`session:${sessionId}`, ev);
      },
    };
    const healed: string[] = [];
    try {
      await new TurnEngine(sink).run(activeClientFactory(), "fake", messages, tools, {
        sessionId,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        isAborted: () => ctx.signal?.aborted === true,
        abortReason: "turn aborted by operator",
        onHeal: (ids) => void healed.push(...ids),
        onUsage: (u) => usageBySession.set(sessionId, u),
      });
      if (messages.length > startLen) {
        await store.appendMessages(sessionId, messages.slice(startLen), turnRowId);
      }
      await store
        .finishTurn(sessionId, turnRowId, "finished", usageBySession.get(sessionId))
        .catch(() => {});
    } catch (err) {
      // Mirror serve.ts's failure policy: an operator abort persists the
      // turn's batch (prompt + any healed stubs) so resume sees it; other
      // failures persist only when the unwind healed stubs.
      const isOperatorAbort =
        ctx.signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
      if ((isOperatorAbort || healed.length > 0) && messages.length > startLen) {
        await store.appendMessages(sessionId, messages.slice(startLen), turnRowId);
      }
      await store
        .finishTurn(sessionId, turnRowId, "aborted", usageBySession.get(sessionId))
        .catch(() => {});
    }
    return { turnId };
  };

  const orchestrator = new SessionOrchestrator({ store, executeTurn });

  server = createHttpServer({
    capabilities: {
      contractVersion: "v1",
      models: ["fake"],
      tools: ["bash"],
      features: ["sse", "transcript", "abort"],
    },
    store: store as any,
    orchestrator,
    bus,
    // No worker pool in this composition: the kill hook is a no-op that
    // reports "nothing was running" (the fake stream hangs before any tool).
    onAbortKillTool: () => false,
    onUsageFor: (sessionId: string) => usageBySession.get(sessionId),
  } as any);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store?.close();
  setBashExecutor(undefined);
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function newSession(): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, { method: "POST" });
  expect(res.status).toBe(201);
  return ((await json(res)) as { session: { id: string } }).session.id;
}

/** Start a turn on an open stream; returns the stream handle + start response. */
async function startTurn(sessionId: string) {
  const stream = await openStream(base, sessionId);
  const startRes = await sendMessage(base, sessionId, "turn.start", { prompt: "hang forever" });
  return { stream, startRes };
}
async function abortTurn(sessionId: string): Promise<Response> {
  return sendMessage(base, sessionId, "turn.abort");
}

/**
 * Poll until `pred` holds on the session transcript. The abort endpoint
 * returns as soon as the unwind is *requested*; healing + persisting the
 * stub batch completes on the next ticks, so tests poll for the settled
 * transcript instead of racing it.
 */
async function waitForTranscript(
  sessionId: string,
  pred: (messages: any[]) => boolean,
): Promise<any[]> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const messages = (await store.getTranscript(sessionId)) as any[];
    if (pred(messages) || Date.now() > deadline) return messages;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("turn.abort message", () => {
  it("aborts an in-flight turn, heals the transcript, and reports success", async () => {
    const sid = await newSession();
    const { stream, startRes } = await startTurn(sid);
    expect(startRes.status).toBe(202);

    // Let the turn get into flight (engine streamed the tool call).
    await new Promise((r) => setTimeout(r, 150));

    const res = await abortTurn(sid);
    expect(res.status).toBe(200);
    const body = await dataOf(res);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("aborted");
    expect(body.aborted.requested).toBe(true);
    expect(body.session.id).toBe(sid);

    // The turn stream closes promptly after the abort.
    await stream.collectUntil((fs) => fs.some((f) => f.event === "turn.aborted"), 3_000);
    stream.abort();

    // The transcript healed: assistant row with tool_calls + stub tool row.
    const transcript = await waitForTranscript(sid, (msgs) => msgs.some((m) => m.role === "tool"));
    const assistant = transcript.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_hang");
    const stub = transcript.find((m) => m.role === "tool");
    expect(stub?.tool_call_id).toBe("call_hang");
    expect(JSON.parse(stub?.content ?? "{}")).toMatchObject({ error: expect.any(String) });

    // The turn row settled as aborted; a turn.aborted event is on the log.
    const turns = await store.listTurns(sid);
    expect(turns.at(-1)?.status).toBe("aborted");
    expect(turns.at(-1)?.finished_at).not.toBeNull();
    const events = await store.listEvents(sid);
    // Persisted exactly once: the adapter is the sole writer of this event
    // (the engine emits no terminal event on abort), so a duplicate row
    // would mean the framing path persisted it twice.
    expect(events.filter((e: any) => e.type === "turn.aborted")).toHaveLength(1);

    // The session is idle now: a second abort is a no-op success.
    const again = await abortTurn(sid);
    expect((await dataOf(again)).status).toBe("idle");
  });

  it("is a no-op success when the session is idle", async () => {
    const sid = await newSession();
    const res = await abortTurn(sid);
    expect(res.status).toBe(200);
    const body = await dataOf(res);
    expect(body.ok).toBe(true);
    expect(body.status).toBe("idle");
    expect(body.aborted.requested).toBe(false);
    expect(body.aborted.activeToolCall).toBeNull();
  });

  it("404s on an unknown session", async () => {
    const res = await abortTurn("nope");
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("unknown_session");
  });

  it("aborts are session-scoped: a parallel session's turn is untouched", async () => {
    const a = await newSession();
    const b = await newSession();
    const aStart = await startTurn(a);
    expect(aStart.startRes.status).toBe(202);
    const bStart = await startTurn(b);
    expect(bStart.startRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 150));

    await abortTurn(a);
    await aStart.stream.collectUntil((fs) => fs.some((f) => f.event === "turn.aborted"), 3_000);
    aStart.stream.abort();

    // B still has a live turn of its own to abort.
    const resB = await abortTurn(b);
    expect((await dataOf(resB)).status).toBe("aborted");
    await bStart.stream.collectUntil((fs) => fs.some((f) => f.event === "turn.aborted"), 3_000);
    bStart.stream.abort();
  });

  it("delivers turn.aborted on the wire before the stream ends", async () => {
    const sid = await newSession();
    const { stream, startRes } = await startTurn(sid);
    expect(startRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 150));

    await abortTurn(sid);

    // Collect envelope types off the wire: the last turn frame is `turn.aborted`.
    const frames = await stream.collectUntil(
      (fs) => fs.some((f) => f.event === "turn.aborted"),
      5_000,
    );
    stream.abort();
    const types = frames.map((f) => f.event);
    expect(types.at(-1)).toBe("turn.aborted");
  });

  it("persists the aborted turn's prompt so a resume sees it", async () => {
    const sid = await newSession();
    const { stream, startRes } = await startTurn(sid);
    expect(startRes.status).toBe(202);
    await new Promise((r) => setTimeout(r, 150));

    await abortTurn(sid);
    await stream.collectUntil((fs) => fs.some((f) => f.event === "turn.aborted"), 3_000);
    stream.abort();

    // The user prompt survived the abort: a resumed client rehydrates it
    // alongside the healed assistant/tool rows.
    const transcript = await waitForTranscript(sid, (msgs) => msgs.some((m) => m.role === "tool"));
    const user = transcript.find((m) => m.role === "user");
    expect(user?.content).toBe("hang forever");
  });

  it("persists the prompt for resume when the abort lands mid-model-stream", async () => {
    activeClientFactory = proseThenHangClient;
    try {
      const sid = await newSession();
      const { stream, startRes } = await startTurn(sid);
      expect(startRes.status).toBe(202);
      await new Promise((r) => setTimeout(r, 150));

      const res = await abortTurn(sid);
      expect((await dataOf(res)).status).toBe("aborted");
      await stream.collectUntil((fs) => fs.some((f) => f.event === "turn.aborted"), 3_000);
      stream.abort();

      // No tool call was announced, so there is nothing to heal — the abort
      // path must still persist the user prompt (the regression behind the
      // "0 messages from server transcript" resume report).
      const transcript = await waitForTranscript(sid, (msgs) => msgs.length > 0);
      const user = transcript.find((m) => m.role === "user");
      expect(user?.content).toBe("hang forever");
      expect(transcript).toHaveLength(1);
    } finally {
      activeClientFactory = hangingToolCallClient;
    }
  });

  it("includes usage captured at the cut point in the aborted frame and persists it", async () => {
    activeClientFactory = hangingToolCallWithUsageClient;
    try {
      const sid = await newSession();
      const { stream, startRes } = await startTurn(sid);
      expect(startRes.status).toBe(202);
      await new Promise((r) => setTimeout(r, 150));

      const res = await abortTurn(sid);
      expect((await dataOf(res)).status).toBe("aborted");
      const frames = await stream.collectUntil(
        (fs) => fs.some((f) => f.event === "turn.aborted"),
        5_000,
      );
      stream.abort();
      let abortedData: any;
      for (const f of frames) if (f.event === "turn.aborted") abortedData = f.data.data;
      expect(abortedData?.reason).toBeTruthy();
      expect(abortedData?.usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 8,
        total_tokens: 18,
      });

      // The turn row carries the cut-point usage for recovery/replay.
      const turns = await store.listTurns(sid);
      const last = turns.at(-1);
      expect(last?.status).toBe("aborted");
      expect(last?.total_tokens).toBe(18);
      expect(last?.prompt_tokens).toBe(10);
    } finally {
      activeClientFactory = hangingToolCallClient;
    }
  });
});
