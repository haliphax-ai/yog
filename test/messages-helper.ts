/**
 * Shared helpers for the messages/stream contract tests: send typed
 * messages, open a session stream, and collect frames until a predicate.
 * (`test/conformance.test.ts` et al. exercise the contract like an
 * external client via these, never by importing adapter internals.)
 *
 * {@link orchestratorFromModel} is the test fake seam that used to be
 * `deps.model`: it drives the real `TurnEngine` (scripted OpenAI client)
 * inside a real `SessionOrchestrator`, with the sink/persist/settle
 * semantics of serve.ts's `executeTurn` — executeTurn owns the turn row,
 * the sink persists each event once and publishes it on the bus, one
 * `appendMessages` batch lands at settle, and failures persist the healed
 * partial batch (yog#42).
 */

import { SessionOrchestrator, type TurnRequest } from "../src/server/orchestrator.ts";
import { TurnEngine, type TurnOptions } from "../src/turn.ts";
import type { TurnEvent, TurnSink, TurnUsage } from "../src/turn/sink.ts";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type OpenAI from "openai";
import type { ToolRegistry } from "../src/toolkit/index.ts";

export interface StreamFrame {
  event: string;
  data: any;
}

/** Minimal SSE frame parser: splits `event:`/`data:` blocks. */
export function parseSse(text: string): StreamFrame[] {
  const frames: StreamFrame[] = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (event) frames.push({ event, data: JSON.parse(data) });
  }
  return frames;
}

