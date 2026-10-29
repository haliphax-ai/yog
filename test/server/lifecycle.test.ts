import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/server/store/sessions.ts";

/**
 * Phase 5 GREEN part A — STORE-level detach/purge/revive semantics (§4.5).
 *
 * Route-level cases (DELETE /v1/sessions/{id}[?purge=true], POST turns
 * revive, GET transcript-on-dormant) are covered by task 11 (route wiring);
 * this file's route-level section is expected RED until then.
 *
 * Store-level assertions (this task's GREEN scope):
 *   - detach: status dormant, detached_at stamped, nothing forfeited,
 *     idempotent
 *   - purge: immediate irreversible delete, cascades to turns,
 *     turn_events, session_messages
 *   - revive: status open, detached_at cleared (via store.reviveSession and
 *     the addTurn revive flag), idempotent, resets the retention clock
 *   - prune: targets dormant sessions with detached_at < cutoff, cascade
 *     includes session_messages
 */

let dir: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-lifecycle-"));
  store = new SessionStore(join(dir, "sessions.db"));
});

afterEach(async () => {
  store?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("store: detach (§4.5)", () => {
  it("detachSession stamps detached_at and sets status dormant, forfeiting nothing", () => {
    const session = store.createSession({ title: "detach" }) as any;
    store.appendMessages(session.id, [{ role: "user", content: "q" }]);
    store.addTurn(session.id, { role: "user", content: "hello", status: "done" });

    store.detachSession(session.id);

    const after = store.getSession(session.id) as any;
    expect(after.status).toBe("dormant");
    expect(after.detached_at).toBeTruthy();
    // nothing forfeited: transcript, turns, and events all stay
    expect(store.getTranscript(session.id)).toHaveLength(1);
    expect(store.listTurns(session.id)).toHaveLength(1);
  });

  it("detachSession is idempotent: a second call is a no-op, not an error", () => {
    const session = store.createSession({ title: "twice" }) as any;

    store.detachSession(session.id);
    const first = store.getSession(session.id) as any;
    store.detachSession(session.id);
    const second = store.getSession(session.id) as any;

    expect(second.status).toBe("dormant");
    expect(second.detached_at).toBe(first.detached_at);
  });

  it("detachSession accepts an explicit timestamp override (retention tests)", () => {
    const session = store.createSession({ title: "old" }) as any;
    const past = Date.now() - 40 * 24 * 60 * 60 * 1000;

    store.detachSession(session.id, past);

    const after = store.getSession(session.id) as any;
    expect(after.status).toBe("dormant");
    expect(after.detached_at).toBe(past);
  });
});

describe("store: purge (§4.5)", () => {
  it("purgeSession deletes the row immediately and cascades to turns, turn_events, session_messages", () => {
    const session = store.createSession({ title: "purge-me" }) as any;
    store.appendMessages(session.id, [{ role: "user", content: "q" }]);
    store.addTurn(session.id, { role: "user", content: "hello", status: "done" });
    store.addEvent(session.id, { type: "message.delta", payload: "hi" });

    const deleted = store.purgeSession(session.id);

    expect(deleted).toBe(1);
    expect(store.getSession(session.id)).toBeNull();
    expect(store.listTurns(session.id)).toHaveLength(0);
    expect(store.listEvents(session.id)).toHaveLength(0);
    expect(store.getTranscript(session.id)).toHaveLength(0);
  });

  it("purgeSession on an unknown id returns 0 and touches nothing", () => {
    const session = store.createSession({ title: "untouched" }) as any;

    expect(store.purgeSession("no-such-id")).toBe(0);
    expect(store.getSession(session.id)).not.toBeNull();
  });

  it("purgeSession is irreversible: the same id stays gone after a store reopen", () => {
    const dbPath = join(dir, "sessions.db");
    const session = store.createSession({ title: "gone" }) as any;
    store.purgeSession(session.id);
    store.close();

    const reopened = new SessionStore(dbPath);
    expect(reopened.getSession(session.id)).toBeNull();
    reopened.close();
  });
});

describe("store: revive (§4.5, implicit via the turn path)", () => {
  it("reviveSession flips dormant → open and clears detached_at (idempotent on open)", () => {
    const session = store.createSession({ title: "revive" }) as any;
    store.detachSession(session.id);
    expect((store.getSession(session.id) as any).status).toBe("dormant");

    store.reviveSession(session.id);
    const revived = store.getSession(session.id) as any;
    expect(revived.status).toBe("open");
    expect(revived.detached_at).toBeNull();

    // idempotent on an already-open session: no error, stays open
    store.reviveSession(session.id);
    const again = store.getSession(session.id) as any;
    expect(again.status).toBe("open");
    expect(again.detached_at).toBeNull();
  });

  it("addTurn({revive: true}) on a dormant session reopens it and clears detached_at", () => {
    const session = store.createSession({ title: "implicit" }) as any;
    store.detachSession(session.id);

    store.addTurn(session.id, {
      role: "user",
      content: "back again",
      status: "running",
      revive: true,
    });

    const after = store.getSession(session.id) as any;
    expect(after.status).toBe("open");
    expect(after.detached_at).toBeNull();
  });

  it("revival resets the retention clock: a revived session survives a cutoff prune", () => {
    const session = store.createSession({ title: "zombie" }) as any;
    store.appendMessages(session.id, [{ role: "user", content: "still here" }]);
    store.detachSession(session.id, Date.now() - 40 * 24 * 60 * 60 * 1000);

    // 40 days dormant → inside the prune window right now
    store.pruneOldSessions();
    expect(store.getSession(session.id)).toBeNull();

    // revival path resets the clock: detach old, revive, then prune again —
    // the session must survive because detached_at was cleared.
    const revived = store.createSession({ title: "revived-clock" }) as any;
    store.detachSession(revived.id, Date.now() - 40 * 24 * 60 * 60 * 1000);
    store.reviveSession(revived.id);
    store.pruneOldSessions();
    expect(store.getSession(revived.id)).not.toBeNull();
    expect((store.getSession(revived.id) as any).detached_at).toBeNull();
  });
});

describe("store: retention re-key (§4.5)", () => {
  it("pruneOldSessions targets dormant sessions with detached_at < 30-day cutoff only", () => {
    const doomed = store.createSession({ title: "doomed" }) as any;
    const fresh = store.createSession({ title: "fresh" }) as any;
    const freshDetached = store.createSession({ title: "fresh-detached" }) as any;

    store.appendMessages(doomed.id, [{ role: "user", content: "bye" }]);
    store.appendMessages(fresh.id, [{ role: "user", content: "hi" }]);
    store.appendMessages(freshDetached.id, [{ role: "user", content: "hi" }]);

    store.detachSession(doomed.id, Date.now() - 31 * 24 * 60 * 60 * 1000);
    store.detachSession(freshDetached.id, Date.now() - 5 * 24 * 60 * 60 * 1000);

    store.pruneOldSessions();

    expect(store.getSession(doomed.id)).toBeNull();
    expect(store.getSession(fresh.id)).not.toBeNull();
    expect(store.getSession(freshDetached.id)).not.toBeNull();
    // the cascade removed the doomed session's transcript too
    expect(store.getTranscript(doomed.id)).toHaveLength(0);
    expect(store.listTurns(doomed.id)).toHaveLength(0);
    expect(store.listEvents(doomed.id)).toHaveLength(0);
  });

  it("pruneOldSessions ignores open sessions regardless of age", () => {
    const open = store.createSession({ title: "old-but-open" }) as any;
    // An open session must never be pruned, even if its only timestamps are ancient.
    const raw = (store as unknown as { db: { prepare(sql: string): any } }).db;
    raw
      .prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(1000, 1000, open.id);

    store.pruneOldSessions();

    expect(store.getSession(open.id)).not.toBeNull();
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
      capabilities: { contractVersion: "v1", models: [], tools: [], features: ["sse"] },
      store,
      orchestrator,
      bus,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/s-dedup/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi" }),
      });
      await res.text();
      // delivery worked (SSE got the frame)…
      expect(res.status).toBe(200);
      // …but the bus subscriber did NOT persist: zero addEvent calls.
      expect(persisted).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
