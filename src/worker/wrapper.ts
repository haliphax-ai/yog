/**
 * The persistent-shell wrapper and its minimal environment builder. These
 * live in the worker layer: the harness daemon never spawns bash directly —
 * it asks the worker, and the worker runs the wrapper.
 *
 * The wrapper gives each bash call a persistent shell home:
 *
 *  - restore the previous call's cwd and exported vars/functions
 *  - source the agent's rc (BASH_ENV, falling back to ~/.bashrc) so every
 *    call starts from the full-fledged home environment
 *  - run the requested script as `eval "$1"` (argv, no string surgery) in
 *    THIS shell so its cd/export/functions mutate the state we capture
 *  - persist cwd + `export -p` + `declare -f` atomically for the next call
 */
export const WRAPPER = `set +e

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
 * Build the minimal environment for a bash child: just the plumbing the shell
 * needs to boot (HOME, a fixed PATH, TERM, TZ) and our own HARNESS_* /
 * BASH_ENV pointers. Everything else the model sees comes from the agent's
 * home rc (BASH_ENV, falling back to ~/.bashrc), which the operator controls.
 * Host env — including credentials — never reaches the tool, and the
 * persisted shell-state snapshot therefore only ever reflects what the agent
 * itself set.
 */
export function buildToolEnv(stateDir?: string): Record<string, string> {
  const out: Record<string, string> = {
    HOME: process.env["HOME"] ?? "/root",
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    TERM: process.env["TERM"] ?? "dumb",
    TZ: process.env["TZ"] ?? "UTC",
  };
  for (const key of ["BASH_ENV", "HARNESS_RC"]) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  const state = stateDir ?? process.env["HARNESS_STATE_DIR"];
  if (state) out["HARNESS_STATE_DIR"] = state;
  return out;
}
