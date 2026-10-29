/** Migration 001: adopt the existing sessions/turns/turn_events schema.
 *
 * Uses CREATE TABLE IF NOT EXISTS so the migration is idempotent on both
 * fresh and pre-existing sessions.db volumes (PLAN §4.1).
 */
export async function up(knex: any): Promise<void> {
  // The better-sqlite3 dialect rejects multi-statement raw strings, so
  // each DDL statement is issued separately (PLAN §4.1: raw SQL in the
  // migration is fine — the constraint is the driver's, not the schema's).
  await knex.raw(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      agent_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER
    )`);
  await knex.raw(`CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      duration_ms INTEGER
    )`);
  await knex.raw(`CREATE TABLE IF NOT EXISTS turn_events (
      turn_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      version INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      data_json TEXT NOT NULL
    )`);
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id)");
  await knex.raw("CREATE INDEX IF NOT EXISTS idx_turn_events_turn ON turn_events(turn_id, seq)");
}

export async function down(knex: any): Promise<void> {
  await knex.raw(`
    DROP TABLE IF EXISTS turn_events;
    DROP TABLE IF EXISTS turns;
    DROP TABLE IF EXISTS sessions;
  `);
}
