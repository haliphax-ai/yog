import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions/completions.mjs";
import type Fuse from "fuse-native";
import { createHttpServer, type HttpDeps } from "./http.ts";
import { type SseEnvelope } from "./sse.ts";
import { SessionStore } from "./store/sessions.ts";
import { WorkerPool } from "./workpool.ts";
import { SessionOrchestrator } from "./orchestrator.ts";
import { AgentFSState, DEFAULT_AGENT_ID } from "../state/index.ts";
import { mountSys, unmountSys } from "../mount.ts";
import { TurnEngine, type TurnOptions } from "../turn.ts";
import type { TurnSink, TurnEvent, TurnUsage } from "../turn/sink.ts";
import { tools, descriptors } from "../register.ts";
import {
  abortBash,
  setBashAbort,
  setBashExecutor,
  setShellStateProvider,
} from "../toolkit/index.ts";
import { onAgentSpawn } from "../worker/index.ts";
import { mkdir } from "../host.ts";
import { logger } from "../log.ts";
import { resolveConfig, type YogConfig, type PartialYogConfig } from "../config.ts";
import { ModelInfoCache } from "./modelInfo.ts";
import { createCompactionRunner, type CompactionBoundary } from "./compaction.ts";
import { createShakeRunner, type ShakeOutcome } from "./shake.ts";
import { setDescriptorOwnership } from "../vfs/index.ts";

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

/** OpenAI client built from the injected configuration (proxy/key overrides;
 * SDK defaults when unset). */
function openaiClient(config: YogConfig): OpenAI {
  return new OpenAI({
    ...(config.providerBaseUrl ? { baseURL: config.providerBaseUrl } : {}),
    ...(config.providerApiKey ? { apiKey: config.providerApiKey } : {}),
  });
}

/**
 * Composition root: builds the v1 HTTP/SSE adapter from the real boundaries
 * (session store, worker pool, orchestrator, turn engine, FUSE mount) and
 * starts it.
 *
 * When `opts.deps` is supplied (tests), those boundaries are used verbatim —
 * no store, pool, or mount is created. Otherwise `createDaemon` composes the
 * daemon itself from options → config file → zod defaults.
 */
