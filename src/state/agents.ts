/**
 * Agent identity and state-path derivation.
 *
 * keyed by an explicit agent id (a value threaded through the runtime) —
 * never by a configuration file. The configuration contributes only the
 * system-wide storage root (injected; default `/var/lib/yog`).
 *
 * The same rule governs the persistent-shell (`.harness`) state: it lives
 * under the state root at `harness/<sessionId>` — keyed by the session,
 * never in the agent's home (whose lifetime is not tied to a session) and
 * never at a single shared path (sessions must not share a shell).
 */
import { readdir, rm, stat } from "../host.ts";

/** Retention for per-session harness (shell) state, in days. */
export const HARNESS_STATE_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Opaque agent identifier. */
export type AgentId = string;

/** The single agent this bootstrap harness runs (multi-agent orchestration will pass others). */
export const DEFAULT_AGENT_ID: AgentId = "agent";

/** Storage root for all agent state (injected by the composition root). */
export function stateRoot(root: string = "/var/lib/yog"): string {
  return root;
}

/** Derive the state database path for an agent under `root`. */
export function stateDbPath(agentId: AgentId, root: string = "/var/lib/yog"): string {
  return `${root}/agentfs/${agentId}.db`;
}

/** Root directory for all per-session harness (shell) state under `root`. */
export function harnessStateRoot(root: string = "/var/lib/yog"): string {
  return `${root}/harness`;
}

/**
 * Derive the harness (persistent-shell) state directory for a session:
 * `<root>/harness/<sessionId>`.
 *
 * The session id becomes a single path segment, so it must be a plain
 * file-name token: the store's UUIDs, base62 ids, and the `daemon`
 * fallback all qualify, while separators or dot-segments (which would
 * escape the harness root) are rejected loudly instead of being
 * sanitized into a different session's directory.
 */
export function harnessStateDir(sessionId: string, root: string = "/var/lib/yog"): string {
  if (
    sessionId === "" ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0")
  ) {
    throw new Error(`invalid session id for harness state dir: ${JSON.stringify(sessionId)}`);
  }
  return `${harnessStateRoot(root)}/${sessionId}`;
}

/**
 * Delete per-session harness state last touched more than `retentionDays`
 * days ago (default: {@link HARNESS_STATE_RETENTION_DAYS}). Returns the
 * session ids whose directories were removed.
 *
 * "Last touched" is the newest mtime among the session directory and the
 * files directly inside it: the wrapper rewrites `cwd`/`env` on every
 * bash call, so an active session's directory stays fresh even though
 * the directory's own mtime only moves when entries are created/renamed.
 * A missing harness root is not an error (fresh volume). Entries that
 * are not directories are left alone — only our per-session directories
 * are harness records. A single undeletable entry (e.g. EACCES) does not
 * abort the sweep; the caller decides whether a partial prune matters.
 *
 * Runs at daemon start-up only (mirroring `SessionStore.pruneOldSessions`):
 * there is no scheduled task reaping these directories.
 */
export async function pruneStaleHarnessState(
  root: string = "/var/lib/yog",
  opts: { now?: number; retentionDays?: number } = {},
): Promise<string[]> {
  const base = harnessStateRoot(root);
  const cutoff =
    (opts.now ?? Date.now()) - (opts.retentionDays ?? HARNESS_STATE_RETENTION_DAYS) * DAY_MS;
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const pruned: string[] = [];
  for (const entry of entries) {
    const dir = `${base}/${entry}`;
    try {
      const dirStat = await stat(dir);
      if (!dirStat.isDirectory()) continue;
      let newest = dirStat.mtimeMs;
      for (const name of await readdir(dir)) {
        try {
          newest = Math.max(newest, (await stat(`${dir}/${name}`)).mtimeMs);
        } catch {
          // A file vanished mid-sweep; its absence does not keep the
          // record alive.
        }
      }
      if (newest >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      pruned.push(entry);
    } catch {
      // Best effort per record: an undeletable directory must not block
      // the rest of the sweep (the caller logs the outcome).
    }
  }
  return pruned;
}
