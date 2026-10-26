import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

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
