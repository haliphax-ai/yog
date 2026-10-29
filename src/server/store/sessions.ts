import knex from "knex";
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
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
  private db: knex.Knex;

  /**
   * Compose a store over an already-open knex handle (as built by
   * {@link openSessionsDb}, which runs the startup migration chain).
   * Prefer {@link SessionStore.open} — it is the only supported way to
   * turn a filename into a usable store (§4.1: knex migrations own schema
   * truth; there is no second DDL path).
   */
  constructor(db: knex.Knex) {
    this.db = db;
  }

  /**
   * Open the sessions database at `filename` and return a usable store.
   *
   * The single open path (§4.1): knex handle → startup migrations
   * (`migrate.latest()`, adopting fresh and pre-existing volumes alike) →
   * startup recovery (prune past-retention dormant sessions, interrupt
   * turns left running by a crash). Everything schema-related happens
   * before the store becomes usable; the store itself carries no DDL.
   */
  static async open(filename: string): Promise<SessionStore> {
    const db = await openSessionsDb(filename);
    const store = new SessionStore(db);
    // Startup recovery: drop stale data, then unblock any turn left running.
    await store.pruneOldSessions();
    await store.interruptRunningTurns();
    return store;
  }

  async createSession(opts: { title?: string; system?: string } = {}): Promise<any> {
    const now = Date.now();
    const id = randomUUID();
    await this.db("sessions").insert({
      id,
      title: opts.title ?? null,
      agent_id: "",
      status: "open",
      created_at: now,
      updated_at: now,
      detached_at: null,
    });
    // `system` seeds the first transcript message (role `system`) so it is
    // part of every turn's hydrate (§4.6). Written here so the seed is
    // present before any turn runs and is itself a persisted transcript row.
    if (opts.system !== undefined && opts.system !== null) {
      await this.appendMessages(id, [{ role: "system", content: String(opts.system) }], null);
    }
    return this.getSession(id);
  }

  async getSession(id: string): Promise<any> {
    const row = await this.db("sessions").where("id", id).first();
    return row ?? null;
  }

  async listSessions(): Promise<any[]> {
    return this.db("sessions").orderBy("created_at", "id");
  }

  /**
   * Detach a session (§4.5): advisory "done for now". Status `open` →
   * `dormant`, `detached_at` stamped. Nothing is forfeited — transcript,
   * turns, events, and agentfs shell state all stay. Idempotent: a second
   * call on an already-dormant session is a no-op (the row is already
   * detached), so the route returns 200 either way. Also idempotent when
   * called on an already-open session that was never detached? No — an open
   * session is exactly the one that gets detached here; the guard simply
   * makes a *second* detach after a revive a fresh stamp (a new clock start,
   * not a stale one).
   */
  async detachSession(id: string, detachedAt?: string | number): Promise<void> {
    const ts = toMs(detachedAt) ?? Date.now();
    await this.db("sessions")
      .where("id", id)
      .where("status", "open")
      .update({ status: "dormant", detached_at: ts, updated_at: ts });
  }

  /**
   * Revive a dormant session (§4.5): status `dormant` → `open`,
   * `detached_at` cleared. Retention clock resets (a pruned session is the
   * only truly terminal state). Idempotent on an already-open session.
   */
  async reviveSession(id: string): Promise<void> {
    await this.db("sessions")
      .where("id", id)
      .where("status", "dormant")
      .update({ status: "open", detached_at: null, updated_at: Date.now() });
  }

  /**
   * Immediate irreversible delete (§4.5 `?purge=true`). Removes the session
   * row and cascades to turns, turn_events, and session_messages. The
   * `session_messages` FK has ON DELETE CASCADE; the other tables do not, so
   * they are deleted explicitly. Returns the number of session rows deleted
   * (0 if the id did not exist).
   */
  async purgeSession(id: string): Promise<number> {
    return this.db.transaction(async (trx: any) => {
      await trx("turn_events")
        .whereIn("turn_id", trx("turns").select("id").where("session_id", id))
        .del();
      await trx("turns").where("session_id", id).del();
      await trx("session_messages").where("session_id", id).del();
      // The row count of the sessions delete is the return contract: the
      // number of sessions actually removed (0 if the id did not exist).
      const deleted = await trx("sessions").where("id", id).del();
      return deleted;
    });
  }

  async addTurn(
    sessionId: string,
    turn: { role: string; content: string; status: string; model?: string } & {
      revive?: boolean;
    },
  ): Promise<any> {
    const now = Date.now();
    const requestJson = JSON.stringify({ prompt: turn.content, model: turn.model ?? "unknown" });
    const finished = turn.status === "running" ? null : now;
    const inserted = await this.db("turns").insert({
      session_id: sessionId,
      model: turn.model ?? "unknown",
      status: turn.status,
      request_json: requestJson,
      created_at: now,
      finished_at: finished,
      duration_ms: finished === null ? null : finished - now,
    });
    // Implicit revive (§4.5): a turn on a dormant session flips it back to
    // `open` and clears `detached_at` (retention clock reset). Store-owned,
    // best-effort (a missing/detached row must not fail the turn), and
    // idempotent — on an already-open session the guarded UPDATE matches
    // zero rows.
    if (turn.revive) {
      try {
        await this.reviveSession(sessionId);
      } catch {
        // revival is best effort; the turn itself still runs
      }
    }
    return this.getTurn(Number(inserted[0]));
  }

  async getTurn(id: number): Promise<any> {
    const row = await this.db("turns").where("id", id).first();
    return row ? hydrateTurn(row) : null;
  }

  async listTurns(sessionId: string): Promise<any[]> {
    const rows = await this.db("turns").where("session_id", sessionId).orderBy("id");
    return rows.map(hydrateTurn);
  }

  async addEvent(
    sessionId: string,
    event: { type: string; payload: string; version?: number },
  ): Promise<any> {
    const turn = await this.db("turns")
      .where("session_id", sessionId)
      .orderBy("id", "desc")
      .first("id");
    if (!turn) {
      throw new Error(`cannot add event: session ${sessionId} has no turns`);
    }
    const seqRow = await this.db("turn_events")
      .where("turn_id", turn.id)
      .max({ next: "seq" })
      .first();
    const next = Number(seqRow?.next ?? 0) + 1;
    const ts = Date.now();
    await this.db("turn_events").insert({
      turn_id: turn.id,
      seq: next,
      type: event.type,
      version: event.version ?? 1,
      ts,
      data_json: JSON.stringify(event.payload),
    });
    return { turn_id: turn.id, seq: next, type: event.type, version: event.version ?? 1, ts };
  }

  async listEvents(sessionId: string): Promise<any[]> {
    const rows = await this.db("turn_events as e")
      .join("turns as t", "t.id", "e.turn_id")
      .where("t.session_id", sessionId)
      .orderBy("e.turn_id", "e.seq")
      .select("e.turn_id", "e.seq", "e.type", "e.version", "e.ts", "e.data_json");
    return rows.map((row: any) => ({
      turn_id: row.turn_id,
      seq: row.seq,
      type: row.type,
      version: row.version,
      ts: row.ts,
      payload: JSON.parse(row.data_json),
    }));
  }

  /**
   * Append a batch of messages to a session's canonical transcript (§4.2).
   *
   * `seq` is assigned per message from `MAX(seq)+1` for the session and
   * **never resets** — it continues across dormancy and revival, so a
   * transcript rehydrated after a detach resumes at the next free seq.
   * All inserts run in a single transaction: either every row lands or
   * none does, and the caller-visible rows carry the assigned seqs.
   *
   * NOTE (§4.8): unlike `addEvent`, which infers the turn as "the latest
   * turn of the session", transcript rows are addressed by explicit ids
   * and seqs — do not copy the infer-latest-turn pattern here. A turn that
   * rehydrates a dormant session still appends with the session's next seq
   * (continue `MAX(seq)+1` across dormancy — never reset per lifecycle).
   */
  async appendMessages(
    sessionId: string,
    msgs: ChatCompletionMessageParam[],
    turnId: number | null = null,
  ): Promise<any[]> {
    const now = Date.now();
    return this.db.transaction(async (trx: any) => {
      const maxRow = await trx("session_messages")
        .where("session_id", sessionId)
        .max({ maxSeq: "seq" })
        .first();
      let seq = Number(maxRow?.maxSeq ?? 0) + 1;
      const out: any[] = [];
      for (const m of msgs) {
        const role = (m as any).role;
        const content = (m as any).content ?? null;
        const tool_call_id = (m as any).tool_call_id ?? null;
        const name = (m as any).name ?? null;
        let tool_calls_json: string | null = null;
        const tool_calls = (m as any).tool_calls;
        if (Array.isArray(tool_calls) && tool_calls.length > 0) {
          tool_calls_json = JSON.stringify(tool_calls);
        }
        const inserted = await trx("session_messages").insert({
          session_id: sessionId,
          turn_id: turnId ?? null,
          seq,
          role,
          content,
          tool_call_id,
          name,
          tool_calls_json,
          created_at: now,
        });
        out.push({
          id: Number(inserted[0]),
          session_id: sessionId,
          turn_id: turnId ?? null,
          seq,
          role,
          content,
          tool_call_id,
          name,
          tool_calls_json,
          created_at: now,
        });
        seq += 1;
      }
      return out;
    });
  }

  /**
   * Read a session's canonical transcript (§4.2).
   *
   * Returns ordered rows mapped to `ChatCompletionMessageParam`-shaped
   * objects, plus metadata (`seq`, `turnId`, `ts`) so callers can address
   * rows explicitly. `afterSeq` pages forward from a known seq; `limit`
   * caps the batch. Pass neither for the full transcript from the start.
   */
  async getTranscript(
    sessionId: string,
    opts: { afterSeq?: number; limit?: number } = {},
  ): Promise<any[]> {
    const afterSeq = opts.afterSeq ?? 0;
    const limit = opts.limit;
    const query = this.db("session_messages")
      .where("session_id", sessionId)
      .where("seq", ">", afterSeq)
      .orderBy("seq", "asc");
    const rows: any[] = limit !== undefined ? await query.limit(limit) : await query;
    return rows.map((row: any) => {
      const msg: any = { role: row.role };
      if (row.content !== null) msg.content = row.content;
      if (row.tool_call_id !== null) msg.tool_call_id = row.tool_call_id;
      if (row.name !== null) msg.name = row.name;
      if (row.tool_calls_json !== null) msg.tool_calls = JSON.parse(row.tool_calls_json);
      return {
        ...msg,
        seq: row.seq,
        turnId: row.turn_id,
        ts: row.created_at,
      };
    });
  }

  /**
   * Prune dormant sessions past the retention window (§4.5).
   *
   * The 30-day clock is keyed on `detached_at` (the last detach), not
   * `created_at`: a session that was detached and then revived clears
   * `detached_at`, resetting the clock. A pruned session is the only
   * truly terminal state (`unknown_session` 404 thereafter). Cascade
   * includes `session_messages` (§4.2).
   */
  async pruneOldSessions(): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
    const doomed = await this.db("sessions")
      .where("status", "dormant")
      .whereNotNull("detached_at")
      .where("detached_at", "<", cutoff)
      .select("id");
    if (doomed.length === 0) return;

    await this.db.transaction(async (trx: any) => {
      for (const { id } of doomed) {
        // Events hang off turns, so the turns must be enumerated to reach
        // them (turn_events has no session_id of its own).
        const turns = await trx("turns").where("session_id", id).select("id");
        for (const turn of turns) {
          await trx("turn_events").where("turn_id", turn.id).del();
        }
        await trx("turns").where("session_id", id).del();
        // Cascade to the canonical transcript (§4.2): a pruned session
        // forfeits its messages along with its turns and events.
        await trx("session_messages").where("session_id", id).del();
        await trx("sessions").where("id", id).del();
      }
    });
  }

  /** Crash recovery: any turn left 'running' becomes 'interrupted'. */
  async interruptRunningTurns(): Promise<void> {
    await this.db("turns").where("status", "running").update({ status: "interrupted" });
  }

  close(): void {
    void this.db.destroy();
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
    prompt: parsed.prompt ?? null,
    request: parsed,
  };
}

/**
 * Open the sessions database via knex (better-sqlite3 driver).
 *
 * Constructs the knex instance with the configured driver, pool, and
 * migrations directory, then wires the slow-query tripwire (§4.1) and runs
 * the startup migration chain (§4.1: `knex.migrate.latest()` at daemon
 * startup — schema truth lives in `src/server/store/migrations/` 001–003,
 * which adopt fresh and pre-existing volumes alike). Resolves with the
 * migrated handle, ready for {@link SessionStore}.
 *
 * Pragma parity (WAL, busy_timeout 5000, synchronous NORMAL) is applied
 * per pooled connection via `afterCreate` — outside any transaction the
 * migration runner would wrap statements in.
 */
export async function openSessionsDb(filename: string): Promise<knex.Knex> {
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

  await db.migrate.latest();

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
