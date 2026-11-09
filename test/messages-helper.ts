/**
 * Shared helpers for the messages/stream contract tests: send typed
 * messages, open a session stream, and collect frames until a predicate.
 * (`test/conformance.test.ts` et al. exercise the contract like an
 * external client via these, never by importing adapter internals.)
 */

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
