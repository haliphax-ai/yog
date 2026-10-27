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

/** Kill every worker spawned by this process (used at teardown). */
export function shutdownAllWorkers(): Promise<void> {
  const all = [...liveClients];
  liveClients.clear();
  return Promise.all(all.map((c) => c.close().catch(() => {}))).then(() => undefined);
}

export class WorkerClient {
  readonly #child: ChildProcess;
  readonly #pending = new Map<
    number,
    { resolve: (v: WorkerResponse) => void; reject: (e: Error) => void }
  >();
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
    // never runs as the harness user. Drop when the target differs from the
    // current uid/gid; if the drop is not possible (no privilege), fall back
    // to running the worker as the harness user so local/unprivileged runs
    // keep working.
    const agentUid = Number(process.env["YOG_AGENT_UID"] ?? "");
    const agentGid = Number(process.env["YOG_AGENT_GID"] ?? "");
    const curUid = process.getuid?.() ?? -1;
    const curGid = process.getgid?.() ?? -1;
    const dropToAgent =
      agentUid > 0 && agentGid > 0 && (agentUid !== curUid || agentGid !== curGid);

    let child: ChildProcess;
    if (dropToAgent) {
      const dropOpts: SpawnOptions = {
        ...baseOpts,
        uid: agentUid,
        gid: agentGid,
        // The worker (and its bash children) should see the agent's home so
        // rc sourcing and shell-state files land in the same place regardless
        // of which daemon user spawned it.
        env: { ...process.env, HOME: process.env["YOG_AGENT_HOME"] ?? "/home/agent" },
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
   * changes persist into later calls).
   */
  runBash(
    script: string,
    stateDir?: string,
    restore?: Partial<ShellSnapshot>,
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
    };
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      let line: string;
      try {
        line = encodeFrame(id, request);
      } catch (err) {
        this.#pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (!this.#child.stdin?.write(line)) {
        this.#pending.delete(id);
        reject(new Error("worker stdin closed"));
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
    pending.resolve(frame.payload as WorkerResponse);
  }

  #failAll(err: Error): void {
    for (const [, pending] of this.#pending) pending.reject(err);
    this.#pending.clear();
  }
}
