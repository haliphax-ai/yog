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
import { readdir, stat } from "../host.ts";
import { packageDir } from "./package.ts";
import { isValidSkillName, skillNameError, normalizePath } from "./validator.ts";

import type { SkillMetadata, SkillSource } from "./types.ts";

/** Default source directories, in priority order. */
export const DEFAULT_SKILL_SOURCES: ReadonlyArray<{ source: SkillSource; dir: string }> = [
  { source: "system", dir: "/var/lib/yog/skills" },
  { source: "agent", dir: "~/.yog/skills" },
  { source: "cwd", dir: ".yog/skills" },
];

/** Options for {@link discoverSkills}. */
export interface DiscoverOptions {
  /** Return child (namespaced) skills (default true). */
  readonly cwd?: string;
  /** Override the source directories (tests, programmatic callers). */
  readonly sources?: ReadonlyArray<{ source: SkillSource; dir: string }>;
  /** Also return child (namespaced) skills (default true). */
  readonly includeChildren?: boolean;
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

/** `true` when `path` exists as a directory. */
async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `true` when `path` exists as a regular file. */
async function fileExists(path: string): Promise<boolean> {
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
  if (!isValidSkillName(name)) {
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
  if (!(await fileExists(skillFile))) return undefined;
  const name = parentDir.split("/").filter(Boolean).at(-1) ?? "";
  if (!isValidSkillName(name)) {
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
    if (!(await dirExists(childDir))) continue;
    if (!(await fileExists(`${childDir}/SKILL.md`))) continue;
    if (skillNameError(entry) !== undefined) {
      logger.warn(`[skills] ignoring child skill with invalid name: ${childDir}`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

/** Extract one source-dir entry as metadata (undefined when not a skill). */
async function discoverEntry(
  entryPath: string,
  entry: string,
  dir: string,
  source: SkillSource,
  options: DiscoverOptions,
): Promise<SkillMetadata | undefined> {
  if (entry.endsWith(".md")) {
    // Bare skill document at the top level of a source directory.
    return discoverBare(dir, source, entry);
  }
  if (!(await dirExists(entryPath))) return undefined;
  // Package skill: <dir>/SKILL.md plus optional child packages.
  return discoverPackage(entryPath, source, options);
}

/** Record `meta` (and its children) in `found`; skips when already seen. */
async function recordSkill(
  found: Map<string, SkillMetadata>,
  meta: SkillMetadata,
  options: DiscoverOptions,
): Promise<void> {
  if (found.has(meta.fullName)) {
    logger.warn(`[skills] duplicate skill name "${meta.fullName}"; keeping the first`);
    return;
  }
  found.set(meta.fullName, meta);
  for (const childName of meta.childNames) {
    const childMeta = await discoverPackage(
      `${meta.path}/${childName}`,
      meta.source,
      options,
      meta,
    );
    if (childMeta === undefined || found.has(childMeta.fullName)) continue;
    found.set(childMeta.fullName, childMeta);
  }
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
  const sources = (options.sources ?? DEFAULT_SKILL_SOURCES).map((s) => ({
    source: s.source,
    dir: resolveSourceDir(s.dir, cwd, process.env.HOME),
  }));
  const found = new Map<string, SkillMetadata>();
  for (const { source, dir } of sources) {
    for (const meta of await scanSourceDir(dir, source, options)) {
      await recordSkill(found, meta, options);
    }
  }
  return [...found.values()];
}

/** Read one source dir (sorted entries); undefined when unreadable. */
async function listSourceDir(dir: string): Promise<string[] | undefined> {
  if (!(await dirExists(dir))) return undefined;
  try {
    return (await readdir(dir)).sort();
  } catch (err) {
    logger.warn(`[skills] cannot read ${dir}: ${(err as Error).message}`);
    return undefined;
  }
}

/** Scan one source dir: metadata for each top-level entry, in name order. */
async function scanSourceDir(
  dir: string,
  source: SkillSource,
  options: DiscoverOptions,
): Promise<SkillMetadata[]> {
  const entries = await listSourceDir(dir);
  if (entries === undefined) return [];
  const metas: SkillMetadata[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const entryPath = `${dir.replace(/\/+$/, "")}/${entry}`;
    const meta = await discoverEntry(entryPath, entry, dir, source, options);
    if (meta) metas.push(meta);
  }
  return metas;
}
