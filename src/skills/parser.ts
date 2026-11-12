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

/** Coerce a scalar YAML token to a JS value (string / number / bool / null). */
function parseScalar(token: string): unknown {
  const t = token.trim();
  if (t === "" || t === "~" || t === "null") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? unescapeDouble(inner) : inner.replace(/''/g, "'");
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return t;
}

/** Minimal double-quoted escape handling. */
function unescapeDouble(inner: string): string {
  return inner.replace(/\\(["\\/bfnrt])/g, (_m, c: string) => {
    switch (c) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        return c;
    }
  });
}

/** Strip an inline `# comment` that sits outside quotes. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
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

/**
 * Parse a (small) YAML subset into a record. Supports nested mappings (by
 * indentation), inline `[a, b]` lists, block `- item` lists, and scalars.
 */
export function parseYamlSubset(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const lines = source
    .split("\n")
    .map((l) => stripComment(l).replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  // Stack of (indent, mapping) — the root is at indent -1.
  const stack: Array<{ indent: number; map: Record<string, unknown> }> = [
    { indent: -1, map: root },
  ];
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    const map = stack[stack.length - 1]!.map;
    if (content === "-" || content.startsWith("- ")) {
      // Block list item belonging to the previous key.
      const lastKey = Object.keys(map).at(-1);
      if (lastKey === undefined) {
        throw new SkillParseError(`frontmatter list item without a key: ${content}`);
      }
      const prev = map[lastKey];
      const item = parseBlockItem(content);
      if (Array.isArray(prev)) prev.push(item);
      else if (prev === null || prev === undefined) {
        const top = stack[0]!;
        const key = Object.keys(top.map).at(-1);
        if (key !== undefined && top.map[key] === null) top.map[key] = [item];
        else map[lastKey] = [item];
      } else {
        throw new SkillParseError(`frontmatter key "${lastKey}" is not a list`);
      }
      continue;
    }
    const kv = splitKeyValue(content);
    if (!kv) throw new SkillParseError(`invalid frontmatter line: ${content}`);
    const [key, rawValue] = kv;
    const value = rawValue.trim();
    if (value === "") {
      // Could be a nested mapping, a block list, or empty — decide on the
      // next line. The child frame collects keys; a following list item at
      // deeper indent is promoted to a list on the parent key.
      const child: Record<string, unknown> = {};
      map[key] = child;
      stack.push({ indent, map: child });
    } else if (value.startsWith("[") && value.endsWith("]")) {
      map[key] = parseInlineList(value);
    } else {
      map[key] = parseScalar(value);
    }
  }
  // Convert empty nested maps back to null (no children followed).
  return normalizeEmptyMaps(root);
}

/** Replace empty objects with `null` (a key with no children). */
function normalizeEmptyMaps(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const nested = normalizeEmptyMaps(v);
      out[k] = Object.keys(nested).length === 0 ? null : nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Parse raw `SKILL.md` text into a typed document. Throws
 * {@link SkillParseError} for oversized input, missing/unterminated
 * frontmatter, or a missing/invalid `name`/`description`.
 */
export function parseSkillMarkdown(raw: string): ParsedSkillDoc {
  const sizeBytes = Buffer.byteLength(raw, "utf8");
  if (sizeBytes > MAX_SKILL_MD_BYTES) {
    throw new SkillParseError(`SKILL.md too large (${sizeBytes} bytes; max ${MAX_SKILL_MD_BYTES})`);
  }
  const { frontmatter, body } = splitFrontmatter(raw);
  if (frontmatter === undefined) {
    throw new SkillParseError("SKILL.md must start with a YAML frontmatter block ('---')");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_SKILL_BODY_BYTES) {
    throw new SkillParseError(
      `SKILL.md body too large (${Buffer.byteLength(body, "utf8")} bytes; max ${MAX_SKILL_BODY_BYTES})`,
    );
  }
  let record: Record<string, unknown>;
  try {
    record = parseYamlSubset(frontmatter);
  } catch (err) {
    throw new SkillParseError(
      `invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
  return { frontmatter: toFrontmatter(record), body, sizeBytes };
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
