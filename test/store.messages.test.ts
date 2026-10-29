import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { openSessionsDb, SessionStore } from "../src/server/store/sessions.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-messages-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("migration 002: session_messages schema", () => {
  it("creates session_messages with the plan's exact columns, FK, and unique index", async () => {
    // Open runs the migration chain itself (§4.1).
    const db = await openSessionsDb(join(dir, "schema.db"));

    const cols: any = await db.raw("PRAGMA table_info(session_messages)");
    const rows = Array.isArray(cols) ? cols : [];
    const names = rows.map((c: any) => c.name);
    expect(names).toEqual([
      "id",
      "session_id",
      "turn_id",
      "seq",
      "role",
      "content",
      "tool_call_id",
      "name",
      "tool_calls_json",
      "created_at",
    ]);

    const m: any = Object.fromEntries(rows.map((c: any) => [c.name, c]));
    expect(m.id.pk).toBe(1);
    expect(m.session_id.notnull).toBe(1);
    expect(m.turn_id.notnull).toBe(0);
    expect(m.seq.notnull).toBe(1);
    expect(m.role.notnull).toBe(1);
    expect(m.content.notnull).toBe(0);
    expect(m.created_at.notnull).toBe(1);

    const fks: any = await db.raw("PRAGMA foreign_key_list(session_messages)");
    const fk = (Array.isArray(fks) ? fks : []).find((f: any) => f.table === "sessions");
    expect(fk?.from).toBe("session_id");
    expect(fk?.on_delete).toBe("CASCADE");

    const idx: any = await db.raw(
      "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_session_messages_session_seq'",
    );
    expect((Array.isArray(idx) ? idx : [])[0].sql).toContain("UNIQUE");

    db.destroy();
  });

  it("renames status 'closed' to 'dormant' for rows seeded pre-migration", async () => {
    const dbPath = join(dir, "status.db");
    const raw = new Database(dbPath);
    raw.exec(
      `CREATE TABLE sessions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
      )`,
    );
    raw.exec(
      `INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s1', 'closed', 1, 1)`,
    );
    raw.exec(
      `INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s2', 'open', 1, 1)`,
    );
    raw.close();

    const db = await openSessionsDb(dbPath);

    const rows: any = await db.raw("SELECT id, status FROM sessions ORDER BY id");
    const arr = Array.isArray(rows) ? rows : [];
    const byId = Object.fromEntries(arr.map((r: any) => [r.id, r.status]));
    expect(byId["s1"]).toBe("dormant");
    expect(byId["s2"]).toBe("open");

    db.destroy();
  });

  it("appendMessages assigns seq from MAX(seq)+1, inserts in one transaction, returns persisted rows", async () => {
    const dbPath = join(dir, "append.db");
    const store = await SessionStore.open(dbPath);
    const session = (await store.createSession({ title: "t" })) as any;

    const rows = await store.appendMessages(
      session.id,
      [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      42,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0].seq).toBe(1);
    expect(rows[1].seq).toBe(2);
    expect(rows[0].turn_id).toBe(42);
    expect(rows[1].turn_id).toBe(42);
    expect(rows[0].content).toBe("hello");
    expect(rows[1].content).toBe("hi");

    // A second batch continues from MAX(seq)+1, never reset.
    const rows2 = await store.appendMessages(session.id, [{ role: "user", content: "again" }]);
    expect(rows2).toHaveLength(1);
    expect(rows2[0].seq).toBe(3);

    store.close();
  });

  it("appendMessages continues seq across dormancy (never reset per lifecycle)", async () => {
    const dbPath = join(dir, "dormant.db");
    const store = await SessionStore.open(dbPath);
    const session = (await store.createSession({ title: "t" })) as any;

    await store.appendMessages(session.id, [{ role: "user", content: "first" }]);
    await store.detachSession(session.id);

    // Reopen the same store (simulating daemon restart): seq continues.
    const store2 = await SessionStore.open(dbPath);
    const rows = await store2.appendMessages(session.id, [{ role: "user", content: "second" }]);
    expect(rows).toHaveLength(1);
    expect(rows[0].seq).toBe(2);

    store2.close();
  });

  it("getTranscript returns ordered rows mapped to ChatCompletionMessageParam plus metadata", async () => {
    const dbPath = join(dir, "trans.db");
    const store = await SessionStore.open(dbPath);
    const session = (await store.createSession({ title: "t" })) as any;

    await store.appendMessages(
      session.id,
      [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
      7,
    );

    const all = await store.getTranscript(session.id);
    expect(all).toHaveLength(3);
    expect(all.map((r: any) => r.seq)).toEqual([1, 2, 3]);
    expect(all.map((r: any) => r.turnId)).toEqual([7, 7, 7]);
    expect(all[0].role).toBe("user");
    expect(all[0].content).toBe("q1");
    expect(all[0].ts).toBeGreaterThan(0);

    // afterSeq pages forward.
    const after = await store.getTranscript(session.id, { afterSeq: 1 });
    expect(after).toHaveLength(2);
    expect(after[0].seq).toBe(2);

    // limit caps the batch.
    const limited = await store.getTranscript(session.id, { limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].seq).toBe(1);

    store.close();
  });

  it("getTranscript maps tool_calls and tool_call_id to the param shape", async () => {
    const dbPath = join(dir, "tools.db");
    const store = await SessionStore.open(dbPath);
    const session = (await store.createSession({ title: "t" })) as any;

    await store.appendMessages(session.id, [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", content: "{}", tool_call_id: "call_1", name: "f" } as any,
    ]);

    const all = await store.getTranscript(session.id);
    expect(all).toHaveLength(2);
    expect(all[0].role).toBe("assistant");
    expect(all[0].content).toBeUndefined();
    expect(all[0].tool_calls).toHaveLength(1);
    expect(all[0].tool_calls[0].id).toBe("call_1");
    expect(all[1].role).toBe("tool");
    expect(all[1].tool_call_id).toBe("call_1");
    expect(all[1].name).toBe("f");

    store.close();
  });

  it("pruneOldSessions cascades: session_messages rows are removed with their sessions", async () => {
    const dbPath = join(dir, "prune.db");
    const store = await SessionStore.open(dbPath);
    const s1 = (await store.createSession({ title: "old" })) as any;
    const s2 = (await store.createSession({ title: "keep" })) as any;

    await store.appendMessages(s1.id, [{ role: "user", content: "bye" }]);
    await store.appendMessages(s2.id, [{ role: "user", content: "hi" }]);

    // Force s1 into the retention window: detached_at far in the past.
    await store.detachSession(s1.id, Date.now() - 31 * 24 * 60 * 60 * 1000);

    await store.pruneOldSessions();

    expect(await store.getSession(s1.id)).toBeNull();
    expect(await store.getSession(s2.id)).not.toBeNull();

    const remaining = await store.getTranscript(s2.id);
    expect(remaining).toHaveLength(1);

    store.close();
  });

  it("interleaved rapid appendMessages calls never collide or duplicate a seq", async () => {
    const dbPath = join(dir, "race.db");
    const store = await SessionStore.open(dbPath);
    const session = (await store.createSession({ title: "t" })) as any;

    const N = 50;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        Promise.resolve().then(() =>
          store.appendMessages(session.id, [{ role: "user", content: `m${i}` }]),
        ),
      );
    }
    const results = await Promise.all(promises);
    expect(results).toHaveLength(N);

    const all = await store.getTranscript(session.id);
    expect(all).toHaveLength(N);
    const seqs = all.map((r: any) => r.seq);
    expect(new Set(seqs).size).toBe(N);
    expect(Math.min(...seqs)).toBe(1);
    expect(Math.max(...seqs)).toBe(N);

    store.close();
  });
});
