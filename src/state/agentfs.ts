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
import { homedir } from "node:os";
import { join } from "node:path";
import { AgentFS } from "agentfs-sdk";
import { copyFile, mkdir } from "../host.ts";

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
   * Open (creating if needed) an agent filesystem at `path` (defaults to
   * `YOG_STATE_DB` or `.agentfs/yog.db`).
   */
  static async open(opts: { path?: string } = {}): Promise<AgentFSState> {
    // Default to the harness user's home (not cwd) so the state db survives
    // regardless of which working directory the daemon starts in.
    const dbPath =
      opts.path ?? process.env["YOG_STATE_DB"] ?? join(homedir(), ".agentfs", "yog.db");
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
