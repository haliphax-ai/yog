/**
 * Validation for skill names, paths, and `SKILL.md` frontmatter.
 *
 * Validation is deliberately strict and *loud*: invalid names, escaping
 * paths, or malformed frontmatter are reported as errors rather than
 * sanitized into something that merely looks valid.
 */
import { stat } from "../host.ts";
import type { SkillFrontmatter } from "./types.ts";

/** Name of the frontmatter key that hides a skill from the agent. */
export const DISABLE_MODEL_INVOCATION_KEY = "disable-model-invocation";

/** Maximum `SKILL.md` size (100 KB) — guards the agent's context window. */
export const MAX_SKILL_MD_BYTES = 100 * 1024;

/** Maximum `SKILL.md` body size after frontmatter stripping (50 KB). */
export const MAX_SKILL_BODY_BYTES = 50 * 1024;

/** Minimum / maximum skill name length. */
export const MIN_NAME_LENGTH = 1;
export const MAX_NAME_LENGTH = 64;

/** A valid skill name: lowercase alphanumerics separated by single hyphens. */
const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** `true` when `name` is a valid skill name (lowercase, hyphens, 1–64). */
export function isValidSkillName(name: string): boolean {
  return (
    name.length >= MIN_NAME_LENGTH && name.length <= MAX_NAME_LENGTH && NAME_PATTERN.test(name)
  );
}

/** Return a human-readable reason `name` is invalid, or `undefined`. */
export function skillNameError(name: string): string | undefined {
  if (name.length < MIN_NAME_LENGTH || name.length > MAX_NAME_LENGTH) {
    return `skill name "${name}" must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters`;
  }
  if (!NAME_PATTERN.test(name)) {
    return (
      `invalid skill name "${name}": use lowercase letters, digits, and single hyphens ` +
      `(^[a-z0-9]+(-[a-z0-9]+)*$)`
    );
  }
  return undefined;
}

/** Separator between a trunk skill and a child skill in a full name. */
export const NAMESPACE_SEPARATOR = ":";

/** Split `trunk:branch` into `[trunk, branch]`; a bare name yields `[name]`. */
export function splitFullName(fullName: string): [string, string | undefined] {
  const idx = fullName.indexOf(NAMESPACE_SEPARATOR);
  if (idx === -1) return [fullName, undefined];
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}

/** `true` when `fullName` is a valid (optionally namespaced) skill name. */
export function isValidFullName(fullName: string): boolean {
  const [trunk, branch] = splitFullName(fullName);
  if (!isValidSkillName(trunk)) return false;
  return branch === undefined || isValidSkillName(branch);
}

/**
 * Ensure `childPath` stays within `skillDir` (no `..` escapes, no absolute
 * paths). `childPath` is the path *relative to* `skillDir`.
 */
export function assertPathWithin(skillDir: string, relative: string): void {
  const resolved = resolveWithin(skillDir, relative);
  if (resolved === undefined) {
    throw new Error(`skill path escapes its directory: ${JSON.stringify(relative)}`);
  }
}

/**
 * Resolve `relative` against `skillDir`, returning the absolute path only
 * when it stays inside `skillDir`, else `undefined`.
 */
export function resolveWithin(skillDir: string, relative: string): string | undefined {
  const base = skillDir.replace(/\/+$/, "") || "/";
  if (relative === "") return base;
  if (relative.startsWith("/") || relative.includes("\0")) return undefined;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const resolved = `${prefix}${relative}`;
  const normalized = normalizePath(resolved);
  if (normalized !== base && !normalized.startsWith(`${base}/`)) return undefined;
  return normalized;
}

/** Collapse `.`/`..` segments and duplicate slashes in a POSIX path. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

/** Well-formedness result for a parsed frontmatter object. */
export interface FrontmatterCheck {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate the *shape* of a parsed frontmatter object (before typed
 * conversion): `name` and `description` must be non-empty strings when
 * present, `allowed-tools` a string or string array, `metadata` a mapping,
 * `disable-model-invocation` a boolean.
 */
export function checkFrontmatterShape(value: Record<string, unknown>): FrontmatterCheck {
  const errors: string[] = [];
  const disable = value["disable-model-invocation"];
  if (disable !== undefined && disable !== null && typeof disable !== "boolean") {
    errors.push(`frontmatter "disable-model-invocation" must be a boolean (got ${typeof disable})`);
  }
  const name = value.name;
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    errors.push(`frontmatter "name" must be a non-empty string (got ${JSON.stringify(name)})`);
  } else if (typeof name === "string") {
    const err = skillNameError(name.trim());
    if (err) errors.push(err);
  }
  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    errors.push(`frontmatter "description" must be a string (got ${typeof description})`);
  }
  const allowed = value["allowed-tools"] ?? value.allowedTools;
  if (allowed !== undefined) {
    if (typeof allowed === "string") {
      if (allowed.trim() === "") errors.push(`frontmatter "allowed-tools" must not be empty`);
    } else if (!Array.isArray(allowed) || allowed.some((t) => typeof t !== "string")) {
      errors.push(`frontmatter "allowed-tools" must be a string or an array of strings`);
    }
  }
  const metadata = value.metadata;
  if (
    metadata !== undefined &&
    (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    errors.push(`frontmatter "metadata" must be a mapping`);
  }
  return { ok: errors.length === 0, errors };
}

/** Convert a raw frontmatter record into typed {@link SkillFrontmatter}. */
export function toFrontmatter(value: Record<string, unknown>): SkillFrontmatter {
  const allowedRaw = value["allowed-tools"] ?? value.allowedTools;
  let allowedTools: string[] | undefined;
  if (typeof allowedRaw === "string") {
    allowedTools = allowedRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  } else if (Array.isArray(allowedRaw)) {
    allowedTools = allowedRaw.filter((t): t is string => typeof t === "string");
  }
  const metadata =
    value.metadata !== null && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : undefined;
  const known = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
    "allowedTools",
    "disable-model-invocation",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!known.has(k)) extra[k] = v;
  }
  return {
    name: typeof value.name === "string" ? value.name.trim() : "",
    description: typeof value.description === "string" ? value.description : "",
    license: typeof value.license === "string" ? value.license : undefined,
    compatibility: typeof value.compatibility === "string" ? value.compatibility : undefined,
    metadata,
    allowedTools: allowedTools && allowedTools.length > 0 ? allowedTools : undefined,
    disableModelInvocation: value["disable-model-invocation"] === true,
    extra,
  };
}

/** Best-effort size stat for the size cap; `-1` when unreadable. */
export async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : -1;
  } catch {
    return -1;
  }
}

/**
 * `true` when the skill's frontmatter disables agent (model) invocation.
 */
export function isModelInvocationDisabled(fm: SkillFrontmatter): boolean {
  return fm.disableModelInvocation === true;
}
