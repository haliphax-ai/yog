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
  return skillNameError(name) === undefined;
}

/** First structural reason `name` is invalid (length window, then charset). */
function nameLengthOrPatternError(name: string): string | undefined {
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

/** Return a human-readable reason `name` is invalid, or `undefined`. */
export function skillNameError(name: string): string | undefined {
  return nameLengthOrPatternError(name);
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
  return splitFullName(fullName).every((part) => part === undefined || isValidSkillName(part));
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
  if (relative === "") return baseDirOf(skillDir);
  if (relative.startsWith("/") || relative.includes("\0")) return undefined;
  const base = baseDirOf(skillDir);
  const normalized = normalizePath(`${dirPrefix(skillDir)}${relative}`);
  if (escapesBase(normalized, base)) return undefined;
  return normalized;
}

/** `true` when `normalized` leaves the `base` directory subtree. */
function escapesBase(normalized: string, base: string): boolean {
  if (normalized === base) return false;
  return !normalized.startsWith(`${base}/`);
}

/** Base dir with trailing slashes collapsed (empty → the root). */
function baseDirOf(skillDir: string): string {
  return skillDir.replace(/\/+$/, "") || "/";
}

/** Path prefix that keeps a relative child inside `skillDir`. */
function dirPrefix(skillDir: string): string {
  return skillDir.endsWith("/") ? skillDir : `${skillDir}/`;
}

/** Collapse `.`/`..` segments and duplicate slashes in a POSIX path. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) normalizeSegment(out, segment, absolute);
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

/** Fold one path segment into the normalized accumulator. */
function normalizeSegment(out: string[], segment: string, absolute: boolean): void {
  if (segment === "" || segment === ".") return;
  if (segment === "..") popOrKeepDotDot(out, absolute);
  else out.push(segment);
}

/** One `..` step: pop the previous segment, keep a relative leading `..`. */
function popOrKeepDotDot(out: string[], absolute: boolean): void {
  if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
  else if (!absolute) out.push("..");
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
  for (const check of FIELD_CHECKS) check(value, errors);
  return { ok: errors.length === 0, errors };
}

/** Metadata must be a plain mapping (`null` and arrays are not). */
function asMetadata(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

/** Frontmatter keys with a typed slot on {@link SkillFrontmatter}. */
const KNOWN_FRONTMATTER_KEYS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "allowedTools",
  "disable-model-invocation",
]);

/** Normalize `allowed-tools` (string CSV or array) to a string array. */
function parseAllowedTools(raw: unknown): string[] {
  if (typeof raw === "string")
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  return [];
}

/** Convert a raw frontmatter record into typed {@link SkillFrontmatter}. */
export function toFrontmatter(value: Record<string, unknown>): SkillFrontmatter {
  return {
    name: typeof value.name === "string" ? value.name.trim() : "",
    description: typeof value.description === "string" ? value.description : "",
    license: typeof value.license === "string" ? value.license : undefined,
    compatibility: typeof value.compatibility === "string" ? value.compatibility : undefined,
    metadata: asMetadata(value.metadata),
    allowedTools: allowedToolsOf(value),
    disableModelInvocation: value["disable-model-invocation"] === true,
    extra: extraFrontmatter(value),
  };
}

/** Typed `allowedTools` slot: non-empty string array, else undefined. */
function allowedToolsOf(value: Record<string, unknown>): string[] | undefined {
  const tools = parseAllowedTools(value["allowed-tools"] ?? value.allowedTools);
  return tools.length > 0 ? tools : undefined;
}

/** Frontmatter keys outside the known set (kept for round-tripping). */
function extraFrontmatter(value: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(k)) extra[k] = v;
  }
  return extra;
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

/**
 * Frontmatter field checks for {@link checkFrontmatterShape}. One function
 * per field: each validates the raw YAML value and appends a human-readable
 * error to `errors` when the value's shape is wrong.
 */
type FieldCheck = (value: Record<string, unknown>, errors: string[]) => void;

/** `disable-model-invocation` must be a boolean when present. */
function checkDisableInvocation(value: Record<string, unknown>, errors: string[]): void {
  const disable = value[DISABLE_MODEL_INVOCATION_KEY];
  if (disable !== undefined && disable !== null && typeof disable !== "boolean") {
    errors.push(
      `frontmatter "${DISABLE_MODEL_INVOCATION_KEY}" must be a boolean (got ${typeof disable})`,
    );
  }
}

/** `name` must be a non-empty string (and a valid skill name when present). */
function checkNameField(value: Record<string, unknown>, errors: string[]): void {
  const name = value.name;
  if (name !== undefined && (typeof name !== "string" || name.trim() === "")) {
    errors.push(`frontmatter "name" must be a non-empty string (got ${JSON.stringify(name)})`);
    return;
  }
  if (typeof name === "string") {
    const err = skillNameError(name.trim());
    if (err) errors.push(err);
  }
}

/** `description` must be a string when present. */
function checkDescriptionField(value: Record<string, unknown>, errors: string[]): void {
  const description = value.description;
  if (description !== undefined && typeof description !== "string") {
    errors.push(`frontmatter "description" must be a string (got ${typeof description})`);
  }
}

/** `allowed-tools` must be a non-empty string or an array of strings. */
function checkAllowedToolsField(value: Record<string, unknown>, errors: string[]): void {
  const allowed = value["allowed-tools"] ?? value.allowedTools;
  if (allowed === undefined) return;
  if (typeof allowed === "string") {
    if (allowed.trim() === "") errors.push(`frontmatter "allowed-tools" must not be empty`);
  } else if (!Array.isArray(allowed) || allowed.some((t) => typeof t !== "string")) {
    errors.push(`frontmatter "allowed-tools" must be a string or an array of strings`);
  }
}

/** `metadata` must be a mapping when present. */
function checkMetadataField(value: Record<string, unknown>, errors: string[]): void {
  const metadata = value.metadata;
  if (
    metadata !== undefined &&
    (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))
  ) {
    errors.push(`frontmatter "metadata" must be a mapping`);
  }
}

/** Frontmatter field checks, in report order. */
const FIELD_CHECKS: readonly FieldCheck[] = [
  checkDisableInvocation,
  checkNameField,
  checkDescriptionField,
  checkAllowedToolsField,
  checkMetadataField,
];
