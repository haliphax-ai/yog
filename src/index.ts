/**
 * fuse-overlay-harness — agent harness with a virtual FUSE filesystem.
 *
 * Usage: yog run <modelId> "<prompt>"
 *        yog serve [--host <addr>] [--port <n>]
 *
 * `run` is a pure network client: it speaks HTTP/SSE to a running daemon
 * (see client/run.ts) and never spawns one itself — an unreachable server is
 * a friendly `yog serve` error. `serve` starts the long-lived HTTP/SSE daemon
 * (see server/serve.ts), which owns the in-process run orchestration
 * (OpenAI client, state db, worker, mount and TurnEngine).
 */
import { parseServeArgs, runCommand } from "./cli.ts";
import { createDaemon } from "./server/index.ts";

const USAGE = 'usage: yog run <modelId> "<prompt>"\n       yog serve [--host <addr>] [--port <n>]';

/**
 * Termination handling. The first SIGINT/SIGTERM aborts the in-flight
 * network request; a second signal (or a stalled teardown) force-exits so
 * the process never wedges.
 */
const abortController = new AbortController();
let exitRequested = false;

function requestExit(signal: NodeJS.Signals): void {
  if (exitRequested) {
    console.error(`forced exit after repeated ${signal}`);
    process.exit(130);
  }
  exitRequested = true;
  console.error(`received ${signal}; aborting run and tearing down`);
  abortController.abort();
  setTimeout(() => process.exit(130), 3000).unref();
}

/** Start the long-lived HTTP/SSE daemon; resolves only on shutdown. */
async function serve(argv: readonly string[]): Promise<void> {
  const parsed = parseServeArgs(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error(USAGE);
    process.exit(1);
  }
  // createDaemon wires signals (SIGINT/SIGTERM → graceful shutdown → exit),
  // so the process stays alive on the listening server's event loop.
  const daemon = await createDaemon({
    ...(parsed.host !== undefined ? { host: parsed.host } : {}),
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
  });
  console.error(`[yog] serve listening at ${daemon.url}`);
}

/**
 * One-shot `yog run`: delegate to the network client (client/run.ts).
 * Transport and server failures resolve as exit code 1 with a message on
 * stderr; no server internals are touched and no daemon is spawned.
 */
async function run(argv: readonly string[]): Promise<void> {
  const code = await runCommand(argv, { signal: abortController.signal });
  process.exitCode = abortController.signal.aborted ? 130 : code;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "serve") {
    // serve owns its own signal handling (inside createDaemon).
    await serve(argv);
    return;
  }
  process.on("SIGINT", () => requestExit("SIGINT"));
  process.on("SIGTERM", () => requestExit("SIGTERM"));
  await run(argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
