/**
 * `SKILL.md` parser: split YAML frontmatter from the markdown body and
 * parse the frontmatter into a typed {@link SkillFrontmatter}.
 *
 * The parser is intentionally small — it covers the scalar/list/mapping
 * forms the Agent Skills format uses (no anchors, aliases, or multi-line
 * folded scalars). Malformed or oversized documents are rejected loudly.
 */
import { readFile } from "../host.ts";
import {
  checkFrontmatterShape,
  MAX_SKILL_BODY_BYTES,
  MAX_SKILL_MD_BYTES,
  toFrontmatter,
} from "./validator.ts";
import type { SkillFrontmatter } from "./types.ts";

/** A parsed `SKILL.md`: raw frontmatter + typed frontmatter + body. */
export interface ParsedSkillDoc {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
  readonly sizeBytes: number;
}

/** Error thrown for unreadable, oversized, or malformed `SKILL.md` content. */
export class SkillParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillParseError";
  }
}

const FRONTMATTER_DELIM = "---";

/**
 * Split a `SKILL.md` string into its frontmatter block (without the `---`
 * fences) and its markdown body. A missing frontmatter block yields
 * `undefined` frontmatter; an unterminated one is an error.
 */
export function splitFrontmatter(raw: string): { frontmatter: string | undefined; body: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = text.split("\n");
  if (lines.length === 0 || lines[0]!.trim() !== FRONTMATTER_DELIM) {
    return { frontmatter: undefined, body: text.trim() };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FRONTMATTER_DELIM) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new SkillParseError("unterminated frontmatter (missing closing '---')");
  }
  return {
    frontmatter: lines.slice(1, end).join("\n"),
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

/** The YAML double-quote escape table (YAML 1.1 subset). */
const ESCAPES = new Map<string, string>([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

/** Minimal double-quoted escape handling (unknown escapes pass through). */
function unescapeDouble(inner: string): string {
  return inner.replace(/\\(["\\/bfnrt])/g, (_m, c: string) => ESCAPES.get(c) ?? c);
}

/** Keyword scalars: `""`/`~`/`null` → null, `true`/`false` → bool. */
const KEYWORD_SCALARS = new Map<string, unknown>([
  ["", null],
  ["~", null],
  ["null", null],
  ["true", true],
  ["false", false],
]);

/** Strip one pair of matching quotes; unescape the inner text. */
function quotedScalar(t: string): string {
  const inner = t.slice(1, -1);
  return t.startsWith('"') ? unescapeDouble(inner) : inner.replace(/''/g, "'");
}

/** `true` when the token opens and closes with a matching quote pair. */
function isQuoted(t: string): boolean {
  if (t.length < 2) return false;
  if (t.startsWith('"')) return t.endsWith('"');
  if (t.startsWith("'")) return t.endsWith("'");
  return false;
}

/** A decimal (optionally signed, optionally fractional) number token. */
function isNumberToken(t: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(t);
}

/** Coerce a scalar YAML token to a JS value (string / number / bool / null). */
function parseScalar(token: string): unknown {
  const t = token.trim();
  if (KEYWORD_SCALARS.has(t)) return KEYWORD_SCALARS.get(t);
  if (isQuoted(t)) return quotedScalar(t);
  if (isNumberToken(t)) return Number(t);
  return t;
}

/**
 * A quoted run: `"…"` with `\x` escapes, or `'…'` with `''` doubling. An
 * unterminated run swallows the rest of the line (the scan state after an
 * unclosed quote never leaves the string).
 */
const QUOTED_RUN = /"(?:\\.|[^"\\])*(?:"|$)|'(?:''|[^'])*(?:'|$)/g;

/**
 * Blank out quoted runs so comment scanning can ignore their contents. Runs
 * are replaced with a non-whitespace filler so a run's end does not make the
 * next char look comment-start (preceded-by-space).
 */
function maskQuoted(line: string): string {
  return line.replace(QUOTED_RUN, (run) => "x".repeat(run.length));
}

/** The index of the first `#` that starts a comment, else `undefined`. */
function commentHash(masked: string): number | undefined {
  const at = masked.search(/(^|\s)#/);
  if (at === -1) return undefined;
  return masked[at] === "#" ? at : at + 1;
}

/** Strip an inline `# comment` that sits outside quotes. */
function stripComment(line: string): string {
  const hash = commentHash(maskQuoted(line));
  return hash === undefined ? line : line.slice(0, hash);
}

/** Split a `key: value` line; returns `undefined` for non-mapping lines. */
function splitKeyValue(line: string): [string, string] | undefined {
  const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
  if (!match) return undefined;
  return [match[1]!, match[2]!];
}

/** Parse a `[a, b, c]` inline sequence. */
function parseInlineList(value: string): string[] {
  const inner = value.slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((v) => String(parseScalar(v)));
}

/** Parse a block `- item` line into its scalar value (or inline mapping). */
function parseBlockItem(content: string): unknown {
  const rest = content.slice(2).trim();
  if (rest === "") return null;
  const kv = splitKeyValue(rest);
  if (kv) return { [kv[0]]: parseScalar(kv[1]) };
  return parseScalar(rest);
}

/** A mapping frame on the indent stack. */
interface MappingFrame {
  readonly indent: number;
  readonly map: Record<string, unknown>;
}

/** Split the frontmatter source into comment-stripped, non-blank lines. */
function yamlLines(source: string): string[] {
  return source
    .split("\n")
    .map((l) => stripComment(l).replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
}

/**
 * The line loop: nested mappings by indentation, `[a, b]` inline lists,
 * `- item` block lists, and scalars. A key with an empty value pushes a
 * child frame; a following list item at deeper indent is promoted to a
 * list on the parent key.
 */
function parseYamlLines(lines: readonly string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  // Stack of (indent, mapping) — the root is at indent -1.
  const stack: MappingFrame[] = [{ indent: -1, map: root }];
  for (const line of lines) parseYamlLine(stack, line);
  return root;
}

/** Dispatch one source line to its handler (list item, key/value, error). */
function parseYamlLine(stack: MappingFrame[], line: string): void {
  const indent = line.length - line.trimStart().length;
  const content = line.trim();
  while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
  const frame = stack[stack.length - 1]!;
  if (isBlockItem(content)) parseBlockListItem(stack, frame, content);
  else parseMappingLine(stack, frame, indent, content);
}

/**
 * Parse a (small) YAML subset into a record. Supports nested mappings (by
 * indentation), inline `[a, b]` lists, block `- item` lists, and scalars.
 */
export function parseYamlSubset(source: string): Record<string, unknown> {
  return normalizeEmptyMaps(parseYamlLines(yamlLines(source)));
}

/** `true` when the line is a `- item` block-list entry. */
function isBlockItem(content: string): boolean {
  return content === "-" || content.startsWith("- ");
}

/** Append an item to a list value (creating the list when absent/null). */
function appendListItem(map: Record<string, unknown>, key: string, item: unknown): void {
  const prev = map[key];
  if (Array.isArray(prev)) {
    prev.push(item);
    return;
  }
  if (prev === null || prev === undefined) {
    map[key] = [item];
    return;
  }
  throw new SkillParseError(`frontmatter key "${key}" is not a list`);
}

/** Apply one `- item` line to the current frame (or promote a null key). */
function parseBlockListItem(stack: MappingFrame[], frame: MappingFrame, content: string): void {
  const lastKey = Object.keys(frame.map).at(-1);
  if (lastKey === undefined) {
    throw new SkillParseError(`frontmatter list item without a key: ${content}`);
  }
  appendListItem(frame.map, lastKey, parseBlockItem(content));
}

/** Apply one `key: value` line to the current frame. */
function parseMappingLine(
  stack: MappingFrame[],
  frame: MappingFrame,
  indent: number,
  content: string,
): void {
  const kv = splitKeyValue(content);
  if (!kv) throw new SkillParseError(`invalid frontmatter line: ${content}`);
  const [key, rawValue] = kv;
  const value = rawValue.trim();
  if (value === "") openChildFrame(stack, frame, indent, key);
  else frame.map[key] = parseMappingValue(value);
}

/** A key with no value: nested mapping, block list, or empty — decided later. */
function openChildFrame(
  stack: MappingFrame[],
  frame: MappingFrame,
  indent: number,
  key: string,
): void {
  // The child frame collects keys; a following list item at deeper indent
  // is promoted to a list on the parent key.
  const child: Record<string, unknown> = {};
  frame.map[key] = child;
  stack.push({ indent, map: child });
}

/** The scalar or inline-list value of a `key: value` line. */
function parseMappingValue(value: string): unknown {
  if (value.startsWith("[") && value.endsWith("]")) return parseInlineList(value);
  return parseScalar(value);
}

/** A plain mapping value (not null, not an array). */
function isMapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Replace empty objects with `null` (a key with no children). */
function normalizeEmptyMaps(value: unknown): Record<string, unknown> {
  if (!isMapping(value)) return value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizedChild(v)]));
}

/** One normalized entry value: recursed, and nulled when it empties out. */
function normalizedChild(value: unknown): unknown {
  if (!isMapping(value)) return value;
  const nested = normalizeEmptyMaps(value);
  return isEmptyMapping(nested) ? null : nested;
}

/** `true` when a mapping has no keys. */
function isEmptyMapping(value: Record<string, unknown>): boolean {
  return Object.keys(value).length === 0;
}

/**
 * Parse raw `SKILL.md` text into a typed document. Throws
 * {@link SkillParseError} for oversized input, missing/unterminated
 * frontmatter, or a missing/invalid `name`/`description`.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillDoc {
  const sizeBytes = Buffer.byteLength(raw, "utf8");
  assertSizeWithin(
    sizeBytes,
    MAX_SKILL_MD_BYTES,
    `SKILL.md too large (${sizeBytes} bytes; max ${MAX_SKILL_MD_BYTES})`,
  );
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === undefined) {
    throw new SkillParseError("SKILL.md must start with a YAML frontmatter block ('---')");
  }
  assertBodySize(body);
  const record = frontmatterRecord(frontmatter);
  assertShape(record);
  return { frontmatter: toFrontmatter(record), body, sizeBytes };
}

/** Reject a byte size over `max` with `message`. */
function assertSizeWithin(sizeBytes: number, max: number, message: string): void {
  if (sizeBytes > max) throw new SkillParseError(message);
}

/** Reject an oversized markdown body. */
function assertBodySize(body: string): void {
  const bodyBytes = Buffer.byteLength(body, "utf8");
  assertSizeWithin(
    bodyBytes,
    MAX_SKILL_BODY_BYTES,
    `SKILL.md body too large (${bodyBytes} bytes; max ${MAX_SKILL_BODY_BYTES})`,
  );
}

/** Parse the frontmatter block, rethrowing parser errors with context. */
function frontmatterRecord(frontmatter: string): Record<string, unknown> {
  try {
    return parseYamlSubset(frontmatter);
  } catch (err) {
    throw new SkillParseError(
      `invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Validate the parsed record's shape and required fields. */
function assertShape(record: Record<string, unknown>): void {
  const check = checkFrontmatterShape(record);
  if (!check.ok) {
    throw new SkillParseError(`invalid frontmatter: ${check.errors.join("; ")}`);
  }
  if (typeof record.name !== "string" || record.name.trim() === "") {
    throw new SkillParseError('frontmatter must define a non-empty "name"');
  }
  if (typeof record.description !== "string") {
    throw new SkillParseError('frontmatter must define a "description"');
  }
}

/** Read and parse a `SKILL.md` from disk. */
export async function readSkillFile(path: string): Promise<ParsedSkillDoc> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new SkillParseError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseSkillMarkdown(raw);
}
