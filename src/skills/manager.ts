/**
 * SkillManager: discovery, load/unload, state, and context.
 *
 * One manager instance serves the daemon. It tracks which skills are
 * currently loaded (in memory, optionally persisted through an
 * `AgentFSState`), the `scripts/` directories added to PATH, and the
 * concatenated instructions for the turn engine.
 *
 * Loaded state is *per-session*: the bash tool keys everything by its
 * `sessionId`, so the manager keeps a `sessionId → loaded skills` view
 * (the CLI/HTTP registry uses the `"daemon"` default session). Child
 * skills load independently of their parents; unloading a trunk skill
 * also unloads its children.
 *
 * Concurrency: load/unload are mutex-protected (serialized) so a session
 * cannot race two loads into an inconsistent PATH.
 */
import { logger } from "../log.ts";
import { readSkillFile } from "./parser.ts";
import { discoverSkills, type DiscoverOptions } from "./discover.ts";
import { isValidFullName, skillNameError, splitFullName } from "./validator.ts";
import type {
  LoadedSkillState,
  Skill,
  SkillCommandResult,
  SkillListEntry,
  SkillStatusEntry,
} from "./types.ts";

/** Persisted state contract (subset of `AgentFSState` the manager needs). */
export interface SkillStateStore {
  saveSkills(sessionId: string, skills: readonly string[]): Promise<void>;
  loadSkills(sessionId: string): Promise<string[]>;
}

/** Options for {@link SkillManager}. */
export interface SkillManagerOptions {
  /** Default session (the `"daemon"` registry); per-session ops pass one. */
  readonly sessionId?: string;
  /** Discovery source override (tests). */
  readonly discover?: DiscoverOptions;
  /** Persisted state backend (optional). */
  readonly state?: SkillStateStore;
  /** Loaded-skill state change listener (turn engine wiring). */
  readonly onChange?: (sessionId: string, loaded: readonly LoadedSkillState[]) => void;
}

/** In-memory loaded state for one skill. */
interface LoadedEntry {
  readonly skill: Skill;
  readonly loadedAt: number;
}

export class SkillManager {
  readonly sessionId: string;
  readonly #discoverOpts: DiscoverOptions | undefined;
  readonly #state: SkillStateStore | undefined;
  readonly #onChange:
    | ((sessionId: string, loaded: readonly LoadedSkillState[]) => void)
    | undefined;
  /** Loaded skills per session, keyed by full name. */
  readonly #loaded = new Map<string, Map<string, LoadedEntry>>();
  /** Cached discovery (available skills), refreshed on demand. */
  #available: Skill[] | undefined;
  /** Serializes load/unload so PATH mutations cannot interleave. */
  #mutex: Promise<void> = Promise.resolve();

  constructor(opts: SkillManagerOptions = {}) {
    this.sessionId = opts.sessionId ?? "daemon";
    this.#discoverOpts = opts.discover;
    this.#state = opts.state;
    this.#onChange = opts.onChange;
  }

