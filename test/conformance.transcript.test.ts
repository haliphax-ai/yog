/**
 * Conformance suite (transcript extension) — plain-`fetch` cases for the
 * server-owned transcript contract (PLAN §4.4–§4.6), driven exactly like an
 * external client against an ephemeral daemon:
 *
 *   GET    /v1/sessions/{id}/transcript   rehydration dump (?after=&limit=)
 *   POST   /v1/sessions        { title?, system? } (system seeds the transcript)
 *   DELETE /v1/sessions/{id}   detach / ?purge=true
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

/** `Response.json()` with a loose type: assertions do the checking. */
async function json(res: Response): Promise<any> {
  return (await res.json()) as any;
}

const JSON_HEADERS = { "content-type": "application/json" };

const CAPABILITIES = {
  contractVersion: "v1",
  models: ["conf-transcript-model"],
  tools: ["bash"],
  features: ["sse", "transcript"],
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
  store = new SessionStore(storePath);
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

/** POST one turn and drain the SSE stream (no engine import — plain fetch). */
async function runTurn(id: string, prompt: string): Promise<void> {
  const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ prompt }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  await res.text();
}

/** GET the transcript dump → its messages array (the §4.6 wire shape). */
async function transcript(id: string, query = ""): Promise<any[]> {
  const res = await fetch(`${base}/v1/sessions/${id}/transcript${query}`);
  expect(res.status).toBe(200);
  const { messages } = await json(res);
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
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ prompt: "what word?" }),
    });
    expect(res.status).toBe(200);
    const frames: any[] = [];
    for (const block of (await res.text()).split("\n\n")) {
      if (!block.trim()) continue;
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event) frames.push({ event, data: JSON.parse(data) });
    }
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
    const del = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const detached = (await json(del)).session;
    expect(detached.status).toBe("dormant");
    expect(detached.detached_at).toBeTruthy();
    expect((await transcript(id)).map((m) => m.role)).toEqual(["user", "assistant"]);

    // 2. Revive (implicit): POST turns flips status to open and clears
    //    detached_at; the turn streams (no session_closed 409 — §4.6).
    const res = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ prompt: "revived" }),
    });
    expect(res.status).toBe(200);
    await res.text();
    const after = (await json(await fetch(`${base}/v1/sessions/${id}`))).session;
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
    const del2 = await fetch(`${base}/v1/sessions/${id}`, { method: "DELETE" });
    expect(del2.status).toBe(200);
    expect((await json(del2)).session.detached_at).toBeTruthy();

    const retentionPath = join(tmpdir(), `yog-conf-retain-${Date.now()}.db`);
    const doomed = new SessionStore(retentionPath);
    const dormantId = String(doomed.createSession({}).id);
    doomed.detachSession(dormantId, Date.now() - 31 * 24 * 60 * 60 * 1000);
    doomed.close();

    const reopened = new SessionStore(retentionPath);
    expect(reopened.getSession(dormantId)).toBeNull();
    reopened.close();
  });

  it("DELETE ?purge=true → 404 unknown_session on every subsequent read/turn", async () => {
    const id = await newSession();
    await runTurn(id, "to be purged");

    const del = await fetch(`${base}/v1/sessions/${id}?purge=true`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await json(del)).deleted).toBe(true);

    // Every surface: GET session, GET transcript, GET turn recovery, POST turn.
    const got = await fetch(`${base}/v1/sessions/${id}`);
    expect(got.status).toBe(404);
    expect((await json(got)).error.code).toBe("unknown_session");
    const tr = await fetch(`${base}/v1/sessions/${id}/transcript`);
    expect(tr.status).toBe(404);
    expect((await json(tr)).error.code).toBe("unknown_session");
    const rec = await fetch(`${base}/v1/sessions/${id}/turns/1`);
    expect(rec.status).toBe(404);
    expect((await json(rec)).error.code).toBe("unknown_session");
    const turn = await fetch(`${base}/v1/sessions/${id}/turns`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ prompt: "anyone there?" }),
    });
    expect(turn.status).toBe(404);
    expect((await json(turn)).error.code).toBe("unknown_session");
  });

  it("pagination: ?after=<seq>&limit=<n> slices a multi-turn transcript", async () => {
    const id = await newSession();
    await runTurn(id, "one");
    await runTurn(id, "two");
    await runTurn(id, "three");
    // Three (user, assistant) pairs, seq 1..6, no system seed.
    expect((await transcript(id)).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    // limit caps the batch from the start.
    expect((await transcript(id, "?limit=2")).map((m) => m.seq)).toEqual([1, 2]);

    // after skips everything up to and including that seq.
    expect((await transcript(id, "?after=4")).map((m) => m.seq)).toEqual([5, 6]);

    // Combined: forward paging in one client-side loop.
    const paged: number[] = [];
    let after = 0;
    for (;;) {
      const batch = await transcript(id, `?after=${after}&limit=2`);
      if (batch.length === 0) break;
      for (const m of batch) {
        paged.push(m.seq);
        after = m.seq;
      }
      expect(batch.length).toBeLessThanOrEqual(2);
    }
    expect(paged).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
