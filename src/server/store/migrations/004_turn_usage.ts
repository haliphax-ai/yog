/** Migration 004: persist per-turn token usage and per-tool-call tokens.
 *
 * Adds nullable usage columns to `turns` — written by `finishTurn` when a
 * turn completes with provider usage — and a nullable `tokens` column to
 * `session_messages` for per-tool-call token attribution on tool result
 * rows. All new columns are optional/nullable: providers that don't report
 * usage leave them NULL, and pre-existing volumes adopt cleanly (§R1.1/
 * R1.2). Like 002/003, additive and idempotent-friendly.
 */
export async function up(knex: any): Promise<void> {
  await knex.schema.alterTable("turns", (t: any) => {
    t.integer("prompt_tokens").nullable();
    t.integer("completion_tokens").nullable();
    t.integer("total_tokens").nullable();
  });
  await knex.schema.alterTable("session_messages", (t: any) => {
    t.integer("tokens").nullable();
  });
}

export async function down(knex: any): Promise<void> {
  await knex.schema.alterTable("session_messages", (t: any) => {
    t.dropColumn("tokens");
  });
  await knex.schema.alterTable("turns", (t: any) => {
    t.dropColumn("prompt_tokens");
    t.dropColumn("completion_tokens");
    t.dropColumn("total_tokens");
  });
}
