/**
 * Per-call scratch state dirs for the persistent shell.
 *
 * The wrapper's EXIT-trap capture re-opens the snapshot files by the
 * `HARNESS_STATE_DIR` path, so the running child cannot be redirected —
 * a live process would last-writer-wins against anything sharing its
 * dir (a future background job against a foreground call, or the
 * `current`-symlink redirect: racy for the same reason). The fix: every
 * call spawns into its own scratch dir, seeded by the worker with the
 * snapshot the daemon loaded (`restore`), and the dir is deleted when
 * the call settles. The persistent record is the agentfs mirror
 * (`saveShellSnapshot`); the live `<harness>/<sessionId>` files stop
 * being written and remain only as legacy state.
 *
 * This module derives the paths and owns the leak reaper. Creation and
 * deletion themselves ride the spawn/settle path (see
 * `poolExecutor`): the worker already hydrates `restore` into the state
 * dir before the child spawns (no daemon-side seed writes needed), and
 * the executor removes the dir once the response settles.
 */

import { randomUUID } from "node:crypto";

import { readdir, rm, stat } from "../host.ts";

import { harnessStateDir } from "./agents.ts";

/** Leaf directory under a session's harness state dir holding scratch dirs. */
export const RUNS_DIR_NAME = "runs";

/** Scratch dirs older than this are leaks (safely above the future job cap). */
export const SCRATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The scratch state dir for one bash call:
 * `<stateRoot>/harness/<sessionId>/runs/<uuid>`.
 *
 * The parent session id is validated by {@link harnessStateDir} (a plain
 * file-name token — separators or dot-segments would escape the harness
 * root and are rejected loudly); the uuid leaf needs no further
 * validation. Sessions share one `runs/` pool each; a detached call can
 * later be keyed independently in the pool without touching these paths.
 */
export function runScratchDir(sessionId: string, root: string = "/var/lib/yog"): string {
  return `${harnessStateDir(sessionId, root)}/${RUNS_DIR_NAME}/${randomUUID()}`;
}

/**
 * Newest mtime among a run dir and the files directly inside it, mirroring
 * {@link pruneStaleHarnessState}: the wrapper rewrites `cwd`/`env` on every
 * call, so a live call's dir stays fresh even though the dir's own mtime
 * only moves when entries are created/renamed. A file vanished mid-sweep
 * does not keep the record alive.
 */
async function newestMtimeMs(dir: string, floor: number): Promise<number> {
  let newest = floor;
  for (const name of await readdir(dir)) {
    try {
      newest = Math.max(newest, (await stat(`${dir}/${name}`)).mtimeMs);
    } catch {
      // A file vanished mid-sweep; its absence does not keep the record alive.
    }
  }
  return newest;
}

/** True when the run dir is a reaper candidate (a leak, not a live call). */
async function isStaleRunDir(dir: string, cutoff: number): Promise<boolean> {
  try {
    const dirStat = await stat(dir);
    if (!dirStat.isDirectory()) return false;
    return (await newestMtimeMs(dir, dirStat.mtimeMs)) < cutoff;
  } catch {
    return false; // vanished by its own settle-delete mid-sweep — not stale
  }
}

/**
 * Delete scratch dirs under `<stateRoot>/harness/<sessionId>/runs/` that
 * are no longer needed. `maxAgeMs: 0` (the start-up wipe) removes every
 * dir unconditionally — no scratch dir survives a daemon restart, since
 * its bash workers die with it and nothing can be in flight. The default
 * (24h, the periodic reaper) prunes only leaks (see {@link isStaleRunDir}).
 *
 * Returns the removed dir names. A missing runs root (fresh volume) is not
 * an error; an undeletable entry is skipped so the rest of the sweep
 * lands. Best effort per record, like every state sweep.
 */
export async function sweepRunScratchDirs(
  sessionId: string,
  root: string = "/var/lib/yog",
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<string[]> {
  const runsRoot = `${harnessStateDir(sessionId, root)}/${RUNS_DIR_NAME}`;
  const maxAgeMs = opts.maxAgeMs ?? SCRATCH_MAX_AGE_MS;
  const cutoff = (opts.now ?? Date.now()) - maxAgeMs;
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return []; // no runs root yet (fresh volume) — nothing to sweep
  }
  const pruned: string[] = [];
  for (const entry of entries) {
    const dir = `${runsRoot}/${entry}`;
    try {
      if (maxAgeMs > 0 && !(await isStaleRunDir(dir, cutoff))) continue;
      await rm(dir, { recursive: true, force: true });
      pruned.push(entry);
    } catch {
      // Best effort per record: an undeletable dir must not block the rest.
    }
  }
  return pruned;
}
