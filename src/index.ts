/**
 * fuse-overlay-harness — agent harness with a virtual FUSE filesystem.
 *
 * Usage: yog serve [--host <addr>] [--port <n>]
 *
 * `serve` starts the long-lived HTTP/SSE daemon (see server/serve.ts),
 * which owns the in-process run orchestration (OpenAI client, state db,
 * worker, mount and TurnEngine). One-shot client turns are handled by the
 * external [yog-client-tui](https://github.com/haliphax-ai/yog-client-tui)
 * application, which speaks the v1 HTTP/SSE contract directly.
 */
import { parseServeArgs } from "./cli.ts";
import { createDaemon } from "./server/index.ts";
import { logger } from "./log.ts";

const USAGE = "usage: yog serve [--host <addr>] [--port <n>]";

/**
 * Start the long-lived HTTP/SSE daemon; resolves only on shutdown.
 * The daemon wires its own signal handling (SIGINT/SIGTERM → graceful
 * shutdown → exit), so the process stays alive on the listening server's
 * event loop.
 */
async function serve(argv: readonly string[]): Promise<void> {
  const parsed = parseServeArgs(argv);
  if ("error" in parsed) {
    logger.error(parsed.error);
    logger.error(USAGE);
    process.exit(1);
  }
  const daemon = await createDaemon({
    ...(parsed.host !== undefined ? { host: parsed.host } : {}),
    ...(parsed.port !== undefined ? { port: parsed.port } : {}),
  });
  logger.info(`[yog] serve listening at ${daemon.url}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "serve") {
    logger.error(`unknown subcommand "${argv[0] ?? ""}" (expected "serve")`);
    logger.error(USAGE);
    process.exit(1);
  }
  await serve(argv);
}

main().catch((err) => {
  logger.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
