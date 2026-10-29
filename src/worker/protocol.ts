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
   * snapshotted. Omitted to use the worker's default (`.harness`).
   */
  readonly stateDir?: string;
  /**
   * Optional prior snapshot to restore into the state dir before running. The
   * daemon supplies this from its agentfs-backed home so shell state survives
   * across daemon restarts and is queryable/rewindable.
   */
  readonly restore?: Partial<ShellSnapshot>;
}

export type WorkerRequest = BashRunRequest | BashAbortRequest;

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

/** Successful bash execution result. */
export interface BashRunOk {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /**
   * Snapshot of the persistent shell state after the run, read back from the
   * state dir. Present only when `stateDir` was provided and the files
   * existed.
   */
  readonly state?: ShellSnapshot;
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
