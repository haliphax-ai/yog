/**
 * CLI argument parsing.
 *
 * Two subcommands exist: `serve`, which starts the long-lived HTTP/SSE
 * daemon, and `calibrate <sessionId>`, which fits a token-accuracy profile
 * for a session's model from its recorded traffic (server/calibrate-cli.ts).
 * One-shot client turns are handled by the external
 * application, which speaks the v1 HTTP/SSE contract directly.
 */

export interface CliError {
  error: string;
}

/** Parsed `yog serve` invocation. Undefined fields mean "use config/default". */
export interface ServeArgs {
  host?: string;
  port?: number;
  /** Config file path override (default: /var/lib/yog/config.json). */
  config?: string;
}

/** Kinds of flags `serve` accepts, shared by every parser helper. */
type ServeFlag = "host" | "port" | "config";

/** The inline-value prefixes of the `serve` flags, e.g. `--port=`. */
const INLINE_PREFIXES = ["--host=", "--port=", "--config="] as const;

/** Parse the rest of an inline value, e.g. the `8111` in `--port=8111`. */
function inlineValue(arg: string, prefix: string): string {
  return arg.slice(prefix.length);
}

/** The flag an argument names, or `undefined` when it names none. */
function flagOf(arg: string): ServeFlag | undefined {
  const bare = ["--host", "--port", "--config"].find((f) => arg === f);
  if (bare !== undefined) return bare.slice(2) as ServeFlag;
  const inline = INLINE_PREFIXES.find((p) => arg.startsWith(p));
  return inline === undefined ? undefined : (inline.slice(2, -1) as ServeFlag);
}

/** Parse and validate the numeric value of a `--port` argument. */
function parsePortValue(value: string): number | CliError {
  const port = Number.parseInt(value, 10);
  const canonical = String(port);
  if (!Number.isFinite(port) || port < 0 || port > 65535 || canonical !== value.trim()) {
    return { error: `invalid port "${value}" (expected 0-65535)` };
  }
  return port;
}

/** Store a non-empty `--host`/`--config` value, else a descriptive error. */
function storeTextValue(out: ServeArgs, flag: ServeFlag, value: string): CliError | undefined {
  if (value === "") {
    return { error: `empty value for --${flag}` };
  }
  out[flag === "host" ? "host" : "config"] = value;
  return undefined;
}

/**
 * Parse `process.argv`-style args for the `serve` subcommand: the optional
 * `--host <addr>`, `--port <n>`, and `--config <path>` flags (also accepted
 * as `--host=` / `--port=` / `--config=`). Invalid ports are rejected so a
 * typo fails fast instead of silently binding the default.
 */
export function parseServeArgs(argv: readonly string[]): ServeArgs | CliError {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "serve") {
    return { error: `unknown subcommand "${subcommand ?? ""}" (expected "serve")` };
  }
  const out: ServeArgs = {};
  for (const cursor: { n: number } = { n: 0 }; cursor.n < rest.length; cursor.n++) {
    const error = applyServeArg(out, rest, cursor);
    if (error !== undefined) return error;
  }
  return out;
}

/** Consume one flag at `cursor.n` (advancing past an inline value). */
function applyServeArg(
  out: ServeArgs,
  argv: readonly string[],
  cursor: { n: number },
): CliError | undefined {
  const arg = argv[cursor.n]!;
  const next = (): string | undefined => argv[++cursor.n];
  const flag = flagOf(arg);
  if (flag === undefined) {
    return {
      error: `unknown option "${arg}" for serve (expected --host, --port, or --config)`,
    };
  }
  const value = arg.startsWith(`--${flag}=`) ? inlineValue(arg, `--${flag}=`) : next();
  if (value === undefined) {
    return { error: `missing value for ${arg}` };
  }
  if (flag === "port") {
    const port = parsePortValue(value);
    if (typeof port !== "number") return port;
    out.port = port;
    return undefined;
  }
  return storeTextValue(out, flag, value);
}
