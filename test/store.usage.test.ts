import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionsDb, SessionStore } from "../src/server/store/sessions.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-usage-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("migration 004: turn usage + per-call tokens schema", () => {
  it("adds nullable usage columns to turns and tokens to session_messages", async () => {
    const db = await openSessionsDb(join(dir, "schema.db"));
    const turnsCols: any = await db.raw("PRAGMA table_info(turns)");
    const turnNames = (Array.isArray(turnsCols) ? turnsCols : []).map((c: any) => c.name);
    expect(turnNames).toContain("prompt_tokens");
    expect(turnNames).toContain("completion_tokens");
    expect(turnNames).toContain("total_tokens");

    const msgCols: any = await db.raw("PRAGMA table_info(session_messages)");
    const msgNames = (Array.isArray(msgCols) ? msgCols : []).map((c: any) => c.name);
    expect(msgNames).toContain("tokens");

    db.destroy();
  });
});

describe("SessionStore finishTurn usage persistence", () => {
  it("persists usage on finish and reads it back after reopen", async () => {
    const dbPath = join(dir, "usage.db");
    const store = await SessionStore.open(dbPath);
    const session = (await store.createSession({ title: "u" })) as any;
    const turn = (await store.addTurn(session.id, {
      role: "user",
      content: "hi",
      status: "running",
    })) as any;
    await store.finishTurn(session.id, turn.id, "finished", {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    });
    const row = await store.getTurn(turn.id);
    expect(row.prompt_tokens).toBe(10);
    expect(row.completion_tokens).toBe(20);
    expect(row.total_tokens).toBe(30);
    expect(row.status).toBe("finished");
    expect(typeof row.duration_ms).toBe("number");
    store.close();

    const reopened = await SessionStore.open(dbPath);
    const again = await reopened.getTurn(turn.id);
    expect(again.prompt_tokens).toBe(10);
    expect(again.completion_tokens).toBe(20);
    expect(again.total_tokens).toBe(30);
    reopened.close();
  });

  it("leaves usage columns NULL when the provider sent none", async () => {
    const store = await SessionStore.open(join(dir, "none.db"));
    const session = (await store.createSession()) as any;
    const turn = (await store.addTurn(session.id, {
      role: "user",
      content: "hi",
      status: "running",
    })) as any;
    await store.finishTurn(session.id, turn.id, "finished");
    const row = await store.getTurn(turn.id);
    expect(row.prompt_tokens).toBeNull();
    expect(row.completion_tokens).toBeNull();
    expect(row.total_tokens).toBeNull();
    store.close();
  });

  it("preserves partial usage fields (only the provided fields are written)", async () => {
    const store = await SessionStore.open(join(dir, "partial.db"));
    const session = (await store.createSession()) as any;
    const turn = (await store.addTurn(session.id, {
      role: "user",
      content: "hi",
      status: "running",
    })) as any;
    await store.finishTurn(session.id, turn.id, "finished", { total_tokens: 99 });
    const row = await store.getTurn(turn.id);
    expect(row.total_tokens).toBe(99);
    expect(row.prompt_tokens).toBeNull();
    expect(row.completion_tokens).toBeNull();
    store.close();
  });
});

describe("session_messages legacy tokens field", () => {
  it("ignores a tokens field on appended messages and never re-exposes it", async () => {
    const store = await SessionStore.open(join(dir, "tokens.db"));
    const session = (await store.createSession()) as any;
    const turn = (await store.addTurn(session.id, {
      role: "user",
      content: "q",
      status: "running",
    })) as any;
    // A caller (or a pre-existing fixture) may still carry the removed
    // per-call `tokens` field; the store must ignore it, not persist or
    // surface it — per-call attribution no longer exists on the wire.
    await store.appendMessages(
      session.id,
      [
        { role: "user", content: "q" },
        { role: "tool", tool_call_id: "c1", name: "bash", content: "{}", tokens: 7 } as any,
      ],
      turn.id,
    );
    const rows = await store.getTranscript(session.id);
    expect(rows[1]?.tokens).toBeUndefined();
    // The wire dump must never include a `tokens` key, even when the
    // appended message carried one.
    const wired = await store.getTranscript(session.id, {});
    expect(wired[1]?.tokens).toBeUndefined();
    store.close();
  });
});

describe("listTurnUsages", () => {
  it("returns persisted usage + duration from finished turn columns", async () => {
    const store = await SessionStore.open(join(dir, "cols.db"));
    const session = (await store.createSession()) as any;
    const turn = (await store.addTurn(session.id, {
      role: "user",
      content: "q",
      status: "running",
    })) as any;
    await store.finishTurn(session.id, turn.id, "finished", {
      prompt_tokens: 1,
      completion_tokens: 2,
      total_tokens: 3,
    });
    const metrics = await store.listTurnUsages(session.id);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.turnId).toBe(turn.id);
    expect(metrics[0]?.usage).toEqual({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
    expect(typeof metrics[0]?.durationMs).toBe("number");
    store.close();
  });

  it("falls back to stored turn.finished event usage when turn columns are unset", async () => {
    const store = await SessionStore.open(join(dir, "events.db"));
    const session = (await store.createSession()) as any;
    const turn = (await store.addTurn(session.id, {
      role: "user",
      content: "q",
      status: "running",
    })) as any;
    await store.addEvent(session.id, {
      type: "turn.finished",
      payload: JSON.stringify({
        turnId: "wire-id",
        durationMs: 5,
        usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
      }),
    });
    const metrics = await store.listTurnUsages(session.id);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.turnId).toBe(turn.id);
    expect(metrics[0]?.usage).toEqual({ prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
    store.close();
  });

  it("falls back to stored turn.aborted event usage when turn columns are unset", async () => {
    const store = await SessionStore.open(join(dir, "aborted-events.db"));
    const session = (await store.createSession()) as any;
    const turn = (await store.addTurn(session.id, {
      role: "user",
      content: "q",
      status: "running",
    })) as any;
    await store.addEvent(session.id, {
      type: "turn.aborted",
      payload: JSON.stringify({
        turnId: "wire-id",
        reason: "turn aborted by operator",
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
    });
    const metrics = await store.listTurnUsages(session.id);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.turnId).toBe(turn.id);
    expect(metrics[0]?.usage).toEqual({ prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
    store.close();
  });

  it("omits turns that have neither usage nor duration", async () => {
    const store = await SessionStore.open(join(dir, "empty.db"));
    const session = (await store.createSession()) as any;
    await store.addTurn(session.id, { role: "user", content: "q", status: "running" });
    const metrics = await store.listTurnUsages(session.id);
    expect(metrics).toEqual([]);
    store.close();
  });
});
