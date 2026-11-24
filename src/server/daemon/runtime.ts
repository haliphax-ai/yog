/**
 * The daemon's real runtime boundaries.
 *
 * `createRuntime` is the best-effort assembly of everything the self-hosted
 * daemon needs: the session store, the agent state db, the worker pool, the
 * FUSE mount, and the skills registry. Every boundary degrades
 * independently — a failure is logged and the daemon continues without it
 * (no store = no audit trail; no mount = the VFS stays virtual). The
 * agent-user split (descriptor ownership + the worker spawn drop) is
 * registered here, inside openPool: the pool spawns its workers in its
 * constructor, which is the hard deadline for that registration. Nothing
 * here wires the toolkit's global seams: that is bash-wiring.ts's job,
 * once the runtime exists.
 */
import { join } from "node:path";
import type Fuse from "fuse-native";
import { Scheduler } from "../../schedule/index.ts";
import { unmountSys } from "../../mount.ts";
import {
  AgentFSState,
  DEFAULT_AGENT_ID,
  harnessStateRoot,
  pruneStaleHarnessState,
  SCRATCH_MAX_AGE_MS,
  sweepRunScratchDirs,
} from "../../state/index.ts";
import { mountSys } from "../../mount.ts";
import { descriptors } from "../../register.ts";
import { SkillManager } from "../../skills/index.ts";
import { logger } from "../../log.ts";
import { mkdir, readdir } from "../../host.ts";
import { SessionStore } from "../store/index.ts";
import { WorkerPool } from "../workpool.ts";
import { onAgentSpawn } from "../../worker/index.ts";
import { setDescriptorOwnership } from "../../vfs/index.ts";
import { ModelInfoCache } from "../modelInfo.ts";
import type { YogConfig } from "../../config.ts";
import { registerSkillsCliCommand } from "./skills-cli.ts";

/** The assembled runtime boundaries (any of them may be missing). */
export interface Runtime {
  /** Session persistence (`sessions.db`). */
  readonly store: SessionStore | undefined;
  /** Agent state db (tool-call audit, shell snapshots, loaded skills). */
  readonly state: AgentFSState | undefined;
  /** Bash worker pool. */
  readonly pool: WorkerPool | undefined;
  /** The FUSE mount (undefined when FUSE is unavailable). */
  readonly fuse: Fuse | undefined;
  /** The skills registry (undefined when discovery failed). */
  readonly skills: SkillManager | undefined;
  /** The models.dev context-window cache. */
  readonly modelInfo: ModelInfoCache | undefined;
  /** The agent-CLI shim directory (`<mountPoint>/bin`). */
  readonly cliBinDir: string;
  /**
   * Time seam for daemon-internal periodic work (the scratch-dir reaper
   * today): injectable so tests drive a fake clock. The runtime cancels
   * its own schedules on close.
   */
  readonly scheduler: Scheduler;
  /** Tear the runtime down (idempotent, best effort per boundary). */
  close(): Promise<void>;
}

/** mkdir -p, logged not thrown (a failed state dir degrades the daemon). */
async function ensureDir(path: string, label: string): Promise<boolean> {
  try {
    await mkdir(path, { recursive: true });
    return true;
  } catch (err) {
    logger.warn(`[yog] warning: ${label} unavailable (${(err as Error).message}); continuing`);
    return false;
  }
}

/** Best-effort run of `step`; a failure logs and yields `fallback`. */
async function bestEffort<T>(step: () => Promise<T>, label: string, fallback: T): Promise<T> {
  try {
    return await step();
  } catch (err) {
    logger.warn(`[yog] warning: ${label} (${(err as Error).message}); continuing`);
    return fallback;
  }
}

/** Log a non-empty prune outcome (the sweeps are silent when they cut nothing). */
function logPruned(pruned: string[], label: string): void {
  if (pruned.length > 0) {
    logger.info(`[yog] pruned ${pruned.length} stale ${label}: ${pruned.join(", ")}`);
  }
}

