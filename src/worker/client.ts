/**
 * Worker client (daemon side): spawns the worker process and speaks the JSONL
 * protocol over its stdio. Requests are correlated to responses by numeric
 * id, so concurrent tool calls can be in flight at once even though the
 * worker executes them serially.
 */
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess, type SpawnOptions } from "../host.ts";
import {
  decodeFrame,
  encodeFrame,
  type ShellSnapshot,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";
import { logger } from "../log.ts";

const liveClients = new Set<WorkerClient>();

/**
 * Options for spawning a worker as the agent user (daemon/agent split):
 * injected per daemon from the runtime configuration (see `config.ts`);
 * uid/gid unset (or equal to the harness process's own ids) spawns the
 * worker unchanged (local/unprivileged runs).
 */
export interface AgentSpawnOptions {
  readonly uid?: number;
  readonly gid?: number;
  readonly home?: string;
  /**
   * The agent-CLI shim directory (`<mount>/bin`) propagated to every
   * `bash.run` request (see `BashRunRequest.cliBin`).
   */
  readonly cliBin?: string;
}

/** Current agent-spawn options (set by the composition root). */
let agentSpawnOpts: AgentSpawnOptions = {};

/**
 * Inject the agent-spawn options (owned by the composition root). Safe to
 * call repeatedly; the latest call wins.
 */
export function onAgentSpawn(opts: AgentSpawnOptions): void {
  agentSpawnOpts = opts;
}

/**
 * Read-only view of the current agent-spawn options (set via
 * {@link onAgentSpawn}; the latest call wins). Exposed so the composition
 * roots registration is observable in tests and diagnostics.
 */
export function agentSpawnOptions(): Readonly<AgentSpawnOptions> {
  return agentSpawnOpts;
}

/** Kill every worker spawned by this process (used at teardown). */
export function shutdownAllWorkers(): Promise<void> {
  const all = [...liveClients];
  liveClients.clear();
  return Promise.all(all.map((c) => c.close().catch(() => {}))).then(() => undefined);
}

/**
 * True when the injected agent spawn options ask for a real uid/gid drop:
 * both ids are set, both are non-root, and at least one differs from the
 * current process (an equal target would make the drop a no-op).
 */
function shouldDropToAgent(opts: AgentSpawnOptions, curUid: number, curGid: number): boolean {
  const { uid, gid } = opts;
  return (uid ?? 0) > 0 && (gid ?? 0) > 0 && (uid !== curUid || gid !== curGid);
}

export class WorkerClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<
    number,
    { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }
  >();
  /** Request ids currently in flight (bash children running in the worker). */
  readonly #inFlightIds = new Set<number>();
  #nextId = 1;
  #closed = false;
  #lineBuffer = "";

  private constructor(child: ChildProcess) {
    this.#child = child;
    liveClients.add(this);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#onData(chunk));
    child.on("error", (err) => this.#failAll(err));
    child.on("close", () => this.#failAll(new Error("worker exited")));
  }

  /** Spawn a worker process for this harness. */
  static async start(): Promise<WorkerClient> {
    const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
    const baseOpts: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"] };

    // The daemon/agent split: the harness (e.g. root or the `yog` daemon
    // user) spawns the worker as the *agent* user, so model-executed bash
    // never runs as the harness user. Drop when the injected uid/gid differ
    // from the current ids; if the drop is not possible (no privilege), fall
    // back to running the worker as the harness user so local/unprivileged
    // runs keep working.
    const curUid = process.getuid?.() ?? -1;
    const curGid = process.getgid?.() ?? -1;
    const dropToAgent = shouldDropToAgent(agentSpawnOpts, curUid, curGid);

    let child: ChildProcess;
    if (dropToAgent) {
      // The agent's home is both its HOME and the worker's cwd: relative
      // paths in model-executed scripts resolve somewhere the agent can
      // write (the daemon's cwd is yog-owned and must never see agent
      // writes — that was the source of pervasive EACCES in the container).
      const agentHome = agentSpawnOpts.home ?? "/home/agent";
      const dropOpts: SpawnOptions = {
        ...baseOpts,
        uid: agentSpawnOpts.uid,
        gid: agentSpawnOpts.gid,
        cwd: agentHome,
        // The worker (and its bash children) see the agent's home so rc
        // sourcing and shell-state files land in the same place regardless
        // of which daemon user spawned it.
        env: {
          ...process.env,
          HOME: agentHome,
        },
      };
      try {
        child = spawn(process.execPath, [entry, "--worker"], dropOpts);
      } catch {
        child = spawn(process.execPath, [entry, "--worker"], baseOpts);
      }
      // setuid/setgid failures surface as an async 'error' (EPERM) rather
      // than a thrown exception, so wait a tick; if the privileged spawn
      // never came up, respawn without the drop.
      await new Promise<void>((resolve) => {
        child.once("spawn", () => resolve());
        child.once("error", () => resolve());
      });
      if (!child.pid) {
        child = spawn(process.execPath, [entry, "--worker"], baseOpts);
        logger.warn(
          "[worker] could not drop to agent user (EPERM); bash will run as the harness user. " +
            "To enable the daemon/agent split, run the harness with effective CAP_SETUID/CAP_SETGID " +
            "(e.g. as root, or with --cap-add SETUID,SETGID when starting as root), or run the " +
            "harness as the agent user itself.",
        );
      }
    } else {
      child = spawn(process.execPath, [entry, "--worker"], baseOpts);
    }
    return new WorkerClient(child);
  }

  /**
   * Run a script in the worker's persistent shell. `stateDir` selects where
   * the shell-state snapshot lives (and therefore whether cwd/export/function
   * changes persist into later calls). The daemon supplies the per-session
   * directory (`<stateRoot>/harness/<sessionId>`).
   */
  runBash(
    script: string,
    stateDir?: string,
    restore?: Partial<ShellSnapshot>,
    extraPath?: readonly string[],
    cliBin?: string,
  ): Promise<WorkerResponse> {
    if (this.#closed) {
      return Promise.reject(new Error("worker closed"));
    }
    const id = this.#nextId++;
    const request: WorkerRequest = {
      type: "bash.run",
      script,
      ...(stateDir !== undefined ? { stateDir } : {}),
      ...(restore ? { restore } : {}),
      ...(extraPath && extraPath.length > 0 ? { extraPath: [...extraPath] } : {}),
      ...(cliBin !== undefined ? { cliBin } : {}),
    };
    this.#inFlightIds.add(id);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      let line: string;
      try {
        line = encodeFrame(id, request);
      } catch (err) {
        this.#pending.delete(id);
        this.#inFlightIds.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!this.#child.stdin?.write(line)) {
        this.#pending.delete(id);
        this.#inFlightIds.delete(id);
        reject(new Error("worker stdin closed"));
      }
    });
  }

  /**
   * Kill the bash child currently running in this worker (turn abort). The
   * worker snapshots shell state via the wrapper's EXIT trap before the
   * child dies, so persistence is unaffected. The killed run's daemon-side
   * promise settles as a normal (killed) response — the tool layer surfaces
   * the kill through its own audit trail.
   */
  async abortBash(): Promise<boolean> {
    if (this.#closed) return false;
    if (this.#inFlightIds.size === 0) return false;
    const id = this.#nextId++;
    const request: WorkerRequest = { type: "bash.abort" };
    this.#inFlightIds.delete(id);
    return await new Promise<boolean>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (resp) => {
          const rec = resp as { ok?: boolean; aborted?: boolean };
          resolve(rec.aborted === true);
        },
        reject,
      });
      try {
        this.#child.stdin?.write(encodeFrame(id, request));
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Ask the worker for the bash child currently running in it (out-of-band:
   * the request never queues behind the serial chain, so a long script does
   * not hide its own pid). Returns null ids when the worker is idle or
   * closed.
   */
  async bashPid(): Promise<{ pid: number | null; pgid: number | null }> {
    if (this.#closed) return { pid: null, pgid: null };
    const id = this.#nextId++;
    const request: WorkerRequest = { type: "bash.pid" };
    return await new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (resp) => {
          const rec = resp as { pid?: number | null; pgid?: number | null };
          resolve({ pid: rec.pid ?? null, pgid: rec.pgid ?? null });
        },
        reject,
      });
      try {
        this.#child.stdin?.write(encodeFrame(id, request));
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Terminate the worker and reject any in-flight requests. */
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    liveClients.delete(this);
    this.#failAll(new Error("worker closed"));
    const child = this.#child;
    return new Promise((resolve) => {
      const done = (): void => resolve();
      child.once("close", done);
      child.kill("SIGTERM");
      setTimeout(() => {
        child.removeListener("close", done);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    });
  }

  #onData(chunk: string): void {
    this.#lineBuffer += chunk;
    let nl: number;
    while ((nl = this.#lineBuffer.indexOf("\n")) >= 0) {
      const line = this.#lineBuffer.slice(0, nl);
      this.#lineBuffer = this.#lineBuffer.slice(nl + 1);
      this.#handleLine(line);
    }
  }

  #handleLine(line: string): void {
    let frame: { id: number; payload: unknown };
    try {
      const decoded = decodeFrame(line);
      if (!decoded) return;
      frame = decoded;
    } catch (err) {
      logger.error(`[worker] bad response frame: ${(err as Error).message}`);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      logger.error(`[worker] response for unknown id ${frame.id}`);
      return;
    }
    this.#pending.delete(frame.id);
    this.#inFlightIds.delete(frame.id);
    pending.resolve(frame.payload as WorkerResponse);
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) pending.reject(err);
    this.#pending.clear();
    this.#inFlightIds.clear();
  }
}
