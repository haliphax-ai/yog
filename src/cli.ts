/**
 * CLI argument parsing. Pre-1.0 policy is replace-and-delete: the bare
 * `yog <model> <prompt>` form is gone; `yog run <model> <prompt>` is the
 * only entrypoint for one-shot turns, and `yog serve` starts the daemon.
 */

export interface CliArgs {
  modelId: string;
  prompt: string;
}

export interface CliError {
  error: string;
}

/** Parsed `yog serve` invocation. Undefined fields mean "use env/default". */
export interface ServeArgs {
  host?: string;
  port?: number;
}

/** Parse `process.argv`-style args into a run invocation. */
export function parseCliArgs(argv: readonly string[]): CliArgs | CliError {
  const [subcommand, modelId, ...promptParts] = argv;
  if (subcommand !== "run") {
    return { error: `unknown subcommand "${subcommand ?? ""}" (expected "run")` };
  }
  if (!modelId) {
    return { error: "missing model id" };
  }
  if (promptParts.length === 0) {
    return { error: "missing prompt" };
  }
  return { modelId, prompt: promptParts.join(" ") };
}

/**
 * Parse `process.argv`-style args for the `serve` subcommand: the optional
 * `--host <addr>` and `--port <n>` flags (also accepted as `--host=` /
 * `--port=`). Invalid ports are rejected so a typo fails fast instead of
 * silently binding the default.
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
    if (arg === "--host" || arg === "--port") {
      value = next();
      if (value === undefined) {
        return { error: `missing value for ${arg}` };
      }
    } else if (arg.startsWith("--host=")) {
      value = arg.slice("--host=".length);
    } else if (arg.startsWith("--port=")) {
      value = arg.slice("--port=".length);
    } else {
      return { error: `unknown option "${arg}" for serve (expected --host or --port)` };
    }
    if (arg.startsWith("--host")) {
      if (value === "") {
        return { error: "empty value for --host" };
      }
      out.host = value;
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
