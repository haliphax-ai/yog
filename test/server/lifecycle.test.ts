import { describe, expect, it, beforeEach, afterEach, beforeAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/server/store/sessions.ts";
import { openStream, sendMessage } from "../messages-helper.ts";

/**
 * Phase 5 lifecycle tests — STORE-level detach/purge/revive semantics (§4.5)
 * and ROUTE-level contract wiring (§4.6).
 *
 * Store-level assertions (GREEN part A):
 *   - detach: status dormant, detached_at stamped, nothing forfeited,
 *     idempotent
 *   - purge: immediate irreversible delete, cascades to turns,
 *     turn_events, session_messages
 *   - revive: status open, detached_at cleared (via store.reviveSession and
 *     the addTurn revive flag), idempotent, resets the retention clock
 *   - prune: targets dormant sessions with detached_at < cutoff, cascade
 *     includes session_messages
 *
 * Route-level assertions (GREEN part B — HTTP adapter wiring):
 *   - POST /v1/sessions accepts { title?, system? }; system seeds the first
 *     transcript message (role system)
 *   - GET /v1/sessions/{id}/transcript: the rehydration dump, pagination via
 *     ?after=<seq>&limit=<n>, readable while the row exists — including
 *     dormant sessions within retention — 404 unknown_session only after
 *     purge/prune
 *   - DELETE /v1/sessions/{id} is an idempotent detach; ?purge=true hard
 *     deletes; unknown id → 404 unknown_session
 *   - POST /v1/sessions/{id}/turns on a dormant session implicitly revives
 *     it (no session_closed 409; unknown id → 404 unknown_session)
 *   - capabilities advertise features: ["sse", "transcript"]
 */

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-lifecycle-"));
  store = await SessionStore.open(join(dir, "sessions.db"));
});

