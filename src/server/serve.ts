/**
 * Composition root: builds the v1 HTTP/SSE adapter from the real boundaries
 * (session store, worker pool, orchestrator, turn engine, FUSE mount) and
 * starts it.
 *
 * When `opts.deps` is supplied (tests), those boundaries are used verbatim —
 * no runtime is created. Otherwise `createDaemon` composes the daemon from
 * options → config file → zod defaults. The assembly lives in `./daemon/`
 * (composed through its barrel): `runtime.ts` (the best-effort boundaries),
 * `bash-wiring.ts` (the bash tool's seams), `turn-runner.ts` (the
 * orchestrator's turn entry point), `openai.ts` (the provider transport),
 * and `skills-cli.ts`.
 */
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { createHttpServer, type HttpDeps } from "./http/index.ts";
import { MESSAGE_TYPES } from "./messages.ts";
import { SessionOrchestrator } from "./orchestrator.ts";
import { COMPACTION_COMMANDS, SHAKE_COMMAND } from "./commands.ts";
import { tools } from "../register.ts";
import { abortBash } from "../toolkit/index.ts";
import {
  setToolOutputBudgets,
  TOOL_OUTPUT_LIMIT_CHARS,
  TOOL_OUTPUT_GRACE_CHARS,
} from "../toolkit/index.ts";
import { logger } from "../log.ts";
import { resolveConfig, type YogConfig, type PartialYogConfig } from "../config.ts";
import { createCompactionRunner, type CompactionBoundary } from "./compaction.ts";
import { createShakeRunner, type ShakeOutcome } from "./shake.ts";
import {
  createRuntime,
  makeExecuteTurn,
  openaiClient,
  type UsageBySession,
  unwireBashTool,
  wireBashTool,
} from "./daemon/index.ts";

/** Options accepted by {@link createDaemon}. */
export interface DaemonOptions {
  port?: number;
  host?: string;
  /**
   * Configuration injection: a partial config that wins over the config file
   * (tests, programmatic callers). Values here are merged over the resolved
   * file/defaults before any boundary is built.
   */
  config?: PartialYogConfig;
  /** Config file path override (default: /var/lib/yog/config.json). */
  configPath?: string;
  /** Injected boundaries (store, orchestrator, model provider, ...). */
  deps?: HttpDeps;
}

/** Handle to a running (or stubbed) daemon. */
export interface Daemon {
  server: ReturnType<typeof createServer>;
  url: string;
  close(): Promise<void>;
}

/** The 429 retry policy (engine rounds + compaction) from config. */
function rateLimitPolicy(config: YogConfig): {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
} {
  return {
    maxAttempts: config.rateLimitMaxAttempts,
    baseDelayMs: config.rateLimitBaseDelayMs,
    maxDelayMs: config.rateLimitMaxDelayMs,
    backoffFactor: config.rateLimitBackoffFactor,
  };
}

/**
 * Composition root: builds the v1 HTTP/SSE adapter from the real boundaries
 * and starts it (see the module docblock).
 */
export async function createDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const config: YogConfig = await resolveConfig({
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;
  // Tool-output budgets come from config: the toolkit's truncation fallback
  // and the bash tool both read these live values (defaults until wired).
  setToolOutputBudgets(
    config.toolOutputLimit ?? TOOL_OUTPUT_LIMIT_CHARS,
    config.toolOutputGrace ?? TOOL_OUTPUT_GRACE_CHARS,
  );

  if (opts.deps !== undefined) {
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

  const runtime = await createRuntime(config);
  const daemon = await composeDaemon(config, runtime, host, port);
  return daemon;
}

/** Assemble + start the self-hosted daemon over the built runtime. */
async function composeDaemon(
  config: YogConfig,
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  host: string,
  port: number,
): Promise<Daemon> {
  // --- the bash tool's seams: executor (+ persistent shell snapshots),
  // abort kill switch, and the skill-PATH provider ---
  wireBashTool(config, runtime);

  // --- event bus: executeTurn publishes envelopes, the HTTP adapter
  // subscribes per session and frames them as SSE ---
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  // Per-session usage as of the last known point, for flushing totals at a
  // terminal cut (abort/error) even when no turn.finished is emitted.
  const usageBySession: UsageBySession = new Map();
  const modelId = config.model;

  // --- orchestrator drives every turn through executeTurn (cross-session
  // parallelism, per-session FIFO, abort fan-out) ---
  const executeTurn = makeExecuteTurn({ config, modelId, bus, ...runtime }, usageBySession);
  const orchestrator = new SessionOrchestrator({
    store: runtime.store,
    pool: runtime.pool,
    executeTurn,
  });

  const compaction = buildCompaction(config, runtime, modelId);
  const shake = buildShake(runtime);

  const deps: HttpDeps = {
    capabilities: {
      contractVersion: "v1",
      models: [modelId],
      tools: ["bash"],
      features: [
        "messages",
        "stream",
        "transcript",
        "abort",
        "rate-limit-retry",
        ...(runtime.skills !== undefined ? ["skills"] : []),
      ],
      messageTypes: [...MESSAGE_TYPES],
      commands: [
        ...(compaction !== undefined ? COMPACTION_COMMANDS : []),
        ...(shake !== undefined ? [SHAKE_COMMAND] : []),
      ],
    },
    contextWindowFor: (model: string) => runtime.modelInfo?.getContextWindow(model),
    ...(runtime.store !== undefined ? { store: runtime.store } : {}),
    orchestrator,
    ...(compaction !== undefined ? { compaction } : {}),
    bus,
    ...(shake !== undefined ? { shake } : {}),
    ...(runtime.skills !== undefined ? { skills: runtime.skills } : {}),
    onUsageFor: (sessionId: string) => usageBySession.get(sessionId),
    onAbortKillTool: (sessionId: string) => abortBash(sessionId),
  };

  const server = createHttpServer(deps);
  await listen(server, host, port);
  const addr = server.address() as AddressInfo;

  // Graceful shutdown: HTTP → bash-tool seams → runtime (pool, store,
  // unmount, state), then exit.
  const shutdown = async (): Promise<void> => {
    await closeServer(server).catch(() => {});
    unwireBashTool();
    await runtime.close();
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

/**
 * Compaction/handoff runner: throwaway summary turn (no tools, no session
 * history) that resets the transcript to the produced artifact. Uses a
 * second copy of the session model, or config.compactionModel.
 */
function buildCompaction(
  config: YogConfig,
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  modelId: string,
): CompactionBoundary | undefined {
  if (runtime.store === undefined) return undefined;
  try {
    return createCompactionRunner({
      client: openaiClient(config),
      store: runtime.store,
      model: modelId,
      ...(config.compactionModel !== undefined ? { compactionModel: config.compactionModel } : {}),
      ...(runtime.modelInfo !== undefined ? { modelInfo: runtime.modelInfo } : {}),
      rateLimit: rateLimitPolicy(config),
    });
  } catch (err) {
    logger.warn(`[yog] warning: compaction unavailable (${(err as Error).message}); continuing`);
    return undefined;
  }
}

/**
 * /shake runner: mechanical transcript rewrite (truncate tool args and
 * results via each tool's truncators). No model call.
 */
function buildShake(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
): ((sessionId: string) => Promise<ShakeOutcome>) | undefined {
  if (runtime.store === undefined) return undefined;
  try {
    return createShakeRunner({ store: runtime.store, registry: tools });
  } catch (err) {
    logger.warn(`[yog] warning: shake unavailable (${(err as Error).message}); continuing`);
    return undefined;
  }
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
    // Long-lived session streams would otherwise hold `close` open;
    // destroying them lets graceful shutdown proceed.
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
