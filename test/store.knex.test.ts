import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { openSessionsDb } from "../src/server/store/sessions.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yog-knex-"));
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("openSessionsDb (knex-backed store)", () => {
  it("creates sessions/turns/turn_events tables and indexes on a fresh DB with WAL journal mode", async () => {
    const dbPath = join(dir, "fresh.db");
    // Open runs the migration chain itself (§4.1): tables + indexes exist
    // before the handle is handed back.
    const db = await openSessionsDb(dbPath);

    const tables: any = await db.raw(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const tableNames = (Array.isArray(tables) ? tables : []).map((r: any) => r.name);
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("turns");
    expect(tableNames).toContain("turn_events");

    const indexes: any = await db.raw(
      "SELECT name FROM sqlite_master WHERE type='index' ORDER BY name",
    );
    const indexNames = (Array.isArray(indexes) ? indexes : []).map((r: any) => r.name);
    expect(indexNames).toContain("idx_turns_session");
    expect(indexNames).toContain("idx_turn_events_turn");

    const journalMode: any = await db.raw("PRAGMA journal_mode");
    const jm = Array.isArray(journalMode) ? journalMode[0] : journalMode;
    expect(Object.values(jm || {})).toContain("wal");
  });

  it("adopts a pre-existing sessions.db with the old raw schema without error or data loss", async () => {
    const dbPath = join(dir, "adopt.db");

    // Create a pre-existing DB using the OLD raw schema (plain CREATE TABLE).
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        agent_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER
      );
      CREATE TABLE turn_events (
        turn_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        version INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id, seq);
    `);
    raw.exec(
      `INSERT INTO sessions (id, title, agent_id, status, created_at, updated_at)
       VALUES ('test-id', 'pre-existing', '', 'open', 1000, 1000)`,
    );
    raw.exec(
      `INSERT INTO turns (session_id, model, status, request_json, created_at)
       VALUES ('test-id', 'gpt-4', 'done', '{}', 1000)`,
    );
    raw.close();

    // Open via the knex-backed store — must adopt without error or clobbering
    // (migrations run inside openSessionsDb now).
    const db = await openSessionsDb(dbPath);

    const session: any = await db.raw("SELECT * FROM sessions WHERE id = ?", ["test-id"]);
    const sessionRows = Array.isArray(session) ? session : [session];
    expect(sessionRows[0].id).toBe("test-id");
    expect(sessionRows[0].title).toBe("pre-existing");

    const turns: any = await db.raw("SELECT * FROM turns WHERE session_id = ?", ["test-id"]);
    const turnRows = Array.isArray(turns) ? turns : [turns];
    expect(turnRows).toHaveLength(1);

    // The legacy `closed_at` column was re-keyed to `detached_at` by the
    // real migration chain (003) — the adopted volume speaks the current
    // schema, no data lost.
    const cols: any = await db.raw("PRAGMA table_info(sessions)");
    expect((Array.isArray(cols) ? cols : []).map((c: any) => c.name)).toContain("detached_at");
    expect((Array.isArray(cols) ? cols : []).map((c: any) => c.name)).not.toContain("closed_at");
    expect(sessionRows[0].detached_at).toBeNull();
  });

  it("configures openSessionsDb with better-sqlite3 client, useNullAsDefault, and pool min/max 1", async () => {
    const dbPath = join(dir, "config.db");
    const db = await openSessionsDb(dbPath);

    const config = db.client.config;
    expect(config.client).toBe("better-sqlite3");
    expect(config.useNullAsDefault).toBe(true);
    expect(config.pool.min).toBe(1);
    expect(config.pool.max).toBe(1);
  });

  it("logs slow queries with SQL and duration when YOG_DB_SLOW_MS is set low", async () => {
    process.env.YOG_DB_SLOW_MS = "0";
    const dbPath = join(dir, "slow.db");
    const db = await openSessionsDb(dbPath);

    const logs: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: any) => {
      logs.push(String(chunk));
      return true;
    };

    try {
      await db.raw("SELECT 1 AS ok");
    } finally {
      process.stdout.write = orig;
    }

    const slowLog = logs.find((l) => l.includes("slow query"));
    expect(slowLog).toBeTruthy();
    expect(slowLog).toContain("SELECT");
  });
});

describe("depcruiser rule presence", () => {
  it(".dependency-cruiser.cjs contains a rule named 'db-drivers-only-in-store'", () => {
    const config = readFileSync(".dependency-cruiser.cjs", "utf-8");
    expect(config).toContain("db-drivers-only-in-store");
  });
});
