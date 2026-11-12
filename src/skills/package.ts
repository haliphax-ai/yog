/**
 * Skill package structure helpers.
 *
 * A *package* skill is a directory with a `SKILL.md` and an optional package
 * layout alongside it:
 *
 *   <skill>/
 *   ├── SKILL.md          # required: frontmatter + instructions
 *   ├── scripts/          # optional: executables added to PATH when loaded
 *   ├── references/       # optional: reference docs loaded on demand
 *   └── assets/           # optional: templates, images, fonts, …
 *
 * The standard directory names are the conventional ones; `packageDirs()`
 * only treats *directories* as package subdirectories.
 */
import { readdir, stat } from "../host.ts";
import { assertPathWithin } from "./validator.ts";

/** Conventional package subdirectory names. */
export const PACKAGE_DIRS = ["scripts", "references", "assets"] as const;

/** Which conventional subdirectory a path belongs to. */
export type PackageDirName = (typeof PACKAGE_DIRS)[number];

/** Resolve the conventional subdirectory of `skillDir`, if it is a directory. */
export async function packageDir(
  skillDir: string,
  name: PackageDirName,
): Promise<string | undefined> {
  const path = `${skillDir.replace(/\/+$/, "")}/${name}`;
  try {
    const info = await stat(path);
    return info.isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

/** All conventional subdirectories present in `skillDir` (directories only). */
export async function packageDirs(
  skillDir: string,
): Promise<Partial<Record<PackageDirName, string>>> {
  const out: Partial<Record<PackageDirName, string>> = {};
  for (const name of PACKAGE_DIRS) {
    const dir = await packageDir(skillDir, name);
    if (dir !== undefined) out[name] = dir;
  }
  return out;
}

/** Whether `skillDir` has a `scripts/` directory (PATH injection candidate). */
export async function hasScriptsDir(skillDir: string): Promise<boolean> {
  return (await packageDir(skillDir, "scripts")) !== undefined;
}

/**
 * List the immediate entries of a package subdirectory (empty when missing).
 * Used for diagnostics (`yog skills list --verbose`) and validation.
 */
export async function listPackageDir(skillDir: string, name: PackageDirName): Promise<string[]> {
  const dir = await packageDir(skillDir, name);
  if (dir === undefined) return [];
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/**
 * Resolve a path *inside* a skill package directory, refusing escapes.
 * `relative` must stay within `skillDir` (validated by `validator.ts`).
 */
export function packagePath(skillDir: string, relative: string): string {
  assertPathWithin(skillDir, relative);
  return `${skillDir.replace(/\/+$/, "")}/${relative}`;
}
