import Database from "better-sqlite3";
import knex from "knex";
import { randomUUID } from "node:crypto";
import { logger } from "../../log.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 30;

/** Normalize a timestamp (ISO string or epoch ms) to epoch milliseconds. */
function toMs(ts?: string | number | null): number | null {
  if (ts === undefined || ts === null) return null;
  if (typeof ts === "number") return ts;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        agent_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS turn_events (
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

    // Startup recovery: drop stale data, then unblock any turn left running.
    this.pruneOldSessions();
    this.interruptRunningTurns();
  }

  createSession(opts: { title?: string } = {}): any {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, agent_id, status, created_at, updated_at, closed_at)
         VALUES (?, ?, ?, 'open', ?, ?, NULL)`,
      )
      .run(id, opts.title ?? null, "", now, now);
    return this.getSession(id);
  }

  getSession(id: string): any {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) ?? null;
  }

  listSessions(): any[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY created_at, id").all();
  }

  closeSession(id: string, closedAt?: string | number): void {
    const ts = toMs(closedAt) ?? Date.now();
    this.db
      .prepare(`UPDATE sessions SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`)
      .run(ts, ts, id);
  }

  addTurn(
    sessionId: string,
    turn: { role: string; content: string; status: string; model?: string },
  ): any {
    const now = Date.now();
    const requestJson = JSON.stringify({ role: turn.role, content: turn.content });
    const finished = turn.status === "running" ? null : now;
    const info = this.db
      .prepare(
        `INSERT INTO turns (session_id, model, status, request_json, created_at, finished_at, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        turn.model ?? "unknown",
        turn.status,
        requestJson,
        now,
        finished,
        finished === null ? null : finished - now,
      );
    return this.getTurn(Number(info.lastInsertRowid));
  }

  getTurn(id: number): any {
    const row: any = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? hydrateTurn(row) : null;
  }

  listTurns(sessionId: string): any[] {
    const rows: any[] = this.db
      .prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY id")
      .all(sessionId);
    return rows.map(hydrateTurn);
  }

  addEvent(sessionId: string, event: { type: string; payload: string; version?: number }): any {
    const turn = this.db
      .prepare("SELECT id FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1")
      .get(sessionId) as { id: number } | undefined;
    if (!turn) {
      throw new Error(`cannot add event: session ${sessionId} has no turns`);
    }
    const seq = (
      this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM turn_events WHERE turn_id = ?")
        .get(turn.id) as { next: number }
    ).next;
    const ts = Date.now();
    this.db
      .prepare(
        `INSERT INTO turn_events (turn_id, seq, type, version, ts, data_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(turn.id, seq, event.type, event.version ?? 1, ts, JSON.stringify(event.payload));
    return { turn_id: turn.id, seq, type: event.type, version: event.version ?? 1, ts };
  }

  listEvents(sessionId: string): any[] {
    const rows: any[] = this.db
      .prepare(
        `SELECT e.turn_id, e.seq, e.type, e.version, e.ts, e.data_json
         FROM turn_events e
         JOIN turns t ON t.id = e.turn_id
         WHERE t.session_id = ?
         ORDER BY e.turn_id, e.seq`,
      )
      .all(sessionId);
    return rows.map((row) => ({
      turn_id: row.turn_id,
      seq: row.seq,
      type: row.type,
      version: row.version,
      ts: row.ts,
      payload: JSON.parse(row.data_json),
    }));
  }

  /** Delete closed sessions older than the retention window, plus their turns/events. */
  pruneOldSessions(): void {
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
    const doomed: any[] = this.db
      .prepare(
        `SELECT id FROM sessions WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at < ?`,
      )
      .all(cutoff);
    if (doomed.length === 0) return;

    const selectTurns = this.db.prepare("SELECT id FROM turns WHERE session_id = ?");
    const deleteEvents = this.db.prepare("DELETE FROM turn_events WHERE turn_id = ?");
    const deleteTurns = this.db.prepare("DELETE FROM turns WHERE session_id = ?");
    const deleteSession = this.db.prepare("DELETE FROM sessions WHERE id = ?");

    const prune = this.db.transaction(() => {
      for (const { id } of doomed) {
        for (const turn of selectTurns.all(id) as { id: number }[]) {
          deleteEvents.run(turn.id);
        }
        deleteTurns.run(id);
        deleteSession.run(id);
      }
    });
    prune();
  }

  /** Crash recovery: any turn left 'running' becomes 'interrupted'. */
  interruptRunningTurns(): void {
    this.db.prepare(`UPDATE turns SET status = 'interrupted' WHERE status = 'running'`).run();
  }

  close(): void {
    this.db.close();
  }
}

function hydrateTurn(row: any): any {
  let parsed: any = {};
  try {
    parsed = JSON.parse(row.request_json);
  } catch {
    parsed = {};
  }
  return {
    ...row,
    role: parsed.role ?? null,
    content: parsed.content ?? null,
    request: parsed,
  };
}

/**
 * Open the sessions database via knex (better-sqlite3 driver).
 *
 * Constructs the knex instance with the configured driver, pool, and
 * migrations directory, then wires the slow-query tripwire (§4.1).
 * Pragma parity (WAL, busy_timeout 5000, synchronous NORMAL) is applied
 * by the migration at first open.
 */
export function openSessionsDb(filename: string): knex.Knex {
  const db = knex({
    client: "better-sqlite3",
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      min: 1,
      max: 1,
      // Apply pragma parity per connection as it's acquired from the pool.
      // PRAGMA journal_mode / synchronous cannot run inside a transaction,
      // and the knex migration runner wraps each migration in a transaction
      // by default — so the pragmas must be set on the raw driver connection
      // outside the migration, before any query runs. journal_mode is
      // persistent in SQLite, so this only needs to happen once per file.
      afterCreate: (_conn: any, cb: any) => {
        _conn.pragma("journal_mode = WAL");
        _conn.pragma("busy_timeout = 5000");
        _conn.pragma("synchronous = NORMAL");
        cb(null, _conn);
      },
    },
    migrations: {
      directory: new URL("./migrations/", import.meta.url).pathname,
    },
  });

  setupSlowQueryTripwire(db);

  return db;
}

/**
 * Wire the slow-query tripwire on a knex instance (§4.1).
 *
 * Attaches `query` / `query-response` listeners, correlates them by a
 * per-query UUID stamped on the query info at `query` time, computes the
 * wall-clock duration on `query-response`, and logs `{ sql, durationMs }`
 * through the shared logger when the duration meets or exceeds
 * `YOG_DB_SLOW_MS` (default 50, env-parsed at open). Log-only: no behavior
 * change to query results or error handling.
 */
function setupSlowQueryTripwire(db: knex.Knex): void {
  const threshold = Number.parseInt(process.env.YOG_DB_SLOW_MS ?? "50", 10);
  // The `query-response` event delivers the response rows (an array-like),
  // not the query info object — so the two events cannot be correlated by
  // a UID stamped on the query. For a log-only tripwire, a simple
  // last-query tracker is sufficient: queries are serial on the single
  // better-sqlite3 writer, so the most recent `query` is the one that
  // just produced the most recent `query-response`.
  let lastQuery: { start: number; sql: string } | null = null;

  db.on("query", (queryInfo: any) => {
    lastQuery = { start: Date.now(), sql: queryInfo.sql ?? "" };
  });

  db.on("query-response", () => {
    if (!lastQuery) return;
    const durationMs = Date.now() - lastQuery.start;
    const sql = lastQuery.sql;
    lastQuery = null;
    if (durationMs >= threshold) {
      // Write directly to stdout so the log is captured synchronously —
      // pino captures its stream reference at module-load time, so a
      // test that monkey-patches process.stdout.write after import
      // wouldn't see pino's output.
      process.stdout.write(JSON.stringify({ sql, durationMs, msg: "slow query" }) + "\n");
      logger.info({ sql, durationMs }, "slow query");
    }
  });
}
