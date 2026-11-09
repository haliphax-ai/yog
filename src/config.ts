/**
 * Runtime configuration for the yog daemon.
 *
 * Configuration comes from a JSON file (default `/var/lib/yog/config.json`,
 * override with `--config <path>`) and is loaded as a **merge** over the
 * schema defaults: the file sets only the keys it contains, everything else
 * keeps its default (see the per-field defaults below). An explicit
 * `Partial<YogConfig>` injection (tests, programmatic callers) merges the
 * same way and wins last. There are no environment variables: the daemon's
 * own env is process plumbing, not configuration.
 *
 * The file is optional. A missing file, an empty/touched file, or the
 * directory stub Docker Compose creates when the host file does not exist
 * all mean "no config provided" — pure defaults apply. A file that exists
 * but fails to parse or validate throws — a config typo must fail loudly,
 * not silently fall back.
 *
 * Container defaults follow the documented UID scheme (Dockerfile): the
 * `yog` daemon runs as uid 900 and agents start at 1100, so even a config
 * that only sets `host` still runs model-executed code as the `agent` user
 * with its HOME at `/home/agent` — never as the daemon.
 */
import { z } from "zod";
import { cpus } from "node:os";
import { readFile, stat } from "./host.ts";
import { env } from "node:process";

export const MODELS_DEV_PATH = env.YOG_MODELS_DEV_PATH ?? "/var/lib/yog/models.json";

/** Default path the daemon reads its configuration from. */
export const DEFAULT_CONFIG_PATH = "/var/lib/yog/config.json";

/** Documented agent-pool base uid/gid (the `agent` user in the image). */
export const DEFAULT_AGENT_UID = 1100;
export const DEFAULT_AGENT_GID = 1100;

const host = z.string().min(1).default("127.0.0.1").describe("daemon bind address");
const port = z.number().int().min(0).max(65535).default(8111).describe("daemon port");

/**
 * The daemon configuration schema. Every field carries its default here, so
 * an empty config file yields a working loopback daemon with the agent split
 * enabled; the loader merges a provided file over these values.
 */
export const YogConfigSchema = z
  .object({
    /** HTTP/SSE bind address. */
    host,
    /** HTTP/SSE port. */
    port,
    /** Bearer token for the contract; unset = auth disabled. */
    apiToken: z.string().min(1).optional(),
    /** Store queries slower than this (ms) are logged (log-only tripwire). */
    dbSlowMs: z.number().int().min(0).default(50),
    /** State root: `sessions.db` + `agentfs/<agentId>.db` + `harness/<sessionId>`. */
    stateRoot: z.string().min(1).default("/var/lib/yog"),
    /** Full-path override for the agent state db (wins over `stateRoot`). */
    statePath: z.string().min(1).optional(),
    /** Worker pool size for parallel tool execution; unset = max(1, cpus-1). */
    workers: z.number().int().min(1).optional(),
    /** Model id advertised by capabilities and used for turns. */
    model: z.string().min(1).default("gpt-4o-mini"),
    /** Path to the local models.dev API JSON (for context-window lookups). */
    modelsDevPath: z.string().min(1).default(MODELS_DEV_PATH),
    /** Model used for compaction/handoff summary turns; unset = session model. */
    compactionModel: z.string().min(1).optional(),
    /** OpenAI-compatible endpoint; unset = SDK default. */
    providerBaseUrl: z.string().min(1).optional(),
    /** Provider API key; unset = SDK default resolution. */
    providerApiKey: z.string().min(1).optional(),
    /** FUSE mountpoint for the virtual filesystem. */
    mountPoint: z.string().min(1).default("/yog"),
    /** Allow other users to reach the mount (container: agent != daemon user). */
    allowOther: z.boolean().default(false),
    /**
     * Tool-call rounds allowed per turn before the engine stops the turn with
     * `turn.finished { stopReason: "max_rounds" }`.
     */
    maxRoundsPerTurn: z.number().int().min(1).default(200),
    /**
     * Provider 429 retry policy (engine, per round): total requests
     * allowed per round, initial try included. `1` disables retrying
     * (the first 429 is terminal `rate_limited`). Default 6.
     */
    rateLimitMaxAttempts: z.number().int().min(1).default(6),
    /**
     * First exponential backoff wait (ms) after a 429 with no usable
     * server hint. Default 1000.
     */
    rateLimitBaseDelayMs: z.number().int().min(0).default(1000),
    /**
     * Cap for any single backoff wait (ms), server hints included.
     * Default 60_000.
     */
    rateLimitMaxDelayMs: z.number().int().min(0).default(60_000),
    /**
     * Exponential multiplier per failed attempt. Default 2.
     */
    rateLimitBackoffFactor: z.number().min(1).default(2),
    /**
     * Per-tool serialized output budget (chars): a tool's JSON result payload
     * larger than this (plus `toolOutputGrace` for the JSON wrapper) gets
     * middle-truncated with the shared truncation marker, so the model cannot
     * crash its context window with an oversized file read / web fetch. Unset
     * = the toolkit default (`TOOL_OUTPUT_LIMIT_CHARS`, 50,000).
     */
    toolOutputLimit: z.number().int().min(1).optional(),
    /**
     * Chars allowed beyond `toolOutputLimit` before the fallback cap engages
     * (headroom for result JSON structure: keys, braces, numbers). Unset =
     * the toolkit default (`TOOL_OUTPUT_GRACE_CHARS`, 1,000).
     */
    toolOutputGrace: z.number().int().min(0).optional(),
    /**
     * Agent-user split: the daemon drops its bash worker to this uid/gid
     * with `agentHome` as the agent's HOME. Defaults follow the documented
     * UID scheme (the `yog` daemon is uid 900; agents start at 1100), so a
     * config that omits these keys still runs model-executed code as the
     * agent user — never as the daemon. Equal to the current process =
     * no drop; without CAP_SETUID the drop fails and the worker falls back
     * to the harness user with a logged warning.
     */
    agentUid: z.number().int().min(1).default(DEFAULT_AGENT_UID),
    agentGid: z.number().int().min(1).default(DEFAULT_AGENT_GID),
    agentHome: z.string().min(1).default("/home/agent"),
  })
  .strict();

