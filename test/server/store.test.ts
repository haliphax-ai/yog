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
  store = await SessionStore.open(dbPath);
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("SessionStore", () => {
  it("creates, lists and closes sessions", async () => {
    const session = await store.createSession({ title: "first" });
    expect(session.id).toBeTruthy();

    const listed = await store.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe("first");
    expect(listed[0].status).toBe("open");

    await store.detachSession(session.id);
    const afterDetach = await store.listSessions();
    expect(afterDetach[0].status).toBe("dormant");
    expect(afterDetach[0].detached_at).toBeTruthy();
  });

  it("keeps sessions and turns durable across a reopen of the same db file", async () => {
    const session = await store.createSession({ title: "durable" });
    await store.addTurn(session.id, { role: "user", content: "hello", status: "done" });
    await store.addTurn(session.id, { role: "assistant", content: "hi", status: "done" });
    store.close();

    const reopened = await SessionStore.open(dbPath);
    const sessions = await reopened.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("durable");

    const turns = await reopened.listTurns(session.id);
    expect(turns).toHaveLength(2);
    expect(turns[0].prompt).toBe("hello");
    expect(turns[1].prompt).toBe("hi");
    reopened.close();
  });

  it("prunes closed sessions older than 30 days and their turns/events", async () => {
    const oldSession = await store.createSession({ title: "old" });
    await store.addTurn(oldSession.id, { role: "user", content: "ancient", status: "done" });
    await store.addEvent(oldSession.id, { type: "message", payload: "ancient-event" });
    await store.detachSession(oldSession.id, daysAgo(31));

    const recentSession = await store.createSession({ title: "recent" });
    await store.addTurn(recentSession.id, { role: "user", content: "fresh", status: "done" });
    await store.detachSession(recentSession.id, daysAgo(5));

    await store.pruneOldSessions();

    const sessions = await store.listSessions();
    expect(sessions.map((s: { title: string }) => s.title)).toEqual(["recent"]);
    expect(await store.listTurns(oldSession.id)).toHaveLength(0);
    expect(await store.listEvents(oldSession.id)).toHaveLength(0);
    expect(await store.listTurns(recentSession.id)).toHaveLength(1);
  });

  it("marks running turns as interrupted on crash recovery", async () => {
    const session = await store.createSession({ title: "crashy" });
    await store.addTurn(session.id, { role: "assistant", content: "typing...", status: "running" });

    await store.interruptRunningTurns();

    const turns = await store.listTurns(session.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].status).toBe("interrupted");
  });
});
