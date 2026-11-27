/**
 * Shared test helpers for the messages/stream contract suites: send typed
 * messages, open a session stream and collect frames until a predicate,
 * script OpenAI-compatible clients, and compose the turn fake (a real
 * orchestrator over a real engine) so suites exercise the contract like
 * an external client, never by importing adapter internals.
 */

import { SessionOrchestrator, type TurnRequest } from "../src/server/orchestrator.ts";
import { TurnEngine } from "../src/turn/index.ts";
import type { TurnEvent, TurnOptions, TurnSink, TurnUsage } from "../src/turn/index.ts";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import { deliverPrelude, type PreludeSink } from "../src/server/daemon/prelude.ts";
import type OpenAI from "openai";
import type { ToolRegistry } from "../src/toolkit/index.ts";

export interface StreamFrame {
  event: string;
  data: any;
}

/**
 * The SSE wire frames one event per block: `event:<type>` +
 * `data:<envelope-json>`, blank-line separated (see src/server/sse.ts).
 */
/**
 * Parse SSE text into frames: every blank-line-terminated block carries
 * `event:<type>` + `data:<envelope-json>` lines (see src/server/sse.ts).
 */
export function parseSse(text: string): StreamFrame[] {
  return text
    .split("\n\n")
    .map(parseSseBlock)
    .filter((f): f is StreamFrame => f !== null);
}

/** One SSE block → a frame, or null for empty blocks. */
function parseSseBlock(block: string): StreamFrame | null {
  const fields = new Map<string, string>(
    block
      .split("\n")
      .map((line: string) => {
        const i = line.indexOf(":");
        return [line.slice(0, i), line.slice(i + 1).trim()] as const;
      })
      .filter(([k]) => k === "event" || k === "data"),
  );
  const event = fields.get("event") ?? "";
  const data = fields.get("data") ?? "";
  return event ? { event, data: JSON.parse(data) } : null;
}

/** POST one message envelope; returns the raw response. */
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
      ...(opts.requestId && { requestId: opts.requestId }),
      data,
    }),
  });
}

/** Chain `signal` onto `controller`: a pre-aborted signal aborts at once. */
export function forwardAbort(controller: AbortController, signal?: AbortSignal): void {
  if (!signal) return;
  signal.addEventListener("abort", () => controller.abort(), { once: true });
  if (signal.aborted) controller.abort();
}

/** Read from `reader` until a blank SSE line terminates the block. */
export async function readUntilBlankLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): Promise<string> {
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes("\n\n")) break;
  }
  return text;
}

/**
 * Read further frames until `pred` holds or the timeout elapses. The
 * reader is the single owner of the response body (openStream hands it
 * over), so every read below resumes the same stream.
 */
export async function collectFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  initial: StreamFrame[],
  pred: (frames: StreamFrame[]) => boolean,
  timeoutMs: number,
): Promise<StreamFrame[]> {
  const frames = [...initial];
  let tail = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pred(frames) || Date.now() > deadline) return frames;
    const { done, value } = await reader.read();
    if (done) return frames;
    tail += decoder.decode(value, { stream: true });
    tail = drainCompleteBlocks(tail, frames);
  }
}

/**
 * Pop every complete SSE block off the head of `tail` onto `frames`.
 * Returns the remainder (a partial block waiting for more bytes).
 */
