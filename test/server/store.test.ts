import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/server/store/sessions.ts";

let dir: string;
let dbPath: string;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-store-"));
  dbPath = join(dir, "sessions.db");
  store = new SessionStore(dbPath);
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("SessionStore", () => {
  it("creates, lists and closes sessions", () => {
    const session = store.createSession({ title: "first" });
    expect(session.id).toBeTruthy();

    const listed = store.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("first");
    expect(listed[0].status).toBe("open");

    store.closeSession(session.id);
    const afterClose = store.listSessions();
    expect(afterClose[0].status).toBe("closed");
    expect(afterClose[0].closed_at).toBeTruthy();
  });

  it("keeps sessions and turns durable across a reopen of the same db file", () => {
    const session = store.createSession({ title: "durable" });
    store.addTurn(session.id, { role: "user", content: "hello", status: "done" });
    store.addTurn(session.id, { role: "assistant", content: "hi", status: "done" });
    store.close();

    const reopened = new SessionStore(dbPath);
    const sessions = reopened.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("durable");

    const turns = reopened.listTurns(session.id);
    expect(turns).toHaveLength(2);
    expect(turns[0].content).toBe("hello");
    expect(turns[1].content).toBe("hi");
    reopened.close();
  });

  it("prunes closed sessions older than 30 days and their turns/events", () => {
    const oldSession = store.createSession({ title: "old" });
    store.addTurn(oldSession.id, { role: "user", content: "ancient", status: "done" });
    store.addEvent(oldSession.id, { type: "message", payload: "ancient-event" });
    store.closeSession(oldSession.id, daysAgo(31));

    const recentSession = store.createSession({ title: "recent" });
    store.addTurn(recentSession.id, { role: "user", content: "fresh", status: "done" });
    store.closeSession(recentSession.id, daysAgo(5));

    store.pruneOldSessions();

    const sessions = store.listSessions();
    expect(sessions.map((s: { title: string }) => s.title)).toEqual(["recent"]);
    expect(store.listTurns(oldSession.id)).toHaveLength(0);
    expect(store.listEvents(oldSession.id)).toHaveLength(0);
    expect(store.listTurns(recentSession.id)).toHaveLength(1);
  });

  it("marks running turns as interrupted on crash recovery", () => {
    const session = store.createSession({ title: "crashy" });
    store.addTurn(session.id, { role: "assistant", content: "typing...", status: "running" });

    store.interruptRunningTurns();

    const turns = store.listTurns(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe("interrupted");
  });
});
