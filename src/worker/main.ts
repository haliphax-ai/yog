/**
 * Worker process entrypoint.
 *
 * The daemon spawns this process (`node src/worker/main.ts --worker`) to run
 * the persistent-shell `bash` tool on its behalf. The worker speaks JSONL
 * over stdio (see `./protocol.ts`): one request per line on stdin, one
 * response per line on stdout. It processes requests serially (the shell is
 * stateful), and it forwards SIGTERM/SIGINT to the currently-running bash
 * child so teardown never leaves a shell behind.
 */
import { createInterface } from "node:readline";
import { readFile, spawn } from "../host.ts";
import { decodeFrame, encodeFrame, type WorkerResponse, type WorkerRequest } from "./protocol.ts";
import { buildToolEnv, WRAPPER } from "./wrapper.ts";

let currentChild: ReturnType<typeof spawn> | undefined;

/** Run one script through the persistent-shell wrapper. */
function runBash(script: string, stateDir?: string): Promise<WorkerResponse> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("bash", ["-c", WRAPPER, "harness", script], {
        cwd: process.cwd(),
        env: buildToolEnv(stateDir),
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    currentChild = child;

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => errOut.push(d));

    let settled = false;
    const settle = (resp: WorkerResponse): void => {
      if (settled) return;
      settled = true;
      if (currentChild === child) currentChild = undefined;
      resolve(resp);
    };

    child.on("error", (err) => settle({ ok: false, error: err.message }));
    child.on("close", (code) => {
      void (async () => {
        settle({
          ok: true,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(errOut).toString("utf8"),
          exitCode: code,
          state: await readState(stateDir),
        });
      })();
    });
  });
}

/** Read the persisted shell-state snapshot back for the response. */
async function readState(
  stateDir?: string,
): Promise<{ cwd: string; env: string; functions: string } | undefined> {
  if (!stateDir) return undefined;
  const [cwd, env, functions] = await Promise.all([
    readFileSafe(`${stateDir}/cwd`),
    readFileSafe(`${stateDir}/env`),
    readFileSafe(`${stateDir}/functions`),
  ]);
  if (cwd === undefined && env === undefined && functions === undefined) return undefined;
  return { cwd: cwd ?? "", env: env ?? "", functions: functions ?? "" };
}

/** Read a file, tolerating absence (returns undefined). */
async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function forwardSignal(signal: NodeJS.Signals): void {
  currentChild?.kill(signal);
  // Give the shell a moment to die, then force exit.
  setTimeout(() => process.exit(signal === "SIGTERM" ? 143 : 130), 1000).unref();
}

process.on("SIGTERM", () => forwardSignal("SIGTERM"));
process.on("SIGINT", () => forwardSignal("SIGINT"));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let chain: Promise<void> = Promise.resolve();

rl.on("line", (line) => {
  chain = chain.then(async () => {
    let frame: { id: number; payload: unknown } | undefined;
    try {
      frame = decodeFrame(line);
    } catch (err) {
      console.error(`[worker] dropping bad frame: ${(err as Error).message}`);
      return;
    }
    if (!frame) return;

    const payload = frame.payload as WorkerRequest;
    let resp: WorkerResponse;
    if (payload.type === "bash.run") {
      resp = await runBash(payload.script, payload.stateDir);
    } else {
      resp = { ok: false, error: `unknown request type: ${JSON.stringify(payload)}` };
    }
    process.stdout.write(encodeFrame(frame.id, resp));
  });
});

rl.on("close", () => {
  chain.then(() => process.exit(0)).catch(() => process.exit(1));
});
