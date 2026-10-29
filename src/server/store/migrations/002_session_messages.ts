/** Migration 002: `session_messages` canonical transcript table.
 *
 * Adds the `session_messages` table — the distilled model context (§4.2) —
 * alongside the existing disposable `turn_events` stream, and renames the
 * terminal session status `closed` → `dormant` (§4.5 / plan decision 6):
 * there is no terminal state short of retention pruning, so `closed` becomes
 * the advisory "done for now" `dormant`, which a later turn revives.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS) so re-running on a volume that
 * already has the table is a no-op. The better-sqlite3 driver rejects
 * multi-statement raw strings, so each statement is issued separately.
 */

export async function up(knex: any): Promise<void> {
  await knex.raw(`CREATE TABLE IF NOT EXISTS session_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      turn_id INTEGER,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      name TEXT,
      tool_calls_json TEXT,
      created_at INTEGER NOT NULL
    )`);
  // seq is monotonic within a session and unique per (session_id, seq).
  await knex.raw(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_session_seq ON session_messages(session_id, seq)",
  );
  await knex.raw(
    "CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id)",
  );
  // Rename the terminal status value: sessions previously marked `closed`
  // are now `dormant`. Rows already `dormant` (fresh from this migration)
  // are untouched by the WHERE clause.
  await knex.raw("UPDATE sessions SET status = 'dormant' WHERE status = 'closed'");
  // NOTE: the `closed_at` → `detached_at` column rename (§4.5) is migration
  // 003 (builder-based); this migration leaves the sessions table shape
  // untouched. Migration 003 must re-key any legacy `closed` rows stamped by
  // pre-003 detach paths onto `detached_at`, since this UPDATE makes them
  // `dormant` while their detach timestamp still sits in `closed_at`.
}

export async function down(knex: any): Promise<void> {
  await knex.raw("DROP TABLE IF EXISTS session_messages");
}
