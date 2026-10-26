import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpServer, type HttpDeps } from "./http.ts";

/** Options accepted by {@link createDaemon}. */
export interface DaemonOptions {
  port?: number;
  host?: string;
  /** Injected boundaries (store, orchestrator, model provider, ...). */
  deps?: HttpDeps;
}

/** Handle to a running (or stubbed) daemon. */
export interface Daemon {
  server: ReturnType<typeof createServer>;
  url: string;
  close(): Promise<void>;
}

/**
 * Minimal composition root: builds the v1 HTTP/SSE adapter from injected deps
 * and starts it. Kept intentionally thin — full daemon wiring (real store,
 * orchestrator, turn engine) lands in a later task.
 */
export async function createDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const host = opts.host ?? "127.0.0.1";
  const server = createHttpServer(opts.deps ?? {});
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8111, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${addr.port}`,
    close: async () =>
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
