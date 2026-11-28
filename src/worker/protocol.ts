/**
 * JSONL wire protocol between the harness (daemon side) and its worker
 * process. One JSON object per line on the worker's stdin; one JSON object
 * per line on its stdout. Every frame carries a numeric `id` so responses
 * can be correlated to requests even if the worker ever processes them
 * concurrently.
 */

/** The persisted persistent-shell state captured by the wrapper. */
export interface ShellSnapshot {
  /** `pwd -P` output (the shell's working directory). */
  readonly cwd: string;
  /** `export -p` output (exported variables). */
  readonly env: string;
  /** `declare -f` output (shell functions). */
  readonly functions: string;
}

/** A request to run a bash script in the worker's persistent shell. */
export interface BashRunRequest {
  readonly type: "bash.run";
  /** Script passed to the wrapper shell (`eval "$1"`). */
  readonly script: string;
  /**
   * Directory where the persistent shell state (cwd + env + functions) is
   * snapshotted. The daemon always supplies the per-session directory
   * (`<stateRoot>/harness/<sessionId>`); omitted only for direct worker
   * callers (tests), which fall back to the worker's `<HOME>/.harness`.
   */
  readonly stateDir?: string;
  /**
   * Optional prior snapshot to restore into the state dir before running. The
   * daemon supplies this from its agentfs-backed home so shell state survives
   * across daemon restarts and is queryable/rewindable.
   */
  readonly restore?: Partial<ShellSnapshot>;
  /**
   * Extra PATH entries (loaded-skill `scripts/` directories) prepended for
   * this run. The daemon supplies the session's loaded-skill script paths;
   * each run is independent (the wrapper prepends them to the snapshotted
   * PATH), so unloading a skill takes effect on the next call.
   */
  readonly extraPath?: readonly string[];
  /**
   * The agent-CLI shim directory (the FUSE mount's `<mount>/bin`), prepended
   * for this run ahead of the skill entries — a skill shadowing `yog` cannot
   * outlive its unload. Omitted only by direct worker callers (tests).
   */
  readonly cliBin?: string;
}

/** Ask the worker for its current bash child's process ids (out-of-band). */
export interface BashPidRequest {
  readonly type: "bash.pid";
}

export type WorkerRequest = BashRunRequest | BashAbortRequest | BashPidRequest;

/** Ask the worker to kill its currently-running bash child (turn abort). */
export interface BashAbortRequest {
  readonly type: "bash.abort";
}

/** Acknowledgement for `bash.abort`: no child was running. */
export interface BashAbortIdle {
  readonly ok: true;
  readonly aborted: false;
}

/**
 * The running child was killed. Shell state was snapshotted by the
 * wrapper's EXIT trap before the process died; no new snapshot is returned
 * here (the worker's next `bash.run` reads it back from the state dir).
 */
export interface BashAbortKilled {
  readonly ok: true;
  readonly aborted: true;
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export type WorkerAbortResponse = BashAbortIdle | BashAbortKilled;
/** Reply to `bash.pid`: the current child's ids, or null when idle. */
export interface BashPidOk {
  readonly ok: true;
  /** The wrapper child's pid; null when no child is running. */
  readonly pid: number | null;
  /** The wrapper child's process group id (wrapper runs `detached`). */
  readonly pgid: number | null;
}

export type WorkerPidResponse = BashPidOk;

/** Successful bash execution result. */
export interface BashRunOk {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /** The death signal when the child was killed (SIGTERM &c.); null on a
   *  normal exit. The jobs manager classifies a signal death as a
   *  TERMINATION — a waking one (yog#146). */
  readonly signal?: string | null;
  /**
   * Snapshot of the persistent shell state after the run, read back from the
   * state dir. Present only when `stateDir` was provided and the files
   * existed.
   */
  readonly state?: ShellSnapshot;
  /**
   * The wrapper child's pid at settle time — forensics for the agent:
   * the wrapper child was spawned `detached` (own process group), so
   * `kill -- -<pid>` takes the whole tree. Absent when the child never
   * spawned.
   */
  readonly pid?: number;
  /** The wrapper child's process group id at settle time (=== `pid`). */
  readonly pgid?: number;
}

/** Spawn/exec failure or malformed request. */
export interface BashRunErr {
  readonly ok: false;
  readonly error: string;
}

export type WorkerResponse = BashRunOk | BashRunErr;

/** Encode a frame as a single JSONL line. */
export function encodeFrame(id: number, payload: unknown): string {
  return JSON.stringify({ id, payload }) + "\n";
}

/**
 * Decode one frame line. Blank/whitespace-only lines are ignored. Throws on
 * malformed JSON or a missing/non-numeric id.
 */
export function decodeFrame(line: string): { id: number; payload: unknown } | undefined {
  const trimmed = line.trim();
  if (trimmed === "") return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`malformed worker frame: ${(err as Error).message}`);
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("malformed worker frame: not an object");
  }
  const record = obj as { id?: unknown; payload?: unknown };
  if (typeof record.id !== "number" || !("payload" in record)) {
    throw new Error("malformed worker frame: missing numeric id or payload");
  }
  return { id: record.id, payload: record.payload };
}
