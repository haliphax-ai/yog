/**
 * Skill discovery.
 *
 * Scans the configured source directories (system, agent home, cwd) for
 * skills, in priority order. Two layouts are recognized:
 *
 *   - a **bare** skill: a `<name>.md` file directly in a source directory
 *     (`SKILL.md` is *not* allowed at the top level of a source directory);
 *   - a **package** skill: a directory containing `SKILL.md`, with optional
 *     `scripts/`, `references/`, `assets/` subdirectories.
 *
 * When a package skill directory contains subdirectories with their own
 * `SKILL.md`, those are *child* skills, namespaced `<trunk>:<branch>` (one
 * level of recursion only — no grandchildren). A bare skill cannot have
 * children.
 *
 * Discovery is deduplicated by name: the first source wins. Invalid skills
 * are skipped (with a warning) rather than aborting the whole scan, but a
 * *loaded* skill is validated loudly.
 */
import { logger } from "../log.ts";
import { exists, readdir, stat } from "../host.ts";
import { readSkillFile } from "./parser.ts";
import { packageDir } from "./package.ts";
import { isValidSkillName, normalizePath, skillNameError, splitFullName } from "./validator.ts";
import type { Skill, SkillMetadata, SkillSource } from "./types.ts";

/** Default source directories, in priority order. */
export const DEFAULT_SKILL_SOURCES: ReadonlyArray<{ source: SkillSource; dir: string }> = [
  { source: "system", dir: "/var/lib/yog/skills" },
  { source: "agent", dir: "~/.yog/skills" },
  { source: "cwd", dir: ".yog/skills" },
];

/** Options for {@link discoverSkills}. */
export interface DiscoverOptions {
  /** Override the source directories (tests, programmatic callers). */
  readonly sources?: ReadonlyArray<{ source: SkillSource; dir: string }>;
  /** Working directory used to resolve relative source dirs (default cwd). */
  readonly cwd?: string;
  /** Also return child (namespaced) skills (default true). */
  readonly includeChildren?: boolean;
}

/** One discovered skill entry plus its source. */
export interface DiscoveredSkill {
  readonly metadata: SkillMetadata;
}

/** Resolve the absolute path of a source directory (relative to `cwd`). */
export function resolveSourceDir(dir: string, cwd: string, home: string | undefined): string {
  if (dir.startsWith("/")) return normalizePath(dir);
  if (dir === "~" || dir.startsWith("~/")) {
    const base = home ?? process.env.HOME ?? "/root";
    return normalizePath(dir === "~" ? base : `${base}/${dir.slice(2)}`);
  }
  return normalizePath(`${cwd.replace(/\/+$/, "")}/${dir}`);
}

/** `true` when `path` is an existing directory. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `true` when `path` is an existing regular file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** A bare `<name>.md` file directly in a source directory. */
async function discoverBare(
  sourceDir: string,
  source: SkillSource,
  file: string,
): Promise<SkillMetadata | undefined> {
  if (file === "SKILL.md") return undefined;
  if (!file.endsWith(".md")) return undefined;
  const name = file.slice(0, -".md".length);
  if (skillNameError(name) !== undefined) {
    logger.warn(`[skills] ignoring bare skill file with invalid name: ${sourceDir}/${file}`);
    return undefined;
  }
  const path = `${sourceDir.replace(/\/+$/, "")}/${file}`;
  const scriptsDir = await packageDir(sourceDir, "scripts");
  return {
    name,
    fullName: name,
    parentName: undefined,
    childNames: [],
    isChild: false,
    source,
    path: sourceDir,
    skillFile: path,
    scriptsDir,
    referencesDir: await packageDir(sourceDir, "references"),
    assetsDir: await packageDir(sourceDir, "assets"),
    trunkName: name,
  };
}

/** A package skill directory `<dir>/SKILL.md`, plus its child packages. */
async function discoverPackage(
  parentDir: string,
  source: SkillSource,
  options: DiscoverOptions,
  parent?: SkillMetadata,
): Promise<SkillMetadata | undefined> {
  const skillFile = `${parentDir.replace(/\/+$/, "")}/SKILL.md`;
  if (!(await isFile(skillFile))) return undefined;
  const name = parentDir.split("/").filter(Boolean).at(-1) ?? "";
  if (skillNameError(name) !== undefined) {
    logger.warn(`[skills] ignoring skill directory with invalid name: ${parentDir}`);
    return undefined;
  }
  const fullName = parent ? `${parent.fullName}:${name}` : name;
  const meta: SkillMetadata = {
    name,
    fullName,
    parentName: parent?.fullName,
    childNames: [],
    isChild: parent !== undefined,
    source,
    path: parentDir,
    skillFile,
    scriptsDir: await packageDir(parentDir, "scripts"),
    referencesDir: await packageDir(parentDir, "references"),
    assetsDir: await packageDir(parentDir, "assets"),
    trunkName: parent?.trunkName ?? name,
  };
  if (options.includeChildren !== false) {
    (meta.childNames as string[]).push(...(await discoverChildNames(parentDir)));
  }
  return meta;
}

