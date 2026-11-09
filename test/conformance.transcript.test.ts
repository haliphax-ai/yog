/**
 * Conformance suite (transcript extension) — plain-`fetch` cases for the
 * server-owned transcript contract (PLAN §4.4–§4.6), driven exactly like an
 * external client against an ephemeral daemon:
 *
 *   POST   /v1/sessions/{id}/messages     transcript.get (rehydration dump)
 *   POST   /v1/sessions/{id}/messages     session.detach (detach / purge)
 *   POST   /v1/sessions        { title?, system? } (system seeds the transcript)
 *
 * Boot: `createDaemon` with injected deps + a real `SessionStore` on a tmp
 * sqlite file (same pattern as `test/conformance.test.ts`). The fake model
 * captures the hydrated upstream `messages` so resume semantics are asserted
 * at the model boundary, and appends its final assistant message to the
 * caller's array (engine contract, §4.3) so the transcript gets populated.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDaemon, type Daemon, type DaemonOptions } from "../src/server/serve.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../src/server/store/sessions.ts";
import { runTurnToEnd, sendMessage } from "./messages-helper.ts";

/** `Response.json()` with a loose type: assertions do the checking. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}
async function msgData(id: string, type: string, data: Record<string, unknown> = {}): Promise<any> {
  return ((await (await sendMessage(base, id, type, data)).json()) as any).data;
}
const msg = (id: string, type: string, data: Record<string, unknown> = {}) =>
  sendMessage(base, id, type, data);

const JSON_HEADERS = { "content-type": "application/json" };

const CAPABILITIES = {
  contractVersion: "v1",
  models: ["conf-transcript-model"],
  tools: ["bash"],
  features: ["messages", "stream", "transcript"],
};

function optsWith(model: ReturnType<typeof confModel>, store: SessionStore): DaemonOptions {
  return {
    host: "127.0.0.1",
    port: 0,
    deps: { capabilities: CAPABILITIES, model, store },
  };
}

let daemon: Daemon;
let base: string;
let store: SessionStore;
let storePath: string;

afterAll(async () => {
  await daemon?.close();
  store?.close();
});

/**
 * Fake model capturing the hydrated upstream `messages` per turn (so resume
 * semantics are assertable at the model boundary) and appending the final
 * assistant message to the caller's array (TurnEngine contract, §4.3) so the
 * transcript is populated. Emitted events mirror the real engine's shapes.
 */
function confModel() {
  const seen: any[][] = [];
  const counts = new Map<string, number>();
  return {
    seen,
    async runTurn(
      sessionId: string,
      req: any,
      ctx: { emit: (ev: any) => Promise<void>; signal?: AbortSignal },
    ) {
      const messages = Array.isArray(req?.messages) ? req.messages : [];
      seen.push(messages);
      // Turn numbering is per session (sessions are independent, §6): the
      // first turn of every session answers "answer 1".
      const n = (counts.get(sessionId) ?? 0) + 1;
      counts.set(sessionId, n);
      const turnId = `turn-conf-${n}`;
      await ctx.emit({
        id: 1,
        type: "turn.started",
        version: 1,
        ts: Date.now(),
        data: { turnId, model: req.model ?? "conf-transcript-model", ts: Date.now() },
      });
      const text = `answer ${n}`;
      await ctx.emit({
        id: 2,
        type: "message.delta",
        version: 1,
        ts: Date.now(),
        data: { text },
      });
      await ctx.emit({
        id: 3,
        type: "turn.finished",
        version: 1,
        ts: Date.now(),
        data: { turnId, durationMs: 1 },
      });
      // §4.3: leave the caller's array complete before turn.finished.
      messages.push({ role: "assistant", content: text });
    },
  };
}

let model: ReturnType<typeof confModel>;

