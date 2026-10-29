/** Migration 003: rename `sessions.closed_at` → `sessions.detached_at` (§4.5).
 *
 * The lifecycle vocabulary changes from "closed" (terminal) to "detached"
 * (advisory, revivable): the status value rename (`closed` → `dormant`)
 * already happened in migration 002, so the column follows. The timestamp
 * keeps its meaning — when the session became non-open — but the retention
 * clock is now keyed on it (§4.5): dormant sessions whose `detached_at` is
 * older than the 30-day cutoff are pruned at startup.
 *
 * Uses the knex schema builder (plan §4.1: "later schema changes are plain
 * builder migrations"). SQLite cannot DROP a column in one statement, so
 * `renameColumn` is a table rebuild under the hood — knex emits the
 * create-new/copy/drop-old sequence.
 *
 * Legacy re-key (§4.5): rows that carry a `closed_at` stamp were detached
 * under the old vocabulary — migration 002 already renamed their status to
 * `dormant`, so their stamp IS the detach time. `renameColumn` moves the
 * column's VALUES with it (no re-stamp, no reset of the retention clock):
 * an old raw volume keeps its detach age instead of silently losing it, and
 * a fresh migration-001 volume (no stamps) is untouched.
 */

export async function up(knex: any): Promise<void> {
  await knex.schema.alterTable("sessions", (t: any) => {
    t.renameColumn("closed_at", "detached_at");
  });
}

export async function down(knex: any): Promise<void> {
  await knex.schema.alterTable("sessions", (t: any) => {
    t.renameColumn("detached_at", "closed_at");
  });
}