export async function sendMessage(
  base: string,
  sessionId: string,
  type: string,
  data: Record<string, unknown> = {},
  opts: { requestId?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(`${base}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...opts.headers },
    body: JSON.stringify({
      type,
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      data,
    }),
  });
}

/** An open session stream: hello frame + frame queue + teardown. */
export interface SessionStream {
  res: Response;
  hello: StreamFrame;
  streamId: string;
  /** Frames already delivered (starting with the hello). */
  initial: StreamFrame[];
  abort: () => void;
  /** Read further frames until `pred` holds or the timeout elapses. */
  collectUntil(
    pred: (frames: StreamFrame[]) => boolean,
    timeoutMs?: number,
  ): Promise<StreamFrame[]>;
}

/**
 * Open the session stream and read its `stream.hello` frame.
 * The returned handle owns the body's single reader — use its
 * `collectUntil` instead of calling `getReader()` again.
 */
export async function openStream(
  base: string,
  sessionId: string,
  opts: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<SessionStream> {
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const res = await fetch(`${base}/v1/sessions/${sessionId}/stream`, {
    headers: opts.headers ?? {},
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes("\n\n")) break;
  }
  const initial = parseSse(text);
  const hello = initial[0]!;
  const streamId = String(hello?.data?.data?.streamId ?? "");
  const collectUntil = async (
    pred: (frames: StreamFrame[]) => boolean,
    timeoutMs = 10_000,
  ): Promise<StreamFrame[]> => {
    const frames = [...initial];
    let tail = "";
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (pred(frames)) return frames;
      if (Date.now() > deadline) return frames;
      const { done, value } = await reader.read();
      if (done) return frames;
      tail += decoder.decode(value, { stream: true });
      let idx = tail.indexOf("\n\n");
      while (idx >= 0) {
        const block = tail.slice(0, idx);
        tail = tail.slice(idx + 2);
        if (block.trim()) {
          let event = "";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event) frames.push({ event, data: JSON.parse(data) });
        }
        idx = tail.indexOf("\n\n");
      }
    }
  };
  return { res, hello, streamId, initial, abort: () => controller.abort(), collectUntil };
}

/** Run one turn to a terminal frame (`turn.finished`/`turn.aborted`/`error`). */
export async function runTurnToEnd(
  base: string,
  sessionId: string,
  data: Record<string, unknown>,
): Promise<{ startRes: Response; frames: StreamFrame[]; abort: () => void }> {
  const stream = await openStream(base, sessionId);
  const startRes = await sendMessage(base, sessionId, "turn.start", {
    streamId: stream.streamId,
    ...data,
  });
  const frames = await stream.collectUntil(
    (fs) =>
      fs.some(
        (f) => f.event === "turn.finished" || f.event === "turn.aborted" || f.event === "error",
      ),
    15_000,
  );
  return { startRes, frames, abort: stream.abort };
}

/** One streamed chunk of a scripted round (delta fields + optional usage). */
export interface Chunk {
  content?: string;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/** One scripted round (one `create()` call of the engine's tool loop). */
export type Round = Chunk[] | { chunks?: Chunk[]; failAfter?: number };

/** Normalize a round into its chunk list + optional mid-stream failure point. */
function roundOf(r: Round): { chunks: Chunk[]; failAfter?: number } {
  return Array.isArray(r)
    ? { chunks: r }
    : { chunks: r.chunks ?? [], ...(r.failAfter !== undefined ? { failAfter: r.failAfter } : {}) };
}

/**
 * Scripted OpenAI-compatible client for ONE turn: `rounds[r]` streams for
 * the engine's r-th `create()` call (a round of the tool loop); extra
 * calls stream nothing, ending the turn. `opts.failOn` rejects the
 * create() call itself (nothing streamed — request-level failure);
 * `round.failAfter` streams that many chunks then rejects (mid-stream
 * failure — the case that exercises the engine's heal path). The thrown
 * error carries `opts.failCode` (`rate_limited` shapes the engine's
 * terminal error event) with `opts.failMessage`.
 */
export function scriptedClient(
  rounds: Round[],
  opts: { failOn?: number; failCode?: string; failMessage?: string } = {},
): OpenAI {
  let calls = 0;
  const failure = (): Error => {
    const err = new Error(opts.failMessage ?? "provider stream failed");
    if (opts.failCode !== undefined) (err as Error & { code?: string }).code = opts.failCode;
    return err;
  };
  return {
    chat: {
      completions: {
        create: async () => {
          const r = calls++;
          if (opts.failOn === r) throw failure();
          // Exhausted-retry shape: after the scripted failure, every
          // subsequent create() also fails, so the engine's bounded 429
          // retry policy runs out instead of silently completing.
          if (opts.failOn !== undefined && r > opts.failOn) throw failure();
          const { chunks, failAfter } = roundOf(rounds[r] ?? []);
          return (async function* () {
            let n = 0;
            for (const chunk of chunks) {
              if (failAfter !== undefined && n === failAfter) throw failure();
              n += 1;
              const delta: Chunk = {};
              if (chunk.content !== undefined) delta.content = chunk.content;
              if (chunk.tool_calls !== undefined) delta.tool_calls = chunk.tool_calls;
              yield {
                choices: [{ delta }],
                ...(chunk.usage !== undefined ? { usage: chunk.usage } : {}),
              };
            }
            if (failAfter !== undefined) throw failure();
          })();
        },
      },
    },
  } as unknown as OpenAI;
}

/** A turn's hydrated `messages` as the engine saw them (mutated in place). */
export interface CapturedCall {
  sessionId: string;
  messages: ChatCompletionMessageParam[];
  model: string;
}

/** Composition returned by {@link orchestratorFromModel}. */
export interface OrchestratorFake {
  /** The orchestrator to inject as the HTTP layer's `orchestrator` dep. */
  orchestrator: SessionOrchestrator;
  /** One entry per turn: the hydrated (engine-mutated) message array. */
  calls: CapturedCall[];
  /** Usage as of the last onUsage point, per session (mirrors serve.ts). */
  usageBySession: Map<string, TurnUsage | undefined>;
}

/**
 * Wrap a per-turn client factory in the real turn path: `TurnEngine` (so
 * event shapes/ids/sequences match the engine contract) inside a real
 * `SessionOrchestrator` (abort fan-out, per-session FIFO), with serve.ts's
 * `executeTurn` semantics — executeTurn owns the turn row, the sink
 * persists each event once and publishes it on the bus, the settled batch
 * (`messages.slice(startLen)`) lands in one `appendMessages`, and the row
 * settles `finished` / `aborted` / `error` (the failure batch is
 * engine-healed first — yog#42).
 */
export function orchestratorFromModel(
  clientFactory: (sessionId: string) => OpenAI,
  opts: {
    store: {
      addTurn(sessionId: string, turn: Record<string, unknown>): Promise<unknown>;
      addEvent(sessionId: string, ev: Record<string, unknown>): Promise<unknown>;
      appendMessages(
        sessionId: string,
        msgs: ChatCompletionMessageParam[],
        turnId: number | null,
      ): Promise<unknown>;
      finishTurn(
        sessionId: string,
        turnId: number | null,
        status: string,
        usage?: TurnUsage,
      ): Promise<void>;
      getTranscript(sessionId: string): Promise<ChatCompletionMessageParam[]>;
    };
    /** Per-session event fan-out (the HTTP adapter subscribes here). */
    bus: { emit(channel: string, ev: unknown): unknown };
    /** Registry the engine executes tool calls against. */
    registry: ToolRegistry;
    /** Default model id (used when the request carries none). */
    modelId: string;
    /**
     * Engine 429-retry policy (TurnOptions.rateLimit). Tests pass tiny
     * delays so a scripted failure never waits out the default 1s/2s/4s
     * backoff ladder; production wires config.rateLimit* here.
     */
    rateLimit?: TurnOptions["rateLimit"];
  },
): OrchestratorFake {
  const calls: CapturedCall[] = [];
  const usageBySession = new Map<string, TurnUsage | undefined>();

  const executeTurn = async (
    sessionId: string,
    req: TurnRequest,
    ctx: { signal?: AbortSignal } = {},
  ): Promise<{ turnId: string | null }> => {
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    const model = typeof req.model === "string" ? req.model : opts.modelId;
    const prior = (await opts.store.getTranscript(sessionId)) as ChatCompletionMessageParam[];
    const messages: ChatCompletionMessageParam[] = [...prior, { role: "user", content: prompt }];
    const startLen = prior.length;

    const turnRow = await opts.store.addTurn(sessionId, {
      role: "user",
      content: prompt,
      status: "running",
      model,
    });
    const turnRowId =
      turnRow && typeof (turnRow as { id?: number }).id === "number"
        ? ((turnRow as { id?: number }).id as number)
        : null;
    calls.push({ sessionId, messages, model });

    let turnId: string | null = null;
    let liveUsage: TurnUsage | undefined;
    usageBySession.set(sessionId, undefined);

    // The sink IS the composition root's: persist once (best effort),
    // then publish the envelope on the per-session bus for SSE framing.
    const sink: TurnSink = {
      async emit(ev: TurnEvent): Promise<void> {
        if (ev.type === "turn.started") {
          turnId = (ev.data as { turnId?: string }).turnId ?? turnId;
        }
        if (ev.type === "turn.finished") {
          const u = (ev.data as { usage?: TurnUsage }).usage;
          if (u !== undefined && u !== null) liveUsage = u;
        }
        await opts.store.addEvent(sessionId, {
          type: ev.type,
          payload: JSON.stringify(ev.data),
          version: ev.version,
        });
        opts.bus.emit(`session:${sessionId}`, ev as unknown as Record<string, unknown>);
      },
    };

    const turnOpts: TurnOptions = {
      sessionId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      isAborted: () => ctx.signal?.aborted === true,
      abortReason: "turn aborted by operator",
      onUsage: (u) => {
        liveUsage = u;
        usageBySession.set(sessionId, u);
      },
      ...(opts.rateLimit ? { rateLimit: opts.rateLimit } : {}),
    };

    const appendBatch = async (): Promise<void> => {
      if (messages.length > startLen) {
        await opts.store.appendMessages(sessionId, messages.slice(startLen), turnRowId);
      }
    };

    try {
      await new TurnEngine(sink).run(
        clientFactory(sessionId),
        model,
        messages,
        opts.registry,
        turnOpts,
      );
      await appendBatch();
      await opts.store
        .finishTurn(sessionId, turnRowId, "finished", liveUsage)
        .catch(() => undefined);
    } catch (err) {
      // Failure parity with serve.ts (yog#42): the partial batch (prompt +
      // completed rounds + healed stubs) survives; abort settles as
      // `aborted`, provider failure as `error`. The signal is the
      // authoritative abort marker mid-stream.
      const isOperatorAbort =
        ctx.signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
      await appendBatch();
      await opts.store
        .finishTurn(sessionId, turnRowId, isOperatorAbort ? "aborted" : "error", liveUsage)
        .catch(() => undefined);
    }
    return { turnId };
  };

  return { orchestrator: new SessionOrchestrator({ executeTurn }), calls, usageBySession };
}
