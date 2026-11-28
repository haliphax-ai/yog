/**
 * WorkerPool: a fixed-size set of {@link WorkerClient} workers that executes
 * bash scripts for sessions in parallel.
 *
 * Runs are addressed by a string key — the session id by default, or an
 * explicit `runKey` (the background-jobs manager detaches a live run under
 * `bg:<jobId>` so session-keyed aborts can never kill it). Sizing: an
 * explicit `size` option wins; otherwise the configured pool size (config
 * `workers`, injected) or the CPU default `max(1, cpus.length - 1)` applies
 * (values below 1 are clamped up to 1).
 *
 * Assignment is *soft pinning*: the first member that serves a key becomes
 * its preferred member. Later runs reuse that member while it is free; if
 * it is busy, any free member serves the run instead — shell state travels
 * with the caller via the snapshot `restore` option, so reassignment stays
 * correct.
 */
import { WorkerClient, type ShellSnapshot, type WorkerResponse } from "../worker/index.ts";
import { defaultWorkers } from "../config.ts";

export interface WorkerPoolOptions {
  /** Explicit pool size (clamped to at least 1). */
  readonly size?: number;
}

export interface WorkerPoolRunOptions {
  /**
   * Directory where the session's persistent shell state is snapshotted.
   * The daemon supplies the per-session directory
   * (`<stateRoot>/harness/<sessionId>`); omitted only by direct callers.
   */
  readonly stateDir?: string;
  /** Prior snapshot to restore into the state dir before running. */
  readonly restore?: Partial<ShellSnapshot>;
  /** Loaded-skill `scripts/` directories prepended to PATH for this run. */
  readonly extraPath?: readonly string[];
  /** The agent-CLI shim directory (`<mount>/bin`) prepended to PATH first. */
  readonly cliBin?: string;
  /**
   * Explicit run key — the abort/pinning identity of this run in the pool.
   * Default (omitted): the session id itself, bit-identical to the old
   * behavior. The background-jobs manager passes `bg:<jobId>` at detach.
   */
  readonly runKey?: string;
}

/** Resolve the pool size from an explicit option; undefined = CPU default. */
function resolveSize(explicit?: number): number {
  if (explicit !== undefined) return Math.max(1, Math.floor(explicit));
  return defaultWorkers();
}

export class WorkerPool {
  readonly size: number;
  readonly #clients: Promise<WorkerClient[]>;
  /** Run key → the member that last served it (soft pinning). */
  readonly #preferred = new Map<string, number>();
  /** Run key → the member that most recently ran a script for it. */
  readonly #current = new Map<string, number>();
  /** Run key → the worker index running its current script (abort key). */
  readonly #running = new Map<string, number>();
  readonly #inFlight: number[];
  #closed = false;

  constructor(options?: WorkerPoolOptions) {
    this.size = resolveSize(options?.size);
    this.#inFlight = Array.from({ length: this.size }, () => 0);
    // Workers start on construction; callers await readiness via run().
    this.#clients = Promise.all(Array.from({ length: this.size }, () => WorkerClient.start()));
  }

  /** Index of the pool member that last served a key, if any. */
  memberFor(key: string): number | undefined {
    return this.#current.get(key);
  }

  /**
   * Run `script` for the run identified by `runKey ?? sessionId` on its
   * pinned (or a free) member.
   *
   * The key is also the abort key: while the script runs, the pool maps it
   * to the worker executing it so {@link abortRun} can address the kill to
   * the right worker.
   */
  async run(
    sessionId: string,
    script: string,
    opts?: WorkerPoolRunOptions,
  ): Promise<WorkerResponse> {
    const key = opts?.runKey ?? sessionId;
    if (this.#closed) throw new Error("worker pool closed");
    const clients = await this.#clients;
    const idx = this.#pick(key);
    this.#current.set(key, idx);
    if (!this.#preferred.has(key)) this.#preferred.set(key, idx);
    this.#inFlight[idx] = (this.#inFlight[idx] ?? 0) + 1;
    this.#running.set(key, idx);
    try {
      const client = clients[idx];
      if (!client) throw new Error(`no worker at index ${idx}`);
      return await client.runBash(
        script,
        opts?.stateDir,
        opts?.restore,
        opts?.extraPath,
        opts?.cliBin,
      );
    } finally {
      this.#inFlight[idx] = (this.#inFlight[idx] ?? 1) - 1;
      if (this.#running.get(key) === idx) this.#running.delete(key);
    }
  }

  /**
   * Retarget the run currently live under `oldKey` to `newKey`. Detach-time
   * manager call: a backgrounded job drops its session key for
   * `bg:<jobId>`, so a later session-keyed abort can never kill it. Returns
   * false when nothing runs under `oldKey` (nothing to retarget).
   */
  rekeyRun(oldKey: string, newKey: string): boolean {
    const idx = this.#running.get(oldKey);
    if (idx === undefined) return false;
    this.#running.set(newKey, idx);
    // Preserve soft pinning under the new key when the old key had it.
    const preferred = this.#preferred.get(oldKey);
    if (preferred !== undefined && !this.#preferred.has(newKey)) {
      this.#preferred.set(newKey, preferred);
    }
    const current = this.#current.get(oldKey);
    if (current !== undefined && !this.#current.has(newKey)) {
      this.#current.set(newKey, current);
    }
    this.#running.delete(oldKey);
    this.#preferred.delete(oldKey);
    this.#current.delete(oldKey);
    return true;
  }

  /**
   * Kill the script currently running for `key` (turn abort, job cap,
   * idle-abort kill). The worker snapshots shell state via the wrapper's
   * EXIT trap before the child dies, so persistence is unaffected. Returns
   * false when nothing is running under `key` right now.
   */
  async abortRun(key: string): Promise<boolean> {
    const idx = this.#running.get(key);
    if (idx === undefined) return false;
    const clients = await this.#clients;
    const client = clients[idx];
    if (!client) return false;
    return await client.abortBash();
  }

  /**
   * Out-of-band pid query for the run currently live under `key`
   * (`bash.pid`, never queued behind the serial chain — a long script
   * cannot hide its own pid). The background-jobs manager stamps the
   * detached job's `pid` with this at detach time; null ids when nothing
   * runs under the key (or the worker is busy between children).
   */
  async runPid(key: string): Promise<{ pid: number | null; pgid: number | null }> {
    const idx = this.#current.get(key);
    if (idx === undefined) return { pid: null, pgid: null };
    const clients = await this.#clients;
    const client = clients[idx];
    if (!client) return { pid: null, pgid: null };
    return await client.bashPid();
  }

  /** Session-keyed abort: exactly what it always was (see {@link abortRun}). */
  async abortScript(sessionId: string): Promise<boolean> {
    return await this.abortRun(sessionId);
  }

  /** Shut down every member. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const clients = await this.#clients.catch(() => [] as WorkerClient[]);
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }

  /** Choose a member: preferred when free, else any free one, else least busy. */
  #pick(runKey: string): number {
    const preferred = this.#preferred.get(runKey);
    if (preferred !== undefined && (this.#inFlight[preferred] ?? 0) === 0) {
      return preferred;
    }
    let best = 0;
    let bestLoad = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.size; i++) {
      const load = this.#inFlight[i] ?? 0;
      if (load === 0 && i !== preferred) return i;
      if (load < bestLoad) {
        best = i;
        bestLoad = load;
      }
    }
    return best;
  }
}
