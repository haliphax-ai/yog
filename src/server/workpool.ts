/**
 * WorkerPool: a fixed-size set of {@link WorkerClient} workers that executes
 * bash scripts for sessions in parallel.
 *
 * Sizing: an explicit `size` option wins; otherwise `YOG_WORKERS` (a positive
 * integer) overrides the default of `max(1, os.cpus().length - 1)` (values
 * below 1 are clamped up to 1).
 *
 * Assignment is *soft pinning*: the first member that serves a session becomes
 * its preferred member. Later runs reuse that member while it is free; if it
 * is busy, any free member serves the run instead — shell state travels with
 * the caller via the snapshot `restore` option, so reassignment stays correct.
 */
import { cpus } from "node:os";
import { WorkerClient, type ShellSnapshot, type WorkerResponse } from "../worker/index.ts";

export interface WorkerPoolOptions {
  /** Explicit pool size (clamped to at least 1). */
  readonly size?: number;
}

export interface WorkerPoolRunOptions {
  /** Directory where the session's persistent shell state is snapshotted. */
  readonly stateDir?: string;
  /** Prior snapshot to restore into the state dir before running. */
  readonly restore?: Partial<ShellSnapshot>;
}

/** Resolve the pool size from option, env override, or CPU count. */
function resolveSize(explicit?: number): number {
  if (explicit !== undefined) return Math.max(1, Math.floor(explicit));
  const raw = process.env["YOG_WORKERS"];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return Math.max(1, parsed);
  }
  return Math.max(1, cpus().length - 1);
}

export class WorkerPool {
  readonly size: number;
  readonly #clients: Promise<WorkerClient[]>;
  readonly #preferred = new Map<string, number>();
  readonly #current = new Map<string, number>();
  readonly #inFlight: number[];
  #closed = false;

  constructor(options?: WorkerPoolOptions) {
    this.size = resolveSize(options?.size);
    this.#inFlight = Array.from({ length: this.size }, () => 0);
    // Workers start on construction; callers await readiness via run().
    this.#clients = Promise.all(Array.from({ length: this.size }, () => WorkerClient.start()));
  }

  /** Index of the pool member that last served `sessionId`, if any. */
  memberFor(sessionId: string): number | undefined {
    return this.#current.get(sessionId);
  }

  /** Run `script` for `sessionId` on its pinned (or a free) member. */
  async run(
    sessionId: string,
    script: string,
    opts?: WorkerPoolRunOptions,
  ): Promise<WorkerResponse> {
    if (this.#closed) throw new Error("worker pool closed");
    const clients = await this.#clients;
    const idx = this.#pick(sessionId);
    this.#current.set(sessionId, idx);
    if (!this.#preferred.has(sessionId)) this.#preferred.set(sessionId, idx);
    this.#inFlight[idx] = (this.#inFlight[idx] ?? 0) + 1;
    try {
      const client = clients[idx];
      if (!client) throw new Error(`no worker at index ${idx}`);
      return await client.runBash(script, opts?.stateDir, opts?.restore);
    } finally {
      this.#inFlight[idx] = (this.#inFlight[idx] ?? 1) - 1;
    }
  }

  /** Shut down every member. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const clients = await this.#clients.catch(() => [] as WorkerClient[]);
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  }

  /** Choose a member: preferred when free, else any free one, else least busy. */
  #pick(sessionId: string): number {
    const preferred = this.#preferred.get(sessionId);
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