  /** Run `fn` under the manager's mutex (serialized load/unload). */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#mutex.then(fn, fn);
    // Keep the chain alive even when fn rejects.
    this.#mutex = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** The loaded map for `sessionId` (created on first use). */
  #sessionLoaded(sessionId: string): Map<string, LoadedEntry> {
    let map = this.#loaded.get(sessionId);
    if (!map) {
      map = new Map();
      this.#loaded.set(sessionId, map);
    }
    return map;
  }

  /** Drop the cached discovery (sources may have changed on disk). */
  invalidate(): void {
    this.#available = undefined;
  }

  /** Discover available skills (cached). */
  async discover(): Promise<Skill[]> {
    if (this.#available) return this.#available;
    const metas = await discoverSkills(this.#discoverOpts);
    const out: Skill[] = [];
    for (const meta of metas) {
      try {
        out.push({ ...meta, ...(await readSkillFile(meta.skillFile)) });
      } catch (err) {
        logger.warn(
          `[skills] skipping ${meta.fullName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.#available = out;
    return out;
  }

  /** Currently loaded skills for a session (in load order). */
  getLoaded(sessionId: string = this.sessionId): Skill[] {
    const map = this.#loaded.get(sessionId);
    return map ? [...map.values()].map((e) => e.skill) : [];
  }

  /** Loaded-state records for a session (for persistence / status). */
  getLoadedStates(sessionId: string = this.sessionId): LoadedSkillState[] {
    const map = this.#loaded.get(sessionId);
    return map
      ? [...map.values()].map((e) => ({
          name: e.skill.fullName,
          loadedAt: e.loadedAt,
          source: e.skill.source,
          path: e.skill.path,
          scriptsDir: e.skill.scriptsDir,
        }))
      : [];
  }

  /**
   * Directories added to PATH by a session's loaded skills (deduplicated,
   * in load order). Backs the bash tool's per-session `extraPath`.
   */
  getScriptPathsFor(sessionId: string): string[] {
    const map = this.#loaded.get(sessionId);
    const out: string[] = [];
    if (!map) return out;
    for (const entry of map.values()) {
      const dir = entry.skill.scriptsDir;
      if (dir !== undefined && !out.includes(dir)) out.push(dir);
    }
    return out;
  }

  /** Directories added to PATH by the default session's loaded skills. */
  getScriptPaths(): string[] {
    return this.getScriptPathsFor(this.sessionId);
  }

  /** Concatenated `SKILL.md` bodies of a session's loaded skills. */
  async getInstructions(sessionId: string = this.sessionId): Promise<string> {
    const map = this.#loaded.get(sessionId);
    const sections: string[] = [];
    if (map) {
      for (const entry of map.values()) {
        const s = entry.skill;
        const desc = s.frontmatter.description ? `\n\n> ${s.frontmatter.description}` : "";
        sections.push(`## ${s.fullName}${desc}\n\n${s.body}`);
      }
    }
    return sections.join("\n\n---\n\n");
  }

  /** `yog skills list` rows (available + loaded state). */
  async list(sessionId: string = this.sessionId): Promise<SkillListEntry[]> {
    const available = await this.discover();
    const map = this.#loaded.get(sessionId);
    const parentLoaded = (s: Skill): boolean =>
      s.isChild === false || (s.parentName !== undefined && map?.has(s.parentName) === true);
    return available
      .filter((s) => parentLoaded(s))
      .map((s) => ({
        name: s.fullName,
        source: s.source,
        loaded: map?.has(s.fullName) === true,
        description: s.frontmatter.description || undefined,
        path: s.path,
        isChild: s.isChild,
        hasScripts: s.scriptsDir !== undefined,
      }));
  }

  /** `yog skills status` rows (loaded skills for a session). */
  status(sessionId: string = this.sessionId): SkillStatusEntry[] {
    const map = this.#loaded.get(sessionId);
    return map
      ? [...map.values()].map((e) => ({
          name: e.skill.fullName,
          source: e.skill.source,
          path: e.skill.path,
          loadedAt: e.loadedAt,
          scriptsDir: e.skill.scriptsDir,
        }))
      : [];
  }

  /** Load a skill by name (or `trunk:branch`); no-op when already loaded. */
  async load(name: string, sessionId: string = this.sessionId): Promise<SkillCommandResult> {
    return this.#serialize(async () => this.#loadImpl(name, sessionId));
  }

  async #loadImpl(name: string, sessionId: string): Promise<SkillCommandResult> {
    const ref = name.trim();
    const nameErr = ref === "" ? "skill name is required" : skillNameError(splitFullName(ref)[0]!);
    if (nameErr) {
      return { ok: false, name: ref, status: "error", message: nameErr };
    }
    const map = this.#sessionLoaded(sessionId);
    if (map.has(ref)) {
      const existing = map.get(ref)!;
      return {
        ok: true,
        name: ref,
        status: "noop",
        message: `skill "${ref}" is already loaded`,
        ...(existing.skill.scriptsDir !== undefined
          ? { scriptsDir: existing.skill.scriptsDir }
          : {}),
      };
    }
    const available = await this.discover();
    const skill = available.find((s) => s.fullName === ref);
    if (!skill) {
      return {
        ok: false,
        name: ref,
        status: "not_found",
        message: `skill "${ref}" not found (use \`yog skills list\` to see available skills)`,
      };
    }
    // A child skill requires its parent to be loaded first.
    if (skill.isChild && skill.parentName !== undefined && !map.has(skill.parentName)) {
      return {
        ok: false,
        name: ref,
        status: "error",
        message: `skill "${ref}" requires its parent "${skill.parentName}" to be loaded first`,
      };
    }
    // Validate loudly: a bad name must never silently load.
    const [trunk] = splitFullName(ref);
    if (!isValidFullName(ref) || (trunk !== undefined && skillNameError(trunk) !== undefined)) {
      return { ok: false, name: ref, status: "error", message: `invalid skill name "${ref}"` };
    }
    map.set(ref, { skill, loadedAt: Date.now() });
    await this.#persist(sessionId);
    this.#onChange?.(sessionId, this.getLoadedStates(sessionId));
    logger.info(`[skills] loaded "${ref}" (session ${sessionId}) from ${skill.path}`);
    return {
      ok: true,
      name: ref,
      status: "loaded",
      message: `loaded skill "${ref}"`,
      ...(skill.scriptsDir !== undefined ? { scriptsDir: skill.scriptsDir } : {}),
    };
  }

  /** Unload a skill; also unloads its children. No-op when not loaded. */
  async unload(name: string, sessionId: string = this.sessionId): Promise<SkillCommandResult> {
    return this.#serialize(async () => this.#unloadImpl(name, sessionId));
  }

  async #unloadImpl(name: string, sessionId: string): Promise<SkillCommandResult> {
    const ref = name.trim();
    const map = this.#loaded.get(sessionId);
    if (!map || !map.has(ref)) {
      return {
        ok: false,
        name: ref,
        status: "noop",
        message: `skill "${ref}" is not loaded`,
      };
    }
    // Children first, then the skill itself.
    const unloaded: string[] = [];
    for (const key of map.keys()) {
      if (key.startsWith(`${ref}:`)) {
        map.delete(key);
        unloaded.push(key);
      }
    }
    map.delete(ref);
    unloaded.push(ref);
    await this.#persist(sessionId);
    this.#onChange?.(sessionId, this.getLoadedStates(sessionId));
    logger.info(
      `[skills] unloaded "${ref}" (session ${sessionId})${unloaded.length > 1 ? ` (+${unloaded.length - 1} child)` : ""}`,
    );
    return {
      ok: true,
      name: ref,
      status: "unloaded",
      message: `unloaded skill${unloaded.length > 1 ? "s" : ""} ${unloaded.join(", ")}`,
      unloaded,
    };
  }

  /** Persist a session's loaded set through the state backend (best effort). */
  async save(sessionId: string = this.sessionId): Promise<void> {
    await this.#persist(sessionId);
  }

  async #persist(sessionId: string): Promise<void> {
    if (!this.#state) return;
    try {
      const map = this.#loaded.get(sessionId);
      await this.#state.saveSkills(sessionId, map ? [...map.keys()] : []);
    } catch (err) {
      logger.warn(`[skills] persisting loaded skills failed: ${(err as Error).message}`);
    }
  }

  /** Restore a session's loaded set from the state backend (best effort). */
  async restore(sessionId: string = this.sessionId): Promise<void> {
    if (!this.#state) return;
    let names: string[];
    try {
      names = await this.#state.loadSkills(sessionId);
    } catch (err) {
      logger.warn(`[skills] restoring loaded skills failed: ${(err as Error).message}`);
      return;
    }
    const available = await this.discover();
    const map = this.#sessionLoaded(sessionId);
    for (const name of names) {
      const skill = available.find((s) => s.fullName === name);
      if (!skill) {
        logger.warn(`[skills] persisted skill "${name}" is no longer available; skipping`);
        continue;
      }
      if (map.has(name)) continue;
      map.set(name, { skill, loadedAt: Date.now() });
    }
    if (names.length > 0) this.#onChange?.(sessionId, this.getLoadedStates(sessionId));
  }
}

/** Format a skills command result as human-readable text (CLI). */
export function formatCommandResult(result: SkillCommandResult): string {
  const lines: string[] = [];
  if (!result.ok) lines.push(`error: ${result.message}`);
  else if (result.status === "loaded") lines.push(`loaded ${result.name}`);
  else if (result.status === "unloaded") lines.push(`unloaded ${result.name}`);
  else lines.push(result.message);
  return lines.join("\n");
}