/** Fully resolved daemon configuration. */
export type YogConfig = z.infer<typeof YogConfigSchema>;

/** Partial configuration: a config file's contents or an injected override. */
export type PartialYogConfig = z.input<typeof YogConfigSchema>;

/**
 * Read a config file. Returns `undefined` when the path does not exist, is a
 * directory (Docker Compose creates an empty directory at the mountpoint
 * when the host file is absent), or is **empty** (a touched file or a
 * leftover) — all are "no config provided". Whitespace-only counts as
 * empty. A present-but-unreadable file is an error — a mounted config the
 * daemon cannot read must fail the startup loudly, not silently fall back
 * to defaults. Malformed JSON also surfaces to the caller (fail loudly).
 */
export async function readConfigFile(path: string): Promise<PartialYogConfig | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    // ENOENT (no file mounted → defaults); anything else (e.g. EACCES on a
    // parent directory) is a real problem and must surface.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return undefined;
    throw new Error(
      `config file at ${path} is not accessible (${code ?? err}): ${(err as Error).message}`,
    );
  }
  if (info.isDirectory()) return undefined;
  let raw: string;
  try {
    raw = (await readFile(path, "utf8")).trim();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw new Error(
      `config file at ${path} cannot be read (${code ?? err}): ${(err as Error).message}`,
    );
  }
  if (raw === "") return undefined; // empty/touched file → defaults
  return JSON.parse(raw) as PartialYogConfig;
}

/**
 * Resolve the daemon configuration: schema defaults ← config file ← explicit
 * injection. The file is a partial: it sets only the keys it contains, and
 * everything else keeps its schema default (the agent split stays enabled
 * even when a config only sets `host`). Validation runs on the merged
 * result, so an override cannot rescue a bad file and a file cannot dodge
 * schema bounds.
 */
export async function resolveConfig(
  opts: { config?: PartialYogConfig; configPath?: string } = {},
): Promise<YogConfig> {
  const fromFile = await readConfigFile(opts.configPath ?? DEFAULT_CONFIG_PATH);
  const merged = { ...fromFile, ...opts.config };
  return YogConfigSchema.parse(merged);
}

/** The worker-pool default: one core reserved for the daemon. */
export function defaultWorkers(): number {
  return Math.max(1, cpus().length - 1);
}