/** Names of child skill packages (directories with `SKILL.md`) under `dir`. */
async function discoverChildNames(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const childDir = `${dir.replace(/\/+$/, "")}/${entry}`;
    if (!(await isDir(childDir))) continue;
    if (!(await isFile(`${childDir}/SKILL.md`))) continue;
    if (skillNameError(entry) !== undefined) {
      logger.warn(`[skills] ignoring child skill with invalid name: ${childDir}`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Discover every available skill from the configured sources.
 *
 * Returns top-level skills with their (namespaced) child names filled in;
 * child skills themselves are returned as separate entries with
 * `isChild: true` and `parentName` set, deduplicated by `fullName`.
 */
export async function discoverSkills(options: DiscoverOptions = {}): Promise<SkillMetadata[]> {
  const cwd = options.cwd ?? process.cwd();
  const home = process.env.HOME;
  const sources =
    options.sources ??
    DEFAULT_SKILL_SOURCES.map((s) => ({
      source: s.source,
      dir: resolveSourceDir(s.dir, cwd, home),
    }));
  const found = new Map<string, SkillMetadata>();
  for (const { source, dir } of sources) {
    if (!(await isDir(dir))) continue;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      logger.warn(`[skills] cannot read ${dir}: ${(err as Error).message}`);
      continue;
    }
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue;
      const entryPath = `${dir.replace(/\/+$/, "")}/${entry}`;
      if (entry.endsWith(".md")) {
        // Bare skill document at the top level of a source directory.
        const meta = await discoverBare(dir, source, entry);
        if (!meta) continue;
        if (found.has(meta.fullName)) {
          logger.warn(
            `[skills] duplicate skill name "${meta.fullName}" in ${dir}; keeping the first`,
          );
          continue;
        }
        found.set(meta.fullName, meta);
        continue;
      }
      if (!(await isDir(entryPath))) continue;
      // Package skill: <dir>/SKILL.md plus optional child packages.
      const meta = await discoverPackage(entryPath, source, options);
      if (!meta) continue;
      if (found.has(meta.fullName)) {
        logger.warn(
          `[skills] duplicate skill name "${meta.fullName}" in ${dir}; keeping the first`,
        );
        continue;
      }
      found.set(meta.fullName, meta);
      for (const childName of meta.childNames) {
        const childMeta = await discoverPackage(`${entryPath}/${childName}`, source, options, meta);
        if (!childMeta) continue;
        if (found.has(childMeta.fullName)) {
          logger.warn(`[skills] duplicate child skill "${childMeta.fullName}"; keeping the first`);
          continue;
        }
        found.set(childMeta.fullName, childMeta);
      }
    }
  }
  return [...found.values()];
}

/** Discover and fully load (parse `SKILL.md`) every available skill. */
export async function loadSkills(options: DiscoverOptions = {}): Promise<Skill[]> {
  const metas = await discoverSkills(options);
  const out: Skill[] = [];
  for (const meta of metas) {
    try {
      const doc = await readSkillFile(meta.skillFile);
      out.push({ ...meta, ...doc });
    } catch (err) {
      logger.warn(
        `[skills] skipping ${meta.fullName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/** Split a `trunk:branch` reference; validates the trunk part. */
export function parseSkillRef(ref: string): { trunk: string; branch: string | undefined } {
  const [trunk, branch] = splitFullName(ref);
  if (!isValidSkillName(trunk)) {
    throw new Error(`invalid skill reference "${ref}": ${skillNameError(trunk) ?? "bad trunk"}`);
  }
  if (branch !== undefined && !isValidSkillName(branch)) {
    throw new Error(`invalid skill reference "${ref}": ${skillNameError(branch) ?? "bad branch"}`);
  }
  return { trunk, branch };
}

/** Whether a skill reference is a child (namespaced) reference. */
export function isChildRef(ref: string): boolean {
  return splitFullName(ref)[1] !== undefined;
}

/** Build the system prompt section listing available (unloaded) skills. */
export function formatAvailableSkills(metas: readonly SkillMetadata[]): string {
  if (metas.length === 0) return "";
  const lines = metas.map((m) => {
    const desc = m.isChild ? " (child skill)" : "";
    return `- ${m.fullName}${desc} — load with \`yog skills load ${m.fullName}\``;
  });
  return `# Available skills\n\n${lines.join("\n")}`;
}

/** Build the system prompt section for loaded skills (instructions). */
export function formatLoadedSkills(loaded: readonly Skill[]): string {
  if (loaded.length === 0) return "";
  const sections = loaded.map((s) => `## Skill: ${s.fullName}\n\n${s.body}`);
  return `# Loaded skill instructions\n\n${sections.join("\n\n---\n\n")}`;
}

/** Type guard: does a path exist at all (used by tests / CLI). */
export async function pathExists(path: string): Promise<boolean> {
  return exists(path);
}
