/**
 * Worker client (daemon side): spawns the worker process and speaks the JSONL
 * protocol over its stdio. Requests are correlated to responses by numeric
 * id, so concurrent tool calls can be in flight at once even though the
 * worker executes them serially.
 */
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess, type SpawnOptions } from "../host.ts";
import { decodeFrame, encodeFrame, type WorkerRequest, type WorkerResponse } from "./protocol.ts";

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
  static start(): Promise<WorkerClient> {
    const entry = fileURLToPath(new URL("./main.ts", import.meta.url));
    const opts: SpawnOptions = { stdio: ["pipe", "pipe", "pipe"] };
    // When the daemon runs as root, drop the worker to the agent user so bash
    // executes as the agent (mirrors the designed daemon/agent split).
    if (process.getuid?.() === 0) {
      opts.uid = Number(process.env["YOG_AGENT_UID"] ?? process.getuid?.() ?? 0);
      opts.gid = Number(process.env["YOG_AGENT_GID"] ?? process.getgid?.() ?? 0);
    }
    const child = spawn(process.execPath, [entry, "--worker"], opts);
    return Promise.resolve(new WorkerClient(child));
  }

  /**
   * Run a script in the worker's persistent shell. `stateDir` selects where
   * the shell-state snapshot lives (and therefore whether cwd/export/function
   * changes persist into later calls).
   */
  runBash(script: string, stateDir?: string): Promise<WorkerResponse> {
    if (this.#closed) {
      return Promise.reject(new Error("worker closed"));
    }
    const id = this.#nextId++;
    const request: WorkerRequest = {
      type: "bash.run",
      script,
      ...(stateDir !== undefined ? { stateDir } : {}),
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
      console.error(`[worker] bad response frame: ${(err as Error).message}`);
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      console.error(`[worker] response for unknown id ${frame.id}`);
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