function drainCompleteBlocks(tail: string, frames: StreamFrame[]): string {
  let rest = tail;
  let idx = rest.indexOf("\n\n");
  while (idx >= 0) {
    const block = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    const frame = parseSseBlock(block);
    if (frame) frames.push(frame);
    idx = rest.indexOf("\n\n");
  }
  return rest;
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
 * Open the session stream and read its `stream.hello` frame. The returned
 * handle owns the body's single reader — use its `collectUntil` instead of
 * calling `getReader()` again.
 */
export async function openStream(
  base: string,
  sessionId: string,
  opts: { signal?: AbortSignal; headers?: Record<string, string> } = {},
): Promise<SessionStream> {
  const controller = new AbortController();
  forwardAbort(controller, opts.signal);
  const res = await fetch(`${base}/v1/sessions/${sessionId}/stream`, {
    headers: opts.headers ?? {},
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const text = await readUntilBlankLine(reader, decoder);
  const initial = parseSse(text);
  const hello = initial[0]!;
  const streamId = String(hello?.data?.data?.streamId ?? "");
  const collectUntil = (pred: (frames: StreamFrame[]) => boolean, timeoutMs = 10_000) =>
    collectFrames(reader, decoder, initial, pred, timeoutMs);
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
  const frames = await stream.collectUntil(isTerminal, 15_000);
  return { startRes, frames, abort: stream.abort };
}

/** Terminal turn frames: the stream is done once one of these lands. */
const isTerminal = (fs: StreamFrame[]): boolean =>
  fs.some((f) => f.event === "turn.finished" || f.event === "turn.aborted" || f.event === "error");

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
  if (Array.isArray(r)) return { chunks: r };
  return { chunks: r.chunks ?? [], failAfter: r.failAfter };
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
    return Object.assign(err, { code: opts.failCode });
  };
  return {
    chat: {
      completions: {
        create: async () => {
          const r = calls++;
          if (shouldFail(opts.failOn, r)) throw failure();
          const { chunks, failAfter } = roundOf(rounds[r] ?? []);
          return streamRound(chunks, failAfter, failure);
        },
      },
    },
  } as unknown as OpenAI;
}

/**
 * Whether call `r` of a scripted turn fails: the configured call itself,
 * or any later one — after the scripted failure every subsequent create()
 * also fails, so the engine's bounded 429 retry runs out instead of
 * silently completing.
 */
function shouldFail(failOn: number | undefined, r: number): boolean {
  if (failOn === undefined) return false;
  return r >= failOn;
}

/** Copy the scripted chunk's optional delta fields (content, tool calls). */
function deltaOf(chunk: Chunk): Chunk {
  const { content, tool_calls } = chunk;
  return {
    ...(content !== undefined && { content }),
    ...(tool_calls !== undefined && { tool_calls }),
  };
}

/** The mid-stream failure check for scripted round `n`. */
const hitFailAfter = (n: number, failAfter: number | undefined): boolean =>
  failAfter !== undefined && n === failAfter;

/** The delta yield of one scripted round (mid-stream failure included). */
function streamRound(chunks: Chunk[], failAfter: number | undefined, fail: () => Error) {
  return (async function* () {
    let n = 0;
    for (const chunk of chunks) {
      if (hitFailAfter(n, failAfter)) throw fail();
      n += 1;
      yield {
        choices: [{ delta: deltaOf(chunk) }],
        ...(chunk.usage !== undefined ? { usage: chunk.usage } : {}),
      };
    }
    if (failAfter !== undefined) throw fail();
  })();
}

/** A turn's hydrated `messages` as the engine saw them (mutated in place). */
export interface CapturedCall {
  sessionId: string;
  messages: ChatCompletionMessageParam[];
  model: string;
}

/**
 * The store surface the turn fake persists through. `SessionStore` is
 * structurally compatible (test files may import src internals freely);
 * the named alias keeps the fake's contract readable.
 */
type FakeStore = Pick<
  import("../src/server/store/index.ts").SessionStore,
  "addTurn" | "addEvent" | "appendMessages" | "finishTurn" | "getTranscript"
>;

/** Composition returned by {@link orchestratorFromModel}. */
export interface OrchestratorFake {
  /** The orchestrator to inject as the HTTP layer's `orchestrator` dep. */
  orchestrator: SessionOrchestrator;
  /** One entry per turn: the hydrated (engine-mutated) message array. */
  calls: CapturedCall[];
  /** Usage as of the last onUsage point, per session (mirrors serve.ts). */
  usageBySession: Map<string, TurnUsage | undefined>;
}

/** Dependencies for {@link orchestratorFromModel} beyond the store. */
interface OrchestratorFakeOptions {
  store: FakeStore;
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
  /** Per-session prelude notices, drained at hydrate like serve.ts. */
  prelude?: PreludeSink;
}

/** The turn row as addTurn resolves it (id is what the fake needs). */
type TurnRowLike = { id?: number } | null | undefined;

/** The row id to stamp turn_id onto persisted rows (null when absent). */
function turnRowIdOf(turnRow: TurnRowLike): number | null {
  return typeof turnRow?.id === "number" ? turnRow.id : null;
}

/**
 * Wrap a per-turn client factory in the real turn path: `TurnEngine` (so
 * event shapes/ids/sequences match the engine contract) inside a real
 * `SessionOrchestrator` (abort fan-out, per-session FIFO), with serve.ts's
 * `executeTurn` semantics — executeTurn owns the turn row, the sink
 * persists each event once and publishes it on the bus, the settled batch
 * (everything from the prompt row on) lands in one `appendMessages`, and the row
 * settles `finished` / `aborted` / `error` (the failure batch is
 * engine-healed first — yog#42).
 */
export function orchestratorFromModel(
  clientFactory: (sessionId: string) => OpenAI,
  opts: OrchestratorFakeOptions,
): OrchestratorFake {
  const capture: FakeCapture = { calls: [], usageBySession: new Map() };
  return {
    orchestrator: new SessionOrchestrator({
      executeTurn: (sessionId, req, ctx) =>
        runFakeTurn({ clientFactory, opts, capture, sessionId, req, ctx }),
    }),
    calls: capture.calls,
    usageBySession: capture.usageBySession,
  };
}

/** Everything one fake turn needs, shared by its helper functions. */
interface FakeTurnScope {
  opts: OrchestratorFakeOptions;
  capture: FakeCapture;
  sessionId: string;
  ctx: { signal?: AbortSignal };
  live: LiveFakeTurn;
  /** The open turn row (events persist under it, like the real sink). */
  turnRowId: number | null;
}

/** Everything one fake turn needs, shared by its helper functions. */
interface FakeCapture {
  calls: CapturedCall[];
  usageBySession: Map<string, TurnUsage | undefined>;
}

/** Per-turn mutable state shared by the sink and the settle path. */
interface LiveFakeTurn {
  turnId: string | null;
  usage: TurnUsage | undefined;
}

/** Snapshot the turn's inputs at the model boundary + open its row. */
async function openFakeTurn(
  scope: FakeTurnScope,
  req: TurnRequest,
): Promise<{
  messages: ChatCompletionMessageParam[];
  firstOwn: ChatCompletionMessageParam;
  turnRowId: number | null;
}> {
  const { opts, capture, sessionId } = scope;
  const prompt = String(req.prompt ?? "");
  const model = req.model ?? opts.modelId;
  const prior = (await opts.store.getTranscript(sessionId)) as ChatCompletionMessageParam[];
  // Drain the prelude queue exactly like serve.ts's hydrateMessages: the
  // notice pair lands between the prior transcript and the prompt row.
  const notices = opts.prelude?.drain(sessionId);
  const prelude = notices !== undefined ? deliverPrelude(notices) : undefined;
  const messages: ChatCompletionMessageParam[] = [
    ...prior,
    ...(prelude ?? []).flatMap((p) => [
      p.call as ChatCompletionMessageParam,
      p.result as ChatCompletionMessageParam,
    ]),
    { role: "user", content: prompt },
  ];
  const turnRow = (await opts.store.addTurn(sessionId, {
    role: "user",
    content: prompt,
    status: "running",
    model,
    // The jobs manager stamps its wake turns; the marker rides the row
    // exactly like the real executeTurn.
    wake: req.wake === true,
  })) as TurnRowLike;
  capture.calls.push({ sessionId, messages, model });
  capture.usageBySession.set(sessionId, undefined);
  const firstOwn =
    prelude !== undefined
      ? (prelude[0]!.call as ChatCompletionMessageParam)
      : (messages[messages.length - 1] as ChatCompletionMessageParam);
  return { messages, firstOwn, turnRowId: turnRowIdOf(turnRow) };
}

/** The fake's sink: capture ids/usage, persist once, publish on the bus. */
function fakeSink(scope: FakeTurnScope): TurnSink {
  const { opts, sessionId, live, turnRowId } = scope;
  return {
    async emit(ev: TurnEvent): Promise<void> {
      if (ev.type === "turn.started") {
        live.turnId = (ev.data as { turnId?: string }).turnId ?? live.turnId;
      } else if (ev.type === "turn.finished") {
        const u = (ev.data as { usage?: TurnUsage }).usage;
        if (u) live.usage = u;
      }
      await opts.store.addEvent(
        sessionId,
        {
          type: ev.type,
          payload: JSON.stringify(ev.data),
          version: ev.version,
        },
        turnRowId ?? undefined,
      );
      opts.bus.emit(`session:${sessionId}`, ev as unknown as Record<string, unknown>);
    },
  };
}

/** The engine options for one fake turn (abort plumbing + usage capture). */
function fakeTurnOptions(scope: FakeTurnScope): TurnOptions {
  const { opts, capture, sessionId, ctx, live } = scope;
  return {
    sessionId,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    isAborted: () => ctx.signal?.aborted === true,
    abortReason: "turn aborted by operator",
    onUsage: (u) => {
      live.usage = u;
      capture.usageBySession.set(sessionId, u);
    },
    ...(opts.rateLimit && { rateLimit: opts.rateLimit }),
  };
}

/**
 * Settle a turn row like serve.ts's executeTurn: persist the (partial)
 * batch exactly once, then stamp the row with `status` and the last
 * known usage. Failure parity with serve.ts (yog#42): the partial batch
 * (prompt + completed rounds + healed stubs) survives; abort settles as
 * `aborted`, provider failure as `error`. The signal is the
 * authoritative abort marker mid-stream.
 */
async function settleFakeTurn(
  scope: FakeTurnScope,
  s: {
    messages: ChatCompletionMessageParam[];
    firstOwn: ChatCompletionMessageParam;
    turnRowId: number | null;
  },
  status: string,
): Promise<void> {
  const { opts, sessionId, live } = scope;
  const batch = s.messages.slice(s.messages.indexOf(s.firstOwn));
  await opts.store.appendMessages(sessionId, batch, s.turnRowId);
  await opts.store.finishTurn(sessionId, s.turnRowId, status, live.usage).catch(() => undefined);
}

/** One fake turn: hydrate, run the engine, settle the row (yog#42). */
async function runFakeTurn(input: {
  clientFactory: (sessionId: string) => OpenAI;
  opts: OrchestratorFakeOptions;
  capture: FakeCapture;
  sessionId: string;
  req: TurnRequest;
  ctx?: { signal?: AbortSignal };
}): Promise<{ turnId: string | null }> {
  const { clientFactory, opts, capture, sessionId, req, ctx = {} } = input;
  const scope: FakeTurnScope = {
    opts,
    capture,
    sessionId,
    ctx,
    live: { turnId: null, usage: undefined },
    turnRowId: null,
  };
  const model = req.model ?? opts.modelId;
  const s = await openFakeTurn(scope, req);
  scope.turnRowId = s.turnRowId;
  const sink = fakeSink(scope);
  const turnOpts = fakeTurnOptions(scope);
  try {
    await new TurnEngine(sink).run(
      clientFactory(sessionId),
      model,
      s.messages,
      opts.registry,
      turnOpts,
    );
    await settleFakeTurn(scope, s, "finished");
  } catch (err) {
    const isOperatorAbort = isAbort(ctx, err);
    await settleFakeTurn(scope, s, isOperatorAbort ? "aborted" : "error");
  }
  return { turnId: scope.live.turnId };
}

/**
 * An operator abort, exactly like serve.ts reads it: the signal is the
 * authoritative mid-stream marker; an `AbortError` names the unwind.
 */
function isAbort(ctx: { signal?: AbortSignal }, err: unknown): boolean {
  return ctx.signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
}
