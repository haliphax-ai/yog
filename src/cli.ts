/**
 * CLI argument parsing.
 *
 * The only subcommand is `serve`, which starts the long-lived HTTP/SSE
 * daemon. One-shot client turns are handled by the external
 * [yog-client-tui](https://github.com/haliphax-ai/yog-client-tui)
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
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const next = (): string | undefined => rest[++i];
    let value: string | undefined;
    if (arg === "--host" || arg === "--port" || arg === "--config") {
      value = next();
      if (value === undefined) {
        return { error: `missing value for ${arg}` };
      }
    } else if (arg.startsWith("--host=")) {
      value = arg.slice("--host=".length);
    } else if (arg.startsWith("--port=")) {
      value = arg.slice("--port=".length);
    } else if (arg.startsWith("--config=")) {
      value = arg.slice("--config=".length);
    } else {
      return {
        error: `unknown option "${arg}" for serve (expected --host, --port, or --config)`,
      };
    }
    if (arg.startsWith("--host")) {
      if (value === "") {
        return { error: "empty value for --host" };
      }
      out.host = value;
    } else if (arg.startsWith("--config")) {
      if (value === "") {
        return { error: "empty value for --config" };
      }
      out.config = value;
    } else {
      const port = Number.parseInt(value, 10);
      if (!Number.isFinite(port) || port < 0 || port > 65535 || String(port) !== value.trim()) {
        return { error: `invalid port "${value}" (expected 0-65535)` };
      }
      out.port = port;
    }
  }
  return out;
}