/**
 * One periodic pass of the scratch-dir reaper: prune every session's
 * `runs/` entries older than {@link SCRATCH_MAX_AGE_MS}. Delete-at-settle
 * keeps steady state at one dir per in-flight call; this pass only ever
 * sees leaks (a settle-delete that failed, a worker killed between calls).
 * Mirrors the sweeps above: startup-only work stays startup-only; the
 * timer work is idempotent and best effort per session.
 */
async function reapRunScratchDirs(config: YogConfig): Promise<void> {
  let sessions: string[] = [];
  try {
    sessions = await readdir(harnessStateRoot(config.stateRoot));
  } catch {
    return; // no harness root (fresh volume) — nothing to reap
  }
  for (const sessionId of sessions) {
    const pruned = await bestEffort(
      () => sweepRunScratchDirs(sessionId, config.stateRoot),
      "runs scratch reaper failed",
      [] as string[],
    );
    logPruned(pruned, "scratch run dir(s)");
  }
}

/** Open the session store (and the state dirs it lives under). */
async function openStore(config: YogConfig): Promise<SessionStore | undefined> {
  const dirsOk =
    (await ensureDir(config.stateRoot, "state root")) &&
    (await ensureDir(harnessStateRoot(config.stateRoot), "harness state root"));
  if (!dirsOk) return undefined;
  return bestEffort(
    () => SessionStore.open(join(config.stateRoot, "sessions.db")),
    "session store unavailable",
    undefined,
  );
}

/** Startup sweep: harness directories older than the retention window. */
async function sweepHarnessDirs(config: YogConfig): Promise<void> {
  const pruned = await bestEffort(
    () => pruneStaleHarnessState(config.stateRoot),
    "harness state prune failed",
    [] as string[],
  );
  logPruned(pruned, "harness state dir(s)");
}

/**
 * Startup wipe of every per-call scratch dir (`harness/<sid>/runs/*`).
 * `maxAgeMs: 0` removes each dir unconditionally: the daemon's bash
 * workers die with the process, so nothing can be in flight across a
 * restart and no scratch dir is ever resumed. Sessions are discovered
 * from the existing per-session dirs; a session with no `runs/` root
 * simply sweeps nothing.
 */
async function wipeRunScratchDirs(config: YogConfig): Promise<void> {
  let sessions: string[] = [];
  try {
    sessions = await readdir(harnessStateRoot(config.stateRoot));
  } catch {
    return; // no harness root (fresh volume) — nothing to wipe
  }
  for (const sessionId of sessions) {
    const pruned = await bestEffort(
      () => sweepRunScratchDirs(sessionId, config.stateRoot, { maxAgeMs: 0 }),
      "runs scratch wipe failed",
      [] as string[],
    );
    logPruned(pruned, "scratch run dir(s)");
  }
}

/** Open the agent state db, then sweep its stale shell snapshots. */
async function openAgentState(config: YogConfig): Promise<AgentFSState | undefined> {
  const state = await bestEffort(
    () =>
      AgentFSState.open({
        agentId: DEFAULT_AGENT_ID,
        ...(config.statePath !== undefined ? { path: config.statePath } : {}),
      }),
    "agent state unavailable",
    undefined,
  );
  if (state === undefined) return undefined;
  await bestEffort(
    () => state.pruneStaleShellSnapshots(),
    "shell snapshot prune failed",
    undefined,
  );
  return state;
}

/** Open the models.dev cache (context-window lookups, best effort). */
async function openModelInfo(config: YogConfig): Promise<ModelInfoCache | undefined> {
  return bestEffort(
    async () => {
      const cache = new ModelInfoCache(
        join(config.stateRoot, "model-info.json"),
        config.modelsDevPath,
      );
      await cache.load();
      return cache;
    },
    "model info unavailable",
    undefined,
  );
}

