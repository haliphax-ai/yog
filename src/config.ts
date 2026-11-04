/**
 * Runtime configuration for the yog daemon.
 *
 * Configuration comes from a JSON file (default `/var/lib/yog/config.json`,
 * override with `--config <path>`), merged over zod defaults, with an
 * explicit `Partial<YogConfig>` injection winning last (tests, programmatic
 * callers). There are no environment variables: the daemon's own env is
 * process plumbing, not configuration.
 *
 * The file is optional. A missing file (or a mount stub, which Docker Compose
 * creates as an empty directory when the host file does not exist) resolves
 * to pure defaults; a file that exists but fails to parse or validate throws
 * — a config typo must fail loudly, not silently fall back.
 */
import { z } from "zod";
import { cpus } from "node:os";
import { readFile, stat } from "./host.ts";

/** Default path the daemon reads its configuration from. */
export const DEFAULT_CONFIG_PATH = "/var/lib/yog/config.json";

const host = z.string().min(1).default("127.0.0.1").describe("daemon bind address");
const port = z.number().int().min(0).max(65535).default(8111).describe("daemon port");

/**
 * The daemon configuration schema. Every field has a default or is optional
 * (`undefined` = feature off), so an empty config file yields a working
 * loopback daemon.
 */
export const YogConfigSchema = z
  .object({
    /** HTTP/SSE bind address. */
    host,
    /** HTTP/SSE port. */
    port,
    /** Bearer token for the contract; unset = auth disabled. */
    apiToken: z.string().min(1).optional(),
    /** Grace window (ms) holding the SSE stream open for the terminal abort event. */
    abortGraceMs: z.number().int().min(0).default(2000),
    /** Store queries slower than this (ms) are logged (log-only tripwire). */
    dbSlowMs: z.number().int().min(0).default(50),
    /** State root: `sessions.db` + `agentfs/<agentId>.db`. */
    stateRoot: z.string().min(1).default("/var/lib/yog"),
    /** Full-path override for the agent state db (wins over `stateRoot`). */
    statePath: z.string().min(1).optional(),
    /** Worker pool size for parallel tool execution; unset = max(1, cpus-1). */
    workers: z.number().int().min(1).optional(),
    /** Model id advertised by capabilities and used for turns. */
    model: z.string().min(1).default("gpt-4o-mini"),
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
     * Agent-user split (container): the daemon drops its bash worker to this
     * uid/gid with `home` as the agent's HOME. uid/gid unset (or equal to the
     * current process) = no drop (local development). `stateDir` is the
     * persistent shell snapshot directory handed to the bash tool.
     */
    agentUid: z.number().int().min(1).optional(),
    agentGid: z.number().int().min(1).optional(),
    agentHome: z.string().min(1).default("/home/agent"),
    agentStateDir: z.string().min(1).optional(),
  })
  .strict();

/** Fully resolved daemon configuration. */
export type YogConfig = z.infer<typeof YogConfigSchema>;

/** Partial configuration: a config file's contents or an injected override. */
export type PartialYogConfig = z.input<typeof YogConfigSchema>;

/**
 * Read a config file. Returns `undefined` when the path does not exist or is
 * a directory (Docker Compose creates an empty directory at the mountpoint
 * when the host file is absent — treat that as "no config provided").
 * Throws on unreadable regular files; parse/validation errors surface to the
 * caller (fail loudly).
 */
export async function readConfigFile(path: string): Promise<PartialYogConfig | undefined> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return undefined; // no file → defaults
  }
  if (info.isDirectory()) return undefined;
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PartialYogConfig;
}

/**
 * Resolve the daemon configuration: zod defaults ← config file (when present)
 * ← explicit injection. Validation runs on the merged result, so an override
 * cannot rescue a bad file and a file cannot dodge schema bounds.
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