beforeAll(async () => {
  storePath = join(tmpdir(), `yog-conf-tr-${Date.now()}.db`);
  store = await SessionStore.open(storePath);
  model = confModel();
  daemon = await createDaemon(optsWith(model, store));
  base = daemon.url;
});

/** POST /v1/sessions (optional `{ title?, system? }`) → session id. */
async function newSession(body: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  const { session } = await json(res);
  expect(session.id).toBeTruthy();
  return session.id as string;
}

/** Run one turn to completion via the stream (no engine import — plain fetch). */
async function runTurn(id: string, prompt: string): Promise<void> {
  const { startRes, abort } = await runTurnToEnd(base, id, { prompt });
  abort();
  expect(startRes.status).toBe(202);
}

/** transcript.get → its messages array (the §4.6 wire shape). */
async function transcript(id: string, data: Record<string, unknown> = {}): Promise<any[]> {
  const res = await msg(id, "transcript.get", data);
  expect(res.status).toBe(200);
  const { messages } = await msgData(id, "transcript.get", data);
  return messages as any[];
}

describe("conformance: transcript (server-owned conversation)", () => {
  it("full flow: create (system seed) → turn 1 → turn 2 → GET transcript matches both turns in order", async () => {
    const id = await newSession({ title: "transcript-flow", system: "be terse" });

    await runTurn(id, "turn one");
    await runTurn(id, "turn two");

    const messages = await transcript(id);
    // The `system` seed is the first transcript row (§4.6), then one
    // (user, assistant) pair per turn — canonical order, monotonic seq.
    expect(messages.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[0].content).toBe("be terse");
    expect(messages[1].content).toBe("turn one");
    expect(messages[2].content).toBe("answer 1");
    expect(messages[3].content).toBe("turn two");
    expect(messages[4].content).toBe("answer 2");
    for (let i = 0; i < messages.length; i += 1) {
      expect(messages[i].seq).toBe(i + 1);
      expect(typeof messages[i].ts).toBe("number");
      expect("turnId" in messages[i]).toBe(true);
    }
  });

  it("resume from a new client reusing the id: turn 2 sends no history but the model sees turn 1 (server hydrates)", async () => {
    const id = await newSession();

    // First client process: turn 1 only.
    await runTurn(id, "remember the word 'mistwood'");

    // Second client process: plain fetch, body carries only the new prompt —
    // clients never send history outbound (PLAN §1/§4.6).
    // Second client process: plain fetch, body carries only the new prompt —
    // clients never send history outbound (PLAN §1/§4.6).
    const { frames, abort } = await runTurnToEnd(base, id, { prompt: "what word?" });
    abort();
    expect(frames.some((f) => f.event === "turn.finished")).toBe(true);

    // The model demonstrably saw turn 1's context: the second upstream call
    // contains turn 1's messages, hydrated by the server, not the client.
    expect(model.seen.length).toBeGreaterThanOrEqual(2);
    const second = model.seen[model.seen.length - 1]!;
    expect(second[0].role).toBe("user");
    expect(second[0].content).toBe("remember the word 'mistwood'");
    expect(second[1].role).toBe("assistant");
    expect(second[1].content).toBe("answer 1");
    expect(second[2].role).toBe("user");
    expect(second[2].content).toBe("what word?");
  });

  it("dormancy lifecycle: detach → transcript readable (dormant) → POST revives → detach again → retention prunes", async () => {
    const id = await newSession();
    await runTurn(id, "first");

    // 1. Detach: status open → dormant, detached_at stamped, 200. Nothing
    //    is forfeited — the transcript stays fully readable while dormant.
    const detached = (await msgData(id, "session.detach")).session;
    expect(detached.status).toBe("dormant");
    expect(detached.status).toBe("dormant");
    expect(detached.detached_at).toBeTruthy();
    expect((await transcript(id)).map((m) => m.role)).toEqual(["user", "assistant"]);

    // 2. Revive (implicit): POST turns flips status to open and clears
    //    detached_at; the turn streams (no session_closed 409 — §4.6).
    // 2. Revive (implicit): turn.start flips status to open and clears
    //    detached_at (no session_closed 409 — §4.6).
    await runTurn(id, "revived");
    const after = (await msgData(id, "session.get")).session;
    expect(after.status).toBe("open");
    expect(after.detached_at).toBeNull();

    // 3. Seq continues across dormancy — never reset per lifecycle (§4.8).
    const msgs = await transcript(id);
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3, 4]);

    // 4. Detach again — a fresh clock start (idempotent API, 200), then
    //    retention honored (§4.5): reopen a store whose dormant session's
    //    `detached_at` is already past the 30-day cutoff — the startup prune
    //    must have removed it (cascading to the transcript). Self-contained
    //    store so the shared daemon for the remaining cases is untouched.
    const del2 = await msgData(id, "session.detach");
    expect(del2.session.detached_at).toBeTruthy();

    const retentionPath = join(tmpdir(), `yog-conf-retain-${Date.now()}.db`);
    const doomed = await SessionStore.open(retentionPath);
    const dormantId = String((await doomed.createSession({})).id);
    await doomed.detachSession(dormantId, Date.now() - 31 * 24 * 60 * 60 * 1000);
    doomed.close();

    const reopened = await SessionStore.open(retentionPath);
    expect(await reopened.getSession(dormantId)).toBeNull();
    reopened.close();
  });

  it("session.detach with purge → 404 unknown_session on every subsequent read/turn", async () => {
    const id = await newSession();
    await runTurn(id, "to be purged");

    const del = await msgData(id, "session.detach", { purge: true });
    expect(del.deleted).toBe(true);

    // Every surface: session.get, transcript.get, turn.get, turn.start.
    const got = await msg(id, "session.get");
    expect(got.status).toBe(404);
    expect((await json(got)).error.code).toBe("unknown_session");
    const tr = await msg(id, "transcript.get");
    expect(tr.status).toBe(404);
    expect((await json(tr)).error.code).toBe("unknown_session");
    const rec = await msg(id, "turn.get", { turnId: "1" });
    expect(rec.status).toBe(404);
    expect((await json(rec)).error.code).toBe("unknown_session");
    const turn = await msg(id, "turn.start", { prompt: "anyone there?" });
    expect(turn.status).toBe(404);
    expect((await json(turn)).error.code).toBe("unknown_session");
  });

  it("pagination: afterSeq/limit slices a multi-turn transcript", async () => {
    const id = await newSession();
    await runTurn(id, "one");
    await runTurn(id, "two");
    await runTurn(id, "three");
    // Three (user, assistant) pairs, seq 1..6, no system seed.
    expect((await transcript(id)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    // limit caps the batch from the start.
    expect((await transcript(id, { limit: 2 })).map((m) => m.seq)).toEqual([1, 2]);

    // after skips everything up to and including that seq.
    expect((await transcript(id, { afterSeq: 4 })).map((m) => m.seq)).toEqual([5, 6]);

    // Combined: forward paging in one client-side loop.
    const paged: number[] = [];
    let after = 0;
    for (;;) {
      const batch = await transcript(id, { afterSeq: after, limit: 2 });
      if (batch.length === 0) break;
      for (const m of batch) {
        paged.push(m.seq);
        after = m.seq;
      }
      expect(batch.length).toBeLessThanOrEqual(2);
    }
    expect(paged).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("failed turn stays in the dump, marked `error`, with healed stubs — reloads do not rewind (yog#42)", async () => {
    // Own daemon + store: the scripted model succeeds on turn 1, then
    // 429s mid-turn on turn 2 after announcing a tool call it never
    // answers (the heal path must stub it), and succeeds again on
    // turn 3 (proving the failed turn hydrates cleanly).
    const seen: any[][] = [];
    let calls = 0;
    const flakyModel = {
      async runTurn(_sessionId: string, req: any, ctx: { emit: (ev: any) => Promise<void> }) {
        calls += 1;
        const messages = Array.isArray(req?.messages) ? req.messages : [];
        seen.push(messages);
        const turnId = `turn-flaky-${calls}`;
        await ctx.emit({
          id: 1,
          type: "turn.started",
          version: 1,
          ts: Date.now(),
          data: { turnId, model: "conf-transcript-model", ts: Date.now() },
        });
        if (calls === 2) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_429", type: "function", function: { name: "bash", arguments: "{}" } },
            ],
          });
          const err = new Error("429 rate limited") as Error & { code?: string };
          err.code = "rate_limited";
          throw err;
        }
        const text = `answer ${calls}`;
        await ctx.emit({
          id: 2,
          type: "message.delta",
          version: 1,
          ts: Date.now(),
          data: { text },
        });
        await ctx.emit({
          id: 3,
          type: "turn.finished",
          version: 1,
          ts: Date.now(),
          data: { turnId, durationMs: 1 },
        });
        messages.push({ role: "assistant", content: text });
      },
    };
    const flakyStore = await SessionStore.open(join(tmpdir(), `yog-conf-flaky-${Date.now()}.db`));
    const flaky = await createDaemon({
      host: "127.0.0.1",
      port: 0,
      deps: { capabilities: CAPABILITIES, model: flakyModel as any, store: flakyStore },
    });
    try {
      const created = await fetch(`${flaky.url}/v1/sessions`, { method: "POST" });
      const { session } = await json(created);
      const sid = session.id as string;
      const run = async (prompt: string): Promise<void> => {
        const { startRes, abort } = await runTurnToEnd(flaky.url, sid, { prompt });
        abort();
        expect(startRes.status).toBe(202);
      };
      // Turn 1 succeeds; turn 2 429s mid-turn; turn 3 succeeds again.
      await run("first");
      await run("second");
      // Wait for the failed turn's settle before dumping.
      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 3000;
        const tick = async (): Promise<void> => {
          const turns = await flakyStore.listTurns(sid);
          if (turns.length >= 2 && turns.at(-1)?.status !== "running") {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            resolve();
            return;
          }
          setTimeout(() => void tick(), 25);
        };
        void tick();
      });
      const dumpRes = await sendMessage(flaky.url, sid, "transcript.get");
      expect(dumpRes.status).toBe(200);
      const dump = ((await json(dumpRes)) as any).data;
      // Turn 1 (user, assistant) + failed turn 2 (user, assistant with
      // tool_calls, healed tool stub) — the dump does not rewind.
      expect(dump.messages.map((m: any) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
      ]);
      expect(dump.messages[0].content).toBe("first");
      expect(dump.messages[1].content).toBe("answer 1");
      expect(dump.messages[2].content).toBe("second");
      expect(dump.messages[3].toolCalls?.[0]?.id).toBe("call_429");
      expect(dump.messages[4].toolCallId).toBe("call_429");
      expect(dump.messages[4].content).toContain("error");
      expect(dump.turns?.map((t: any) => t.status)).toEqual(["finished", "error"]);
      // Turn 3: the next hydrate replays the failed turn's rows (stub
      // included) — providers never see a dangling tool call.
      await run("third");
      expect(seen.length).toBe(3);
      const thirdHydrate = seen[2]!;
      expect(
        thirdHydrate.some((m: any) => m.role === "tool" && m.tool_call_id === "call_429"),
      ).toBe(true);
      const afterRes = await sendMessage(flaky.url, sid, "transcript.get");
      const after = ((await json(afterRes)) as any).data;
      expect(after.messages.map((m: any) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "tool",
        "user",
        "assistant",
      ]);
      expect(after.turns?.map((t: any) => t.status)).toEqual(["finished", "error", "finished"]);
    } finally {
      await flaky.close();
      flakyStore.close();
    }
  }, 15_000);
});
