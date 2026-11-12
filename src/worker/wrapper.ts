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
 *  - prepend the session's loaded-skill `scripts/` directories to PATH
 *    (per-run, not persisted — unloading takes effect on the next call)
 *  - run the requested script as `eval "$1"` (argv, no string surgery) in
 *    THIS shell so its cd/export/functions mutate the state we capture
 *  - persist cwd + `export -p` + `declare -f` atomically for the next call
 */

/** The base wrapper: everything except the skill-PATH preamble. */
export const WRAPPER = `set +e

HARNESS_STATE_DIR="\${HARNESS_STATE_DIR:-.harness}"
HARNESS_RC="\${HARNESS_RC:-\${BASH_ENV:-}}"
if [ -z "$HARNESS_RC" ] && [ -f "$HOME/.bashrc" ]; then
  HARNESS_RC="$HOME/.bashrc"
fi

__h_capture() {
  mkdir -p "$HARNESS_STATE_DIR"
  chmod 0775 "$HARNESS_STATE_DIR" 2>/dev/null
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

if [ -f "$HARNESS_STATE_DIR/functions" ]; then
  # shellcheck disable=SC1090
  source "$HARNESS_STATE_DIR/functions" >/dev/null 2>&1 || true
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
__HARNESS_SKILL_PATH__

# The script runs in THIS shell, so its cd/export/functions mutate the very
# state we capture on EXIT — a child bash would throw all of it away.
eval "$1"
`;

/**
 * Compose the wrapper for one bash run, prepending the session's
 * loaded-skill `scripts/` directories to PATH.
 *
 * The preamble runs at eval time — after the persisted snapshot and the
 * agent rc are sourced — so the operator's PATH stays the baseline and the
 * skill scripts win. The result is *not* persisted specially: each run
 * re-derives PATH from the session's currently-loaded skills, so unloading
 * a skill takes effect on the next call (no stale entries, no duplicates).
 */
export function composeWrapper(extraPath: readonly string[] = []): string {
  if (extraPath.length === 0) return WRAPPER.replace("__HARNESS_SKILL_PATH__", "");
  const list = extraPath.map((d) => `'${d.replace(/'/g, `'\\''`)}'`).join(" ");
  const preamble = `
for __h_skill_dir in ${list}; do
  case ":$PATH:" in
    *":$__h_skill_dir:"*) ;;
    *) PATH="$__h_skill_dir:$PATH" ;;
  esac
done
unset __h_skill_dir
export PATH
`;
  return WRAPPER.replace("__HARNESS_SKILL_PATH__", preamble);
}

/**
 * Resolve the shell-state directory to a fixed absolute path. The daemon
 * always supplies the absolute per-session directory
 * (`<stateRoot>/harness/<sessionId>`), which passes through untouched.
 * Relative values (e.g. the bare `.harness` fallback for direct worker
 * callers) resolve against the agent's HOME and must not ride on the
 * wrapper's cwd: the capture trap runs at the shell's *final* cwd —
 * after the script's own `cd` — so a relative dir would scatter the
 * snapshot across every directory the script visited.
 */
export function resolveStateDir(stateDir: string | undefined, agentHome: string): string {
  const raw = stateDir ?? ".harness";
  return raw.startsWith("/") ? raw : `${agentHome}/${raw}`;
}

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
  out["HARNESS_STATE_DIR"] = resolveStateDir(stateDir, process.env["HOME"] ?? "/root");
  return out;
}
