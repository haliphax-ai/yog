/** Migration 005: drop the vestigial per-call `tokens` column from
 * `session_messages`.
 *
 * Migration 004 introduced a nullable `tokens` column for per-tool-call
 * token attribution, but no code ever wrote a real value to it: the
 * equal-split estimate was removed from the live path in e8fd5eb (#25)
 * and the store stopped writing/reading the field entirely (the
 * transcript contract now carries only round usage). This retires the
 * dead column. 004 stays as-is — migrations are immutable history; this
 * is the forward-only undo. Nullable-column drop, so pre-existing
 * volumes adopt cleanly.
 */
export async function up(knex: any): Promise<void> {
  await knex.schema.alterTable("session_messages", (t: any) => {
    t.dropColumn("tokens");
  });
}

export async function down(knex: any): Promise<void> {
  await knex.schema.alterTable("session_messages", (t: any) => {
    t.integer("tokens").nullable();
  });
}
