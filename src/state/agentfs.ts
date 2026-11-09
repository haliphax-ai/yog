/**
 * The state layer — the only module allowed to touch the agentfs SDK.
 *
 * It wraps `AgentFS.open` and provides the insert-only `tool_calls` audit
 * recorder, stamped with the base62 session id (a spec-sanctioned extension).
 * The AgentFS database file is the agent's home/state: snapshotting is a
 * plain `cp agent.db snapshot.db`, restoring is opening the copy.
 *
 * Recording is best-effort: callers (the turn loop) treat a failure here as
 * non-fatal and keep the turn going.
 */
import { AgentFS } from "agentfs-sdk";
import { copyFile, mkdir } from "../host.ts";
import { stateDbPath, type AgentId } from "./agents.ts";

export interface ToolCallRecord {
  /** OpenAI tool name (e.g. "bash"). */
  readonly name: string;
  /** Raw JSON arguments string the model produced. */
  readonly parameters?: unknown;
  /** Result envelope (omit when the call errored). */
  readonly result?: unknown;
  /** Error message (omit when the call succeeded). */
  readonly error?: string;
  /** Epoch ms when execution started. */
  readonly startedAt: number;
  /** Epoch ms when execution completed. */
  readonly completedAt: number;
  /** Execution duration in ms. */
  readonly durationMs: number;
  /** The session id this call belongs to. */
  readonly sessionId: string;
}

/** Minimal view of the agentfs database handle we need. */
interface DBLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(
      ...args: unknown[]
    ): Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
    all(...args: unknown[]): unknown[] | Promise<unknown[]>;
    run(...args: unknown[]): unknown;
  };
}

/** The persisted persistent-shell state shape (mirrors the worker snapshot). */
export interface ShellHomeState {
  readonly cwd?: string;
  readonly env?: string;
  readonly functions?: string;
}

export class AgentFSState {
  /** Path of the SQLite database file backing this agent state. */
  readonly path: string;
  readonly #agent: AgentFS;

  private constructor(agent: AgentFS, path: string) {
    this.#agent = agent;
    this.path = path;
  }

  /**
   * Open (creating if needed) an agent filesystem for an agent.
   *
   * The database path is derived from the agent id (`stateDbPath`) with the
   * storage root injected by the caller (config `stateRoot`), never from an
   * env var. A full `path` may still be supplied to override entirely.
   */
  static async open(
    opts: { agentId?: AgentId; path?: string; root?: string } = {},
  ): Promise<AgentFSState> {
    // A full path wins (tests, explicit overrides); otherwise derive from
    // the agent id under the injected root.
    const dbPath = opts.path ?? (opts.agentId ? stateDbPath(opts.agentId, opts.root) : undefined);
    if (dbPath === undefined) {
      throw new Error("AgentFSState.open requires an agentId or an explicit path");
    }
    const slash = dbPath.lastIndexOf("/");
    try {
      if (slash > 0) {
        await mkdir(dbPath.slice(0, slash), { recursive: true });
      }
      const agent = await AgentFS.open({ path: dbPath });
      const state = new AgentFSState(agent, dbPath);
      await state.#ensureSessionColumn();
      return state;
    } catch (err) {
      // Surface the resolved path so the caller can act on it (e.g. override
      // YOG_STATE_DB) instead of guessing what failed.
      throw new Error(`opening agent state at ${dbPath}: ${(err as Error).message}`);
    }
  }

  /** Raw database (for queries/snapshots). */
  getDatabase(): DBLike {
    return this.#agent.getDatabase() as unknown as DBLike;
  }

  /**
   * Write a point-in-time snapshot of the agent state to `targetPath`.
   * In WAL mode the main database file alone can lag the live state; fold any
   * WAL contents in first so the copied file is a complete snapshot (the
   * AgentFS `cp agent.db snapshot.db` idiom).
   */
  async snapshotTo(targetPath: string): Promise<void> {
    try {
      await this.getDatabase().exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // journal_mode != WAL — nothing to checkpoint.
    }
    await copyFile(this.path, targetPath);
  }

  /**
   * Record one completed tool call in the insert-only `tool_calls` audit log,
   * including the session id. `result` and `error` are mutually exclusive.
   */
  async recordToolCall(rec: ToolCallRecord): Promise<void> {
    const db = this.getDatabase();
    const resultJson = rec.result !== undefined ? JSON.stringify(rec.result) : null;
    const error = rec.error ?? null;
    await db
      .prepare(
        `INSERT INTO tool_calls
         (name, parameters, result, error, started_at, completed_at, duration_ms, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.name,
        rec.parameters !== undefined ? JSON.stringify(rec.parameters) : null,
        resultJson,
        error,
        Math.floor(rec.startedAt / 1000),
        Math.floor(rec.completedAt / 1000),
        rec.durationMs,
        rec.sessionId,
      );
  }

  /** Persist the persistent-shell snapshot for a session (rewindable home). */
  async saveShellSnapshot(sessionId: string, state: ShellHomeState): Promise<void> {
    await this.#agent.kv.set(`session:${sessionId}:shell`, state);
  }

  /** Load the persisted persistent-shell snapshot for a session. */
  async loadShellSnapshot(sessionId: string): Promise<ShellHomeState | undefined> {
    return this.#agent.kv.get(`session:${sessionId}:shell`);
  }

  /**
   * Delete shell snapshots last written more than `retentionDays` days
   * ago (the kv rows behind {@link loadShellSnapshot}). The filesystem
   * sweep (`pruneStaleHarnessState`) and this sweep are two halves of
   * the same retention: without deleting the kv record, the next bash
   * call for that session would resurrect the pruned shell state from
   * the snapshot mirror. `kv_store.updated_at` is `unixepoch()` seconds,
   * refreshed on every `set`. Only `session:<id>:shell` keys are
   * touched; other kv entries are not harness records. Runs at daemon
   * start-up only, alongside the filesystem sweep.
   */
  async pruneStaleShellSnapshots(
    opts: { now?: number; retentionDays?: number } = {},
  ): Promise<void> {
    const retentionDays = opts.retentionDays ?? 7;
    const cutoffSec = Math.floor((opts.now ?? Date.now()) / 1000) - retentionDays * 24 * 60 * 60;
    await this.getDatabase()
      .prepare(`DELETE FROM kv_store WHERE key LIKE 'session:%:shell' AND updated_at < ?`)
      .run(cutoffSec);
  }

  /** Close the underlying database connection. */
  async close(): Promise<void> {
    await this.#agent.close();
  }

  /** Ensure the `session_id` extension column exists on `tool_calls`. */
  async #ensureSessionColumn(): Promise<void> {
    const db = this.getDatabase();
    const rows = (await db.prepare("PRAGMA table_info(tool_calls)").all()) as Array<{
      name?: unknown;
    }>;
    const hasSessionId = rows.some((row) => row.name === "session_id");
    if (!hasSessionId) {
      await db.exec("ALTER TABLE tool_calls ADD COLUMN session_id TEXT");
    }
  }
}
