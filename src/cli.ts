/**
 * CLI argument parsing. Pre-1.0 policy is replace-and-delete: the bare
 * `yog <model> <prompt>` form is gone; `yog run <model> <prompt>` is the
 * only entrypoint.
 */

export interface CliArgs {
  modelId: string;
  prompt: string;
}

export interface CliError {
  error: string;
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
