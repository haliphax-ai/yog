/**
 * JSONL wire protocol between the harness (daemon side) and its worker
 * process. One JSON object per line on the worker's stdin; one JSON object
 * per line on its stdout. Every frame carries a numeric `id` so responses
 * can be correlated to requests even if the worker ever processes them
 * concurrently.
 */

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
}

export type WorkerRequest = BashRunRequest;

/** Successful bash execution result. */
export interface BashRunOk {
  readonly ok: true;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /**
   * Optional snapshot of the persistent shell state after the run, read back
   * from the state dir. Present only when `stateDir` was provided and the
   * files existed.
   */
  readonly state?: { cwd: string; env: string; functions: string };
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