export async function createDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const config: YogConfig = await resolveConfig({
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  });
  const host = opts.host ?? config.host;
  const port = opts.port ?? config.port;

  if (!opts.deps) {
    // --- persistence (best effort: continue without an audit trail) ---
    let store: SessionStore | undefined;
    try {
      await mkdir(config.stateRoot, { recursive: true });
      store = await SessionStore.open(join(config.stateRoot, "sessions.db"));
    } catch (err) {
      logger.warn(
        `[yog] warning: session store unavailable (${(err as Error).message}); continuing`,
      );
    }

    // --- model info cache (best effort: continue without it) ---
    let modelInfo: ModelInfoCache | undefined;
    try {
      const cachePath = join(config.stateRoot, "model-info.json");
      modelInfo = new ModelInfoCache(cachePath, config.modelsDevPath);
      await modelInfo.load();
    } catch (err) {
      logger.warn(`[yog] warning: model info unavailable (${(err as Error).message}); continuing`);
    }

    // --- agent state (best effort, mirrors the `run` path) ---
    // Descriptor ownership follows the agent split (config agentUid/Gid);
    // unset (local dev) keeps the current process ids.
    setDescriptorOwnership(
      config.agentUid ?? process.getuid?.() ?? 0,
      config.agentGid ?? process.getgid?.() ?? 0,
    );
    let state: AgentFSState | undefined;
    try {
      state = await AgentFSState.open({
        agentId: DEFAULT_AGENT_ID,
        ...(config.statePath !== undefined ? { path: config.statePath } : {}),
      });
    } catch (err) {
      logger.warn(`[yog] warning: agent state unavailable (${(err as Error).message}); continuing`);
    }

    // --- agent-user split: inject spawn opts BEFORE the pool exists ---
    // WorkerPool spawns its worker processes in the constructor, so uid/gid
    // drops only engage if the opts are already registered. Injecting after
    // construction silently produced workers running as the daemon user
    // with the daemon's HOME (bash children then inherited /home/yog).
    onAgentSpawn({
      ...(config.agentUid !== undefined ? { uid: config.agentUid } : {}),
      ...(config.agentGid !== undefined ? { gid: config.agentGid } : {}),
      ...(config.agentHome !== undefined ? { home: config.agentHome } : {}),
    });

    // --- worker pool (production caller for the bash tool) ---
    let pool: WorkerPool | undefined;
    try {
      pool = new WorkerPool(config.workers !== undefined ? { size: config.workers } : undefined);
    } catch (err) {
      logger.warn(`[yog] warning: worker pool unavailable (${(err as Error).message}); continuing`);
    }

    // --- wire the bash tool through the worker pool ---
    if (pool) {
      const p = pool;
      // Bash tool executor: the tool's `(script, opts)` maps onto the pool's
      // `run(scriptId, script, { stateDir, restore })`. The script id is the
      // abort key: a session's current script is the one an abort kills.
      setBashExecutor(async (script, opts) => {
        try {
          const resp = await p.run(opts?.scriptId ?? "daemon", script, {
            stateDir: opts?.stateDir ?? config.agentStateDir,
            ...(opts?.restore !== undefined ? { restore: opts.restore } : {}),
          });
          if (resp.ok) {
            return {
              ok: true,
              stdout: resp.stdout,
              stderr: resp.stderr,
              exitCode: resp.exitCode,
              ...(resp.state ? { state: resp.state } : {}),
            };
          }
          return { ok: false, stdout: "", stderr: "", exitCode: null, error: resp.error };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      });
      // Shell snapshots persist in agentfs so they survive daemon restarts.
      if (state) {
        const st = state;
        setShellStateProvider({
          async load() {
            try {
              return await st.loadShellSnapshot("daemon");
            } catch {
              return undefined;
            }
          },
          async save(s) {
            try {
              await st.saveShellSnapshot("daemon", s);
            } catch {
              // best effort: a home write failure must not fail the tool call
            }
          },
        });
      }
    }

    // --- best-effort FUSE mount (skip gracefully when unavailable) ---
    let fuse: Fuse | undefined;
    try {
      fuse = await mountSys(
        descriptors.buildOps(),
        config.mountPoint,
        config.allowOther ? { allowOther: true } : {},
      );
    } catch (err) {
      logger.warn(`[yog] warning: FUSE mount failed (${(err as Error).message}); continuing`);
    }

    // --- event bus: executeTurn publishes envelopes, the HTTP adapter
    // subscribes per session and frames them as SSE ---
    const bus = new EventEmitter();
    bus.setMaxListeners(0);
    // Per-session usage as of the last known point, for flushing totals at a
    // terminal cut (abort/error) even when no turn.finished is emitted.
    const usageBySession = new Map<string, TurnUsage | undefined>();
    const modelId = config.model;

    // --- turn abort plumbing: the abort endpoint kills the session's
    // in-flight bash script (script key = session id), which snapshots the
    // persistent shell state before the child dies ---
    setBashAbort(async (sessionId) => (pool ? pool.abortScript(sessionId) : false));

    /**
     * Turn entry point injected into the orchestrator. Builds the OpenAI
     * client + TurnEngine and routes its sink so every event is BOTH
     * persisted (best effort) and delivered to the HTTP layer for SSE.
     * The returned turnId (from turn.started) enables turn recovery.
     */
    const executeTurn = async (
      sessionId: string,
      req: Record<string, unknown>,
      ctx: { signal?: AbortSignal } = {},
    ): Promise<{ turnId: string | null }> => {
      const client = openaiClient(config);
      const prompt = typeof req.prompt === "string" ? req.prompt : "";
      const model = typeof req.model === "string" ? req.model : modelId;

      // Hydrate prior context from the canonical transcript (§4.4). On the
      // first turn the transcript is empty; a retry replays from the last
      // turn boundary. Naive full replay for now (context policy is §3).
      const prior = (await (store ? store.getTranscript(sessionId) : [])) as Array<
        Record<string, unknown>
      >;
      const messages: ChatCompletionMessageParam[] = [
        ...(prior as unknown as ChatCompletionMessageParam[]),
        { role: "user", content: prompt },
      ];
      const startLen = prior.length;

      // Turn ownership moves into executeTurn (§4.8): the orchestrator path
      // owns the turn lifecycle, and the row id stamps turn_id on the
      // persisted transcript rows. The store-less fallback in http.ts keeps
      // its own best-effort addTurn.
      let turnRowId: number | null = null;
      if (store) {
        try {
          const turnRow = await store.addTurn(sessionId, {
            role: "user",
            content: prompt,
            status: "running",
            model,
          });
          turnRowId =
            turnRow && typeof (turnRow as { id?: number }).id === "number"
              ? ((turnRow as { id?: number }).id as number)
              : null;
        } catch {
          // persistence is best effort
        }
      }

      // Nothing is persisted up front: the transcript only ever contains
      // complete turns (§4.4). The success path below persists
      // `messages.slice(startLen)` — which includes this turn's user prompt —
      // in one appendMessages call, so a failed turn persists nothing
      // (its event log is diagnostic and stays) and a successful turn leaves
      // no duplicated user row behind.
      let turnId: string | null = null;
      let liveUsage: TurnUsage | undefined;
      usageBySession.set(sessionId, undefined);
      const sink: TurnSink = {
        async emit(ev: TurnEvent): Promise<void> {
          const envelope = ev as unknown as SseEnvelope;
          if (ev.type === "turn.started") {
            turnId = (ev.data as { turnId?: string }).turnId ?? turnId;
          }
          if (ev.type === "turn.finished") {
            const u = (ev.data as { usage?: TurnUsage }).usage;
            if (u !== undefined && u !== null) liveUsage = u;
          }
          // Persist first (best effort): never fail the stream for it.
          if (store) {
            try {
              await store.addEvent(sessionId, {
                type: ev.type,
                payload: JSON.stringify(ev.data),
                version: ev.version,
              });
            } catch {
              // persistence is best effort
            }
          }
          logger.child({ sessionId }).debug({ event: ev }, "turn event");
          bus.emit(`session:${sessionId}`, envelope);
        },
      };
      // Tool-call ids the engine stubbed during the unwind (heal path). Only
      // a turn that healed carries persistable content on failure.
      const healedIds: string[] = [];
      const turnOpts: TurnOptions = {
        sessionId,
        ...(state ? { recorder: { record: (rec) => state!.recordToolCall(rec) } } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        // Abort sentinel probed at every await point inside the engine: an
        // abort arriving mid-tool-call or mid-stream still unwinds the turn.
        isAborted: () => ctx.signal?.aborted === true,
        abortReason: "turn aborted by operator",
        onUsage: (u) => {
          liveUsage = u;
          usageBySession.set(sessionId, u);
        },
        onHeal: (ids) => void healedIds.push(...ids),
        maxRounds: config.maxRoundsPerTurn,
        ...(modelInfo ? { contextWindow: modelInfo.getContextWindow(model) ?? undefined } : {}),
      };
      try {
        await new TurnEngine(sink).run(client, model, messages, tools, turnOpts);
        // On success, persist everything this turn produced (§4.4): the
        // transcript only ever contains complete turns — the batch starts at
        // this turn's user prompt (`startLen` was captured before it, so the
        // slice includes it). A failed turn persists nothing: the catch is a
        // no-op for the transcript and a retry replays from the last turn
        // boundary.
        if (store && messages.length > startLen) {
          try {
            await store.appendMessages(sessionId, messages.slice(startLen), turnRowId);
          } catch {
            // persistence is best effort
          }
        }
        // Settle the row as finished — the bookkeeping record of a complete
        // turn, never a gate on the stream's success.
        await store?.finishTurn?.(sessionId, turnRowId, "finished", liveUsage).catch(() => {});
      } catch (err) {
        // An operator abort persists that batch so the user prompt and
        // completed tool calls survive for resume (the turn row still
        // settles as aborted); other failures stay transient. The signal is
        // the authoritative abort marker: mid-model-stream the engine
        // rethrows the provider's raw abort error, not an `AbortError`.
        const isOperatorAbort =
          ctx.signal?.aborted === true || (err instanceof Error && err.name === "AbortError");
        if ((isOperatorAbort || healedIds.length > 0) && store && messages.length > startLen) {
          try {
            await store.appendMessages(sessionId, messages.slice(startLen), turnRowId);
          } catch {
            // persistence is best effort
          }
        }
        await store?.finishTurn?.(sessionId, turnRowId, "aborted", liveUsage).catch(() => {});
      }
      return { turnId };
    };

    // --- orchestrator drives every turn through executeTurn (cross-session
    // parallelism, per-session FIFO, abort fan-out) ---
    const orchestrator = new SessionOrchestrator({ store, pool, executeTurn });

    // --- compaction/handoff runner: throwaway summary turn (no tools, no
    // session history) that resets the transcript to the produced artifact.
    // Uses a second copy of the session model, or config.compactionModel. ---
    let compaction: CompactionBoundary | undefined;
    if (store) {
      try {
        compaction = createCompactionRunner({
          client: openaiClient(config),
          store,
          model: modelId,
          ...(config.compactionModel !== undefined
            ? { compactionModel: config.compactionModel }
            : {}),
          ...(modelInfo ? { modelInfo } : {}),
        });
      } catch (err) {
        logger.warn(
          `[yog] warning: compaction unavailable (${(err as Error).message}); continuing`,
        );
      }
    }

    // --- /shake runner: mechanical transcript rewrite (truncate tool args
    // and results via each tool's truncators). No model call. ---
    let shake: ((sessionId: string) => Promise<ShakeOutcome>) | undefined;
    if (store) {
      try {
        shake = createShakeRunner({ store, registry: tools });
      } catch (err) {
        logger.warn(`[yog] warning: shake unavailable (${(err as Error).message}); continuing`);
      }
    }

    const deps: HttpDeps = {
      capabilities: {
        contractVersion: "v1",
        models: [modelId],
        tools: ["bash"],
        features: ["sse", "transcript", "abort", "compact", "handoff", "shake"],
      },
      contextWindowFor: (model: string) => modelInfo?.getContextWindow(model),
      ...(store ? { store } : {}),
      ...(orchestrator ? { orchestrator } : {}),
      ...(compaction ? { compaction } : {}),
      bus,
      ...(shake ? { shake } : {}),
      // Turn-abort kill chain (POST /v1/sessions/{id}/abort): kill the
      // session's running bash script, then let the orchestrator unwind.
      onUsageFor: (sessionId: string) => usageBySession.get(sessionId),
      onAbortKillTool: (sessionId: string) => abortBash(sessionId),
    };

    const server = createHttpServer(deps);
    await listen(server, host, port);
    const addr = server.address() as AddressInfo;

    // Graceful shutdown: HTTP → pool → store → unmount → state, then exit.
    const shutdown = async (): Promise<void> => {
      await closeServer(server).catch(() => {});
      await pool?.close().catch(() => {});
      setBashExecutor(undefined);
      setBashAbort(undefined);
      setShellStateProvider(undefined);
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
