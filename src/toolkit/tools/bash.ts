import { spawn } from "../../host.ts";
import { z } from "zod";
import { type ToolResult, type ToolSpec } from "../index.ts";

export interface BashResult extends ToolResult {
  stdout: string | null;
  stderr: string | null;
  runtimeMs: number | null;
  exitCode: number | null;
}

export interface BashArgs extends Record<string, unknown> {
  script: string;
}

/**
 * Wrapper that gives each bash tool call a persistent shell home:
 *
 *  - restore the previous call's cwd and exported vars/functions
 *  - source the agent's rc (BASH_ENV, falling back to ~/.bashrc) so every
 *    call starts from the full-fledged home environment
 *  - run the requested script as `eval "$1"` (argv, no string surgery) in
 *    THIS shell so its cd/export/functions mutate the state we capture
 *  - persist cwd + `export -p` + `declare -f` atomically for the next call
 */
const WRAPPER = `set +e

HARNESS_STATE_DIR="\${HARNESS_STATE_DIR:-.harness}"
HARNESS_RC="\${HARNESS_RC:-\${BASH_ENV:-}}"
if [ -z "$HARNESS_RC" ] && [ -f "$HOME/.bashrc" ]; then
  HARNESS_RC="$HOME/.bashrc"
fi

__h_capture() {
  mkdir -p "$HARNESS_STATE_DIR"
  pwd -P > "$HARNESS_STATE_DIR/cwd.tmp" 2>/dev/null && mv -f "$HARNESS_STATE_DIR/cwd.tmp" "$HARNESS_STATE_DIR/cwd" 2>/dev/null
  {
    # No filtering here: the spawn env was already minimal, so this snapshot
    # contains only what the agent itself set — killing anything with a
    # "token"-looking name would destroy agent-owned state for no benefit.
    export -p
    declare -f
  } > "$HARNESS_STATE_DIR/env.tmp" 2>/dev/null && mv -f "$HARNESS_STATE_DIR/env.tmp" "$HARNESS_STATE_DIR/env" 2>/dev/null
}

__h_finish() {
  local __h_rc=$?
  __h_capture
  trap - EXIT
  exit "$__h_rc"
}

trap __h_finish EXIT

if [ -f "$HARNESS_STATE_DIR/env" ]; then
  # shellcheck disable=SC1090
  source "$HARNESS_STATE_DIR/env" >/dev/null 2>&1 || true
fi

if [ -f "$HARNESS_STATE_DIR/cwd" ]; then
  __h_cwd=$(cat "$HARNESS_STATE_DIR/cwd" 2>/dev/null)
  if [ -n "$__h_cwd" ] && [ -d "$__h_cwd" ]; then
    cd -- "$__h_cwd" 2>/dev/null
  fi
fi

if [ -n "$HARNESS_RC" ] && [ -f "$HARNESS_RC" ]; then
  # shellcheck disable=SC1090
  source "$HARNESS_RC" >/dev/null || true
fi

# The script runs in THIS shell, so its cd/export/functions mutate the very
# state we capture on EXIT — a child bash would throw all of it away.
eval "$1"
`;

/**
 * The bash tool is spawned with a near-empty environment — just the plumbing
 * the shell needs to boot (HOME, a fixed PATH, TERM, TZ) and our own
 * HARNESS_* / BASH_ENV pointers. Everything else the model sees comes from the
 * agent's home rc (BASH_ENV, falling back to ~/.bashrc), which the operator
 * controls. Host env — including credentials — never reaches the tool, and
 * the persisted shell-state snapshot therefore only ever reflects what the
 * agent itself set. No name/value pattern matching is needed; there is
 * nothing to hide because nothing was passed.
 */
function buildToolEnv(): Record<string, string> {
  const out: Record<string, string> = {
    HOME: process.env["HOME"] ?? "/root",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TERM: process.env["TERM"] ?? "dumb",
    TZ: process.env["TZ"] ?? "UTC",
  };
  for (const key of ["BASH_ENV", "HARNESS_STATE_DIR", "HARNESS_RC"]) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  return out;
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: string;
}

function execBash(script: string): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("bash", ["-c", WRAPPER, "harness", script], {
        cwd: process.cwd(),
        env: buildToolEnv(),
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => errOut.push(d));

    let settled = false;
    const settle = (outcome: ExecOutcome) => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    child.on("error", (err) => {
      settle({ stdout: "", stderr: "", exitCode: null, spawnError: err.message });
    });

    child.on("close", (code) => {
      settle({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8"),
        exitCode: code,
      });
    });
  });
}

export const bashTool: ToolSpec<BashArgs, BashResult> = {
  name: "bash",
  description:
    "Run a bash script in a persistent shell environment. " +
    "cwd, exported variables, and shell functions persist between calls; " +
    "the agent rc (BASH_ENV or ~/.bashrc) is sourced as the baseline. " +
    "stdout/stderr/exitCode map to the shell process; they are null (with " +
    "`error` set) if the call failed validation or threw.",

  schema: z
    .object({
      script: z.string().describe("A bash script to execute."),
    })
    .strict(),

  failure(error: string): BashResult {
    return { stdout: null, stderr: null, runtimeMs: null, exitCode: null, error };
  },

  async run(args): Promise<BashResult> {
    const start = performance.now();
    const outcome = await execBash(args.script);
    const runtimeMs = Math.round(performance.now() - start);
    if (outcome.spawnError !== undefined) {
      return { stdout: null, stderr: null, runtimeMs, exitCode: null, error: outcome.spawnError };
    }
    return {
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      runtimeMs,
      exitCode: outcome.exitCode,
    };
  },
};