/**
 * Register the agent-user split from the runtime configuration: descriptor
 * ownership (the uid/gid served descriptors default to) and the worker
 * spawn drop (the bash workers uid/gid and HOME).
 *
 * This must land before the worker pool is constructed: the pool spawns
 * its worker processes in the constructor, and options registered after
 * construction silently produced workers running as the daemon user with
 * the daemon HOME (bash children then inherited /home/yog). The call
 * therefore lives in openPool, immediately before the constructor, so the
 * deadline is structural rather than call-site ordering: the createDaemon
 * decomposition (PR #78) had moved the registration into composeDaemon,
 * which runs after createRuntime had already spawned every worker without
 * the drop.
 */
function registerAgentUserSplit(config: YogConfig): void {
  setDescriptorOwnership(
    config.agentUid ?? process.getuid?.() ?? 0,
    config.agentGid ?? process.getgid?.() ?? 0,
  );
  onAgentSpawn({
    ...(config.agentUid !== undefined ? { uid: config.agentUid } : {}),
    ...(config.agentGid !== undefined ? { gid: config.agentGid } : {}),
    ...(config.agentHome !== undefined ? { home: config.agentHome } : {}),
  });
}

/**
 * Build the worker pool. The agent-user split is registered here (not by
 * the caller) immediately before construction: see
 * registerAgentUserSplit for why the call lives inside openPool.
 */
async function openPool(config: YogConfig): Promise<WorkerPool | undefined> {
  registerAgentUserSplit(config);
  return bestEffort(
    async () => new WorkerPool(config.workers !== undefined ? { size: config.workers } : undefined),
    "worker pool unavailable",
    undefined,
  );
}

/** Best-effort FUSE mount over the descriptor registry. */
function openMount(config: YogConfig): Promise<Fuse | undefined> {
  return bestEffort(
    () =>
      mountSys(
        descriptors.buildOps(),
        config.mountPoint,
        config.allowOther ? { allowOther: true } : {},
      ),
    "FUSE mount failed",
    undefined as Fuse | undefined,
  );
}

/**
 * Discover the skills registry. A discovery failure must not take the
 * daemon down; a working manager also registers its agent-CLI command.
 */
async function openSkills(
  config: YogConfig,
  state: AgentFSState | undefined,
): Promise<SkillManager | undefined> {
  const skills = await bestEffort(
    async () => {
      const manager = new SkillManager({
        ...(state !== undefined ? { state } : {}),
        discover: { cwd: config.agentHome ?? process.cwd() },
      });
      await manager.discover();
      return manager;
    },
    "skills unavailable",
    undefined,
  );
  if (skills !== undefined) registerSkillsCliCommand(skills);
  return skills;
}

/**
 * Assemble the daemon's runtime boundaries. Order matters where noted: the
 * filesystem sweep + scratch-dir wipe run before any worker can create
 * fresh state, and the skills CLI command registers only when discovery
 * succeeded.
 */
export async function createRuntime(
  config: YogConfig,
  opts: { scheduler?: Scheduler } = {},
): Promise<Runtime> {
  const store = await openStore(config);
  await sweepHarnessDirs(config);
  await wipeRunScratchDirs(config);
  const modelInfo = await openModelInfo(config);
  const state = await openAgentState(config);
  const pool = await openPool(config);
  const fuse = await openMount(config);
  const skills = await openSkills(config, state);
  // Periodic scratch-dir reaper (leaks only; delete-at-settle covers the
  // steady state). Unref'd via the scheduler's timer impl, so a pending
  // pass never holds the daemon open.
  const scheduler = opts.scheduler ?? new Scheduler();
  const reaper = scheduler.after(SCRATCH_MAX_AGE_MS, () => {
    void reapRunScratchDirs(config).catch(() => {});
  });
  return {
    scheduler,
    store,
    state,
    pool,
    fuse,
    skills,
    modelInfo,
    cliBinDir: join(config.mountPoint, "bin"),
    close: async (): Promise<void> => {
      scheduler.cancel(reaper);
      await pool?.close().catch(() => {});
      store?.close();
      await Promise.race([unmountSys(fuse), new Promise((r) => setTimeout(r, 1500))]);
      await state?.close().catch(() => {});
    },
  };
}