afterEach(async () => {
  store?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("store: detach (§4.5)", () => {
  it("detachSession stamps detached_at and sets status dormant, forfeiting nothing", async () => {
    const session = (await store.createSession({ title: "detach" })) as any;
    await store.appendMessages(session.id, [{ role: "user", content: "q" }]);
    await store.addTurn(session.id, { role: "user", content: "hello", status: "done" });

    await store.detachSession(session.id);

    const after = (await store.getSession(session.id)) as any;
    expect(after.status).toBe("dormant");
    expect(after.detached_at).toBeTruthy();
    // nothing forfeited: transcript, turns, and events all stay
    expect(await store.getTranscript(session.id)).toHaveLength(1);
    expect(await store.listTurns(session.id)).toHaveLength(1);
  });

  it("detachSession is idempotent: a second call is a no-op, not an error", async () => {
    const session = (await store.createSession({ title: "twice" })) as any;

    await store.detachSession(session.id);
    const first = (await store.getSession(session.id)) as any;
    await store.detachSession(session.id);
    const second = (await store.getSession(session.id)) as any;

    expect(second.status).toBe("dormant");
    expect(second.detached_at).toBe(first.detached_at);
  });

  it("detachSession accepts an explicit timestamp override (retention tests)", async () => {
    const session = (await store.createSession({ title: "old" })) as any;
    const past = Date.now() - 40 * 24 * 60 * 60 * 1000;

    await store.detachSession(session.id, past);

    const after = (await store.getSession(session.id)) as any;
    expect(after.status).toBe("dormant");
    expect(after.detached_at).toBe(past);
  });
});

describe("store: purge (§4.5)", () => {
  it("purgeSession deletes the row immediately and cascades to turns, turn_events, session_messages", async () => {
    const session = (await store.createSession({ title: "purge-me" })) as any;
    await store.appendMessages(session.id, [{ role: "user", content: "q" }]);
    await store.addTurn(session.id, { role: "user", content: "hello", status: "done" });
    await store.addEvent(session.id, { type: "message.delta", payload: "hi" });

    const deleted = await store.purgeSession(session.id);

    expect(deleted).toBe(1);
    expect(await store.getSession(session.id)).toBeNull();
    expect(await store.listTurns(session.id)).toHaveLength(0);
    expect(await store.listEvents(session.id)).toHaveLength(0);
    expect(await store.getTranscript(session.id)).toHaveLength(0);
  });

  it("purgeSession on an unknown id returns 0 and touches nothing", async () => {
    const session = (await store.createSession({ title: "untouched" })) as any;

    expect(await store.purgeSession("no-such-id")).toBe(0);
    expect(await store.getSession(session.id)).not.toBeNull();
  });

  it("purgeSession is irreversible: the same id stays gone after a store reopen", async () => {
    const dbPath = join(dir, "sessions.db");
    const session = (await store.createSession({ title: "gone" })) as any;
    await store.purgeSession(session.id);
    store.close();

    const reopened = await SessionStore.open(dbPath);
    expect(await reopened.getSession(session.id)).toBeNull();
    reopened.close();
  });
});

describe("store: revive (§4.5, implicit via the turn path)", () => {
  it("reviveSession flips dormant → open and clears detached_at (idempotent on open)", async () => {
    const session = (await store.createSession({ title: "revive" })) as any;
    await store.detachSession(session.id);
    expect(((await store.getSession(session.id)) as any).status).toBe("dormant");

    await store.reviveSession(session.id);
    const revived = (await store.getSession(session.id)) as any;
    expect(revived.status).toBe("open");
    expect(revived.detached_at).toBeNull();

    // idempotent on an already-open session: no error, stays open
    await store.reviveSession(session.id);
    const again = (await store.getSession(session.id)) as any;
    expect(again.status).toBe("open");
    expect(again.detached_at).toBeNull();
  });

  it("addTurn({revive: true}) on a dormant session reopens it and clears detached_at", async () => {
    const session = (await store.createSession({ title: "implicit" })) as any;
    await store.detachSession(session.id);

    await store.addTurn(session.id, {
      role: "user",
      content: "back again",
      status: "running",
      revive: true,
    });

    const after = (await store.getSession(session.id)) as any;
    expect(after.status).toBe("open");
    expect(after.detached_at).toBeNull();
  });

  it("revival resets the retention clock: a revived session survives a cutoff prune", async () => {
    const session = (await store.createSession({ title: "zombie" })) as any;
    await store.appendMessages(session.id, [{ role: "user", content: "still here" }]);
    await store.detachSession(session.id, Date.now() - 40 * 24 * 60 * 60 * 1000);

    // 40 days dormant → inside the prune window right now
    await store.pruneOldSessions();
    expect(await store.getSession(session.id)).toBeNull();

    // revival path resets the clock: detach old, revive, then prune again —
    // the session must survive because detached_at was cleared.
    const revived = (await store.createSession({ title: "revived-clock" })) as any;
    await store.detachSession(revived.id, Date.now() - 40 * 24 * 60 * 60 * 1000);
    await store.reviveSession(revived.id);
    await store.pruneOldSessions();
    expect(await store.getSession(revived.id)).not.toBeNull();
    expect(((await store.getSession(revived.id)) as any).detached_at).toBeNull();
  });
});

describe("store: retention re-key (§4.5)", () => {
  it("pruneOldSessions targets dormant sessions with detached_at < 30-day cutoff only", async () => {
    const doomed = (await store.createSession({ title: "doomed" })) as any;
    const fresh = (await store.createSession({ title: "fresh" })) as any;
    const freshDetached = (await store.createSession({ title: "fresh-detached" })) as any;

    await store.appendMessages(doomed.id, [{ role: "user", content: "bye" }]);
    await store.appendMessages(fresh.id, [{ role: "user", content: "hi" }]);
    await store.appendMessages(freshDetached.id, [{ role: "user", content: "hi" }]);

    await store.detachSession(doomed.id, Date.now() - 31 * 24 * 60 * 60 * 1000);
    await store.detachSession(freshDetached.id, Date.now() - 5 * 24 * 60 * 60 * 1000);

    await store.pruneOldSessions();

    expect(await store.getSession(doomed.id)).toBeNull();
    expect(await store.getSession(fresh.id)).not.toBeNull();
    expect(await store.getSession(freshDetached.id)).not.toBeNull();
    // the cascade removed the doomed session's transcript too
    expect(await store.getTranscript(doomed.id)).toHaveLength(0);
    expect(await store.listTurns(doomed.id)).toHaveLength(0);
    expect(await store.listEvents(doomed.id)).toHaveLength(0);
  });

  it("pruneOldSessions ignores open sessions regardless of age", async () => {
    const open = (await store.createSession({ title: "old-but-open" })) as any;
    // An open session must never be pruned, even if its only timestamps are ancient.
    const raw = (store as unknown as { db: { table: (t: string) => any } }).db;
    await raw.table("sessions").where("id", open.id).update({ created_at: 1000, updated_at: 1000 });

    await store.pruneOldSessions();

    expect(await store.getSession(open.id)).not.toBeNull();
  });
});

describe("event persistence dedup (§4.8)", () => {
  it("bus subscriber delivers only — does not persist (the sink is the sole writer)", async () => {
    const { createHttpServer } = await import("../../src/server/http.ts");
    const { EventEmitter } = await import("node:events");
    const persisted: any[] = [];
    const store = {
      createSession: () => ({ id: "s-dedup", status: "open", created_at: 1, updated_at: 1 }),
      getSession: (id: string) => ({ id, status: "open", created_at: 1, updated_at: 1 }),
      addEvent: (sessionId: string, ev: any) => {
        persisted.push({ sessionId, ev });
      },
    };
    const bus = new EventEmitter();
    // Mirrors serve.ts executeTurn: the sink persists once, then publishes.
    const orchestrator = {
      runTurn: (sessionId: string) => {
        bus.emit(`session:${sessionId}`, {
          id: 1,
          type: "turn.started",
          version: 1,
          ts: Date.now(),
          data: { turnId: "t1" },
        });
        return { promise: Promise.resolve(), abort: () => {} };
      },
    };
    const server = createHttpServer({
      capabilities: {
        contractVersion: "v1",
        models: [],
        tools: [],
        features: ["messages", "stream"],
      },
      store,
      orchestrator,
      bus,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      const stream = await openStream(base, "s-dedup");
      const res = await sendMessage(base, "s-dedup", "turn.start", { prompt: "hi" });
      expect(res.status).toBe(202);
      await stream.collectUntil((fs) => fs.some((f) => f.event === "turn.started"), 5_000);
      stream.abort();
      // delivery worked (SSE got the frame)…
      // …but the bus subscriber did NOT persist: zero addEvent calls.
      // …but the bus subscriber did NOT persist: zero addEvent calls.
      expect(persisted).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("routes: phase 5 part B (§4.6)", () => {
  let createHttpServer: typeof import("../../src/server/http.ts").createHttpServer;

  beforeAll(async () => {
    ({ createHttpServer } = await import("../../src/server/http.ts"));
  });

  const jsonBody = async (res: Response): Promise<any> => JSON.parse(await res.text());

  /** Boot the adapter against the block-scoped `store` + a no-op orchestrator. */
  async function listen(): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createHttpServer({
      orchestrator: { runTurn: () => ({ promise: Promise.resolve(), abort: () => {} }) },
      store,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  it("capabilities default advertises features: messages + stream + messageTypes", async () => {
    const { url, close } = await listen();
    try {
      const body = await jsonBody(await fetch(`${url}/v1/capabilities`));
      expect(body.features).toContain("messages");
      expect(body.features).toContain("stream");
      expect(body.messageTypes).toContain("turn.start");
    } finally {
      await close();
    }
  });

  it("POST /v1/sessions accepts { title, system }: system seeds the first transcript message", async () => {
    const { url, close } = await listen();
    try {
      const res = await fetch(`${url}/v1/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "seeded", system: "you are terse" }),
      });
      expect(res.status).toBe(201);
      const body = await jsonBody(res);
      const tr = await store.getTranscript(body.session.id);
      expect(tr).toHaveLength(1);
      expect(tr[0].role).toBe("system");
      expect(tr[0].content).toBe("you are terse");
    } finally {
      await close();
    }
  });

  it("transcript.get returns the rehydration dump with wire-shaped messages", async () => {
    const { url, close } = await listen();
    try {
      const { session } = await jsonBody(
        await fetch(`${url}/v1/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ system: "be brief" }),
        }),
      );
      await store.appendMessages(session.id, [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } },
          ],
        } as any,
        { role: "tool", content: "ok", tool_call_id: "call_1", name: "bash" } as any,
        { role: "assistant", content: "done" },
      ]);
      const res = await sendMessage(url, session.id, "transcript.get");
      expect(res.status).toBe(200);
      const body = (await jsonBody(res)).data;
      expect(body.session.id).toBe(session.id);
      expect(body.messages).toHaveLength(4);
      expect(body.messages[0]).toMatchObject({ seq: 1, role: "system", content: "be brief" });
      const toolCallMsg = body.messages[1];
      expect(toolCallMsg.turnId).toBeNull();
      expect(toolCallMsg.toolCalls[0].id).toBe("call_1");
      expect(body.messages[2]).toMatchObject({ toolCallId: "call_1", name: "bash" });
    } finally {
      await close();
    }
  });

  it("transcript.get paginates via afterSeq/limit", async () => {
    const { url, close } = await listen();
    try {
      const { session } = await jsonBody(await fetch(`${url}/v1/sessions`, { method: "POST" }));
      await store.appendMessages(session.id, [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: "four" },
      ]);

      const page = (
        await jsonBody(
          await sendMessage(url, session.id, "transcript.get", { afterSeq: 1, limit: 2 }),
        )
      ).data;
      expect(page.messages.map((m: any) => m.content)).toEqual(["two", "three"]);

      const tail = (
        await jsonBody(await sendMessage(url, session.id, "transcript.get", { afterSeq: 4 }))
      ).data;
      expect(tail.messages).toEqual([]);
    } finally {
      await close();
    }
  });

  it("transcript.get stays readable on a dormant session within retention (404 only after purge/prune)", async () => {
    const { url, close } = await listen();
    try {
      const { session } = await jsonBody(await fetch(`${url}/v1/sessions`, { method: "POST" }));
      await store.appendMessages(session.id, [{ role: "user", content: "still there?" }]);
      await sendMessage(url, session.id, "session.detach");
      const dorm = (await jsonBody(await sendMessage(url, session.id, "transcript.get"))).data;
      expect(dorm.session.status).toBe("dormant");
      expect(dorm.messages).toHaveLength(1);

      await store.purgeSession(session.id);
      const gone = await sendMessage(url, session.id, "transcript.get");
      expect(gone.status).toBe(404);
      expect((await jsonBody(gone)).error.code).toBe("unknown_session");
    } finally {
      await close();
    }
  });

  it("session.detach with purge hard-deletes; a second detach is idempotent; unknown id → 404", async () => {
    const { url, close } = await listen();
    try {
      const { session } = await jsonBody(await fetch(`${url}/v1/sessions`, { method: "POST" }));
      const purge = await sendMessage(url, session.id, "session.detach", { purge: true });
      expect(purge.status).toBe(200);
      const purged = (await jsonBody(purge)).data;
      expect(purged.deleted).toBe(true);

      const gone = await sendMessage(url, session.id, "session.get");
      expect(gone.status).toBe(404);

      // Detach after a purge target is gone → still 404 (unknown_session).
      const missing = await sendMessage(url, "no-such-session", "session.detach");
      expect(missing.status).toBe(404);

      // Detach on a live session is idempotent: both calls return the
      // dormant session, and a second call keeps the original detached_at.
      const s2 = (await jsonBody(await fetch(`${url}/v1/sessions`, { method: "POST" }))).session;
      const d1 = (await jsonBody(await sendMessage(url, s2.id, "session.detach"))).data;
      expect(d1.session.status).toBe("dormant");
      expect(d1.session.detached_at).toBeTruthy();
      const d2 = (await jsonBody(await sendMessage(url, s2.id, "session.detach"))).data;
      expect(d2.session.detached_at).toBe(d1.session.detached_at);
    } finally {
      await close();
    }
  });

  it("turn.start on a dormant session revives it (open, detached_at cleared)", async () => {
    const { url, close } = await listen();
    try {
      const { session } = await jsonBody(await fetch(`${url}/v1/sessions`, { method: "POST" }));
      await store.appendMessages(session.id, [{ role: "user", content: "earlier" }]);
      await sendMessage(url, session.id, "session.detach");
      expect(((await store.getSession(session.id)) as any).status).toBe("dormant");

      const stream = await openStream(url, session.id);
      const res = await sendMessage(url, session.id, "turn.start", { prompt: "back" });
      expect(res.status).toBe(202);
      // The no-op orchestrator resolves without framing turn.finished;
      // revive is synchronous in startTurn, so no stream wait is needed.
      stream.abort();
      stream.abort();

      const after = (await store.getSession(session.id)) as any;
      expect(after.status).toBe("open");
      expect(after.detached_at).toBeNull();
    } finally {
      await close();
    }
  });

  it("turn.start on an unknown session → 404 unknown_session (no dormancy rejection, ever)", async () => {
    const { url, close } = await listen();
    try {
      const res = await sendMessage(url, "no-such-session", "turn.start", { prompt: "hi" });
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).error.code).toBe("unknown_session");
    } finally {
      await close();
    }
  });
});
