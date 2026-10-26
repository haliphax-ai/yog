import { createServer } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type Fuse from "fuse-native";
import { createHttpServer, type HttpDeps } from "./http.ts";
import { encodeEvent, type SseEnvelope } from "./sse.ts";
import { SessionStore } from "./store/sessions.ts";
import { WorkerPool } from "./workpool.ts";
import { SessionOrchestrator } from "./orchestrator.ts";
import { AgentFSState, DEFAULT_AGENT_ID, stateRoot } from "../state/index.ts";
import { mountSys, unmountSys } from "../mount.ts";
import { TurnEngine, type TurnOptions } from "../turn.ts";
import type { TurnSink, TurnEvent } from "../turn/sink.ts";
import { tools, descriptors } from "../register.ts";
import { mkdir } from "../host.ts";

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

/** Model id advertised by capabilities and used for turns (env → fallback). */
function resolveModelId(): string {
  return process.env.YOG_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
}

/** OpenAI client from env (proxy/key overrides; SDK defaults otherwise). */
function openaiClient(): OpenAI {
  return new OpenAI({
    ...(process.env["OPENAI_BASE_URL"] ? { baseURL: process.env["OPENAI_BASE_URL"] } : {}),
    ...(process.env["OPENAI_API_KEY"] ? { apiKey: process.env["OPENAI_API_KEY"] } : {}),
  });
}

/**
 * Composition root: builds the v1 HTTP/SSE adapter from the real boundaries
 * (session store, worker pool, orchestrator, turn engine, FUSE mount) and
 * starts it.
 *
 * When `opts.deps` is supplied (tests), those boundaries are used verbatim —
 * no store, pool, or mount is created. Otherwise `createDaemon` composes the
 * daemon itself from options → env → defaults.
 */
export async function createDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const host = opts.host ?? process.env.YOG_HOST ?? "127.0.0.1";
  const envPort = process.env.YOG_PORT ? Number.parseInt(process.env.YOG_PORT, 10) : Number.NaN;
  const port = opts.port ?? (Number.isFinite(envPort) && envPort > 0 ? envPort : 8111);

  if (!opts.deps) {
    // --- persistence (best effort: continue without an audit trail) ---
    let store: SessionStore | undefined;
    try {
      await mkdir(stateRoot(), { recursive: true });
      store = new SessionStore(join(stateRoot(), "sessions.db"));
    } catch (err) {
      console.error(
        `[yog] warning: session store unavailable (${(err as Error).message}); continuing`,
      );
    }

    // --- agent state (best effort, mirrors the `run` path) ---
    let state: AgentFSState | undefined;
    try {
      state = await AgentFSState.open({ agentId: DEFAULT_AGENT_ID });
    } catch (err) {
      console.error(
        `[yog] warning: agent state unavailable (${(err as Error).message}); continuing`,
      );
    }

    // --- worker pool + orchestrator ---
    let pool: WorkerPool | undefined;
    let orchestrator: SessionOrchestrator | undefined;
    try {
      pool = new WorkerPool();
      orchestrator = new SessionOrchestrator({ store, pool });
    } catch (err) {
      console.error(
        `[yog] warning: worker pool unavailable (${(err as Error).message}); continuing`,
      );
    }

    // --- best-effort FUSE mount (skip gracefully when unavailable) ---
    let fuse: Fuse | undefined;
    try {
      fuse = await mountSys(descriptors.buildOps(), process.env.YOG_MOUNT ?? "/yog");
    } catch (err) {
      console.error(`[yog] warning: FUSE mount failed (${(err as Error).message}); continuing`);
    }

    // --- model boundary: OpenAI client + TurnEngine driving the SSE sink ---
    const modelId = resolveModelId();
    const model = {
      async runTurn(
        sessionId: string,
        req: Record<string, unknown>,
        ctx: { emit: (ev: SseEnvelope) => Promise<void>; signal?: AbortSignal },
      ): Promise<void> {
        const client = openaiClient();
        const messages: ChatCompletionMessageParam[] = [
          { role: "user", content: typeof req.prompt === "string" ? req.prompt : "" },
        ];
        const sink: TurnSink = {
          async emit(ev: TurnEvent): Promise<void> {
            const envelope = ev as unknown as SseEnvelope;
            // SSE frame for the wire (encodeEvent), then persist (best effort).
            void encodeEvent(envelope);
            await ctx.emit(envelope);
            if (store) {
              try {
                store.addEvent(sessionId, {
                  type: ev.type,
                  payload: JSON.stringify(ev.data),
                  version: ev.version,
                });
              } catch {
                // persistence is best effort: never fail the stream for it
              }
            }
          },
        };
        const turnOpts: TurnOptions = {
          sessionId,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(state ? { recorder: { record: (rec) => state!.recordToolCall(rec) } } : {}),
        };
        await new TurnEngine(sink).run(
          client,
          typeof req.model === "string" ? req.model : modelId,
          messages,
          tools,
          turnOpts,
        );
      },
    };

    const deps: HttpDeps = {
      capabilities: {
        contractVersion: "v1",
        models: [modelId],
        tools: ["bash"],
        features: ["sse"],
      },
      model,
      ...(store ? { store } : {}),
      ...(orchestrator ? { orchestrator } : {}),
    };

    const server = createHttpServer(deps);
    await listen(server, host, port);
    const addr = server.address() as AddressInfo;

    // Graceful shutdown: HTTP → pool → store → unmount → state, then exit.
    const shutdown = async (): Promise<void> => {
      await closeServer(server).catch(() => {});
      await pool?.close().catch(() => {});
      store?.close();
      await Promise.race([unmountSys(fuse), new Promise((r) => setTimeout(r, 1500))]);
      await state?.close().catch(() => {});
    };

    const onSignal = (code: number) => (): void => {
      void shutdown().then(
        () => process.exit(code),
        () => process.exit(code),
      );
    };
    process.once("SIGINT", onSignal(130));
    process.once("SIGTERM", onSignal(143));

    return {
      server,
      url: `http://${host}:${addr.port}`,
      close: shutdown,
    };
  }

  // Injected-deps path (tests): thin adapter, no extra boundaries.
  const server = createHttpServer(opts.deps);
  await listen(server, host, port);
  const addr = server.address() as AddressInfo;
  return {
    server,
    url: `http://${host}:${addr.port}`,
    close: () => closeServer(server),
  };
}

function listen(
  server: ReturnType<typeof createServer>,
  host: string,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
