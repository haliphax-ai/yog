# Harness

What the daemon gives agents: the virtual filesystem, the tools, skills,
and the state behind them.

## The virtual filesystem (`/yog`)

The mount contains a single file, `list`, which proxies access to an
in-memory array in the harness process to demonstrate the descriptor tool
concept, plus the `/bin/yog` shim the agent can execute to reach the
daemon's agent-CLI endpoint.

- **read**: outputs the list, one item per line.
- **append open** (`>>`): lines written are added to the list on close.
- **destructive write** (`>` / `O_TRUNC`): written content replaces the
  list on close.
- **delete** (`rm`): always fails; the list is never removable.

Every mutation is logged to stderr as a JSON action record (`append`,
`replace`, `truncate`), so observers can see the descriptor being acted on.

### Permission model

Enforced by the registry; the mount root is `0755` so the kernel does not
pre-empt mutations:

- The `DescriptorRegistry` is the sole guard. Creating non-registered
  entries, unlinking, renaming, and overwriting all resolve against the
  registered descriptors and their capability flags (`CanRead`, `CanWrite`,
  `CanRemove`, `CanRename`, `CanOverwrite`) and optional lifecycle hooks
  (`onRead`, `onWrite`, `onTruncate`, `onDelete`, `onRename`,
  `onOverwrite`, `onChildCreate`, `onChildDelete`, `onChildRename`). No
  hardcoded paths.
- `list` is `0644`, served as owned by the agent user (descriptors default
  to the agent; they may declare their own uid/gid). Appends and
  destructive rewrites work; it lacks `CanRemove` and `CanRename`, so it
  can never be deleted or moved away. It declares `onOverwrite` so
  rename-as-replace content can be written into it.

### Adding a new descriptor tool

Implement `DescriptorFile` (mode, size, `render`, `commit`, `reset`) and
register it, with its mount path, on a `DescriptorRegistry`:

```ts
const descriptors = new DescriptorRegistry(["/myfile", myDescriptor]);
// mountSys(descriptors.buildOps())
```

## Tools

A single tool is provided to agents, `bash`, through which they interact
with a persistent shell and the harness's descriptors:

- **input**: `command: string` (required; no extra fields allowed). The
  command runs via `eval` inside a wrapper shell, giving it full bash
  syntax (pipelines, redirection, builtins, functions) and **persistent
  shell state**: cwd, exported variables, and shell functions carry over
  between calls. Each call starts in the agent's HOME (`agentHome`),
  re-applies the prior snapshot (the prior cwd is `cd`ed into before the
  command runs), and the resulting state is snapshotted (`export -p` +
  `declare -f` + `pwd -P`) into the session's harness dir under the state
  root (`<stateRoot>/harness/<sessionId>`, keyed by session: never the
  agent's HOME and never a single shared dir) after every call. The agent
  rc (`BASH_ENV`, falling back to `~/.bashrc`) is sourced before each
  command as the home baseline. When skills are loaded for the session,
  their `scripts/` directories are prepended to the worker's PATH for that
  call.

  **Host env is hidden from the tool.** Children are spawned with a minimal
  env: `HOME`, a fixed `PATH`, `TERM`, `TZ`, plus `BASH_ENV` and `HARNESS_*`
  plumbing. Everything else the model sees comes from the agent's home rc,
  which the operator controls. The shell-state snapshot therefore reflects
  only what the agent itself set; no secret filtering happens at capture
  time (an agent-set `MY_API_TOKEN` persists fine).

- **output**: `stdout: string | null`, `stderr: string | null`,
  `runtimeMs: number | null`, `exitCode: number | null`.

Every response also carries `error?: string`:

- Schema violations (missing/extra/invalid fields) abort the tool call:
  `error` describes the problem and `stdout`/`stderr`/`exitCode` are null.
- Thrown exceptions are caught and reported the same way.
- Otherwise `error` is absent and the output fields map to the executed
  process (null only if the process could not be spawned).

The bash tool runs in a dedicated worker process (JSONL over stdio, serial
execution because the shell is stateful, SIGTERM forwarded to the running
child so teardown never leaves a shell behind). The pool soft-pins
sessions: the first worker that serves a session becomes its preferred
member while it is free.

### Tool output limiting

The model must not be able to crash its context window with an oversized
tool result (a huge file read, a complex web fetch). Tools are expected to
limit their own output (the `bash` tool middle-truncates its stdout/stderr
streams against a shared budget), and a registry-level fallback covers
every tool:

- Both budgets are measured on JSON-serialized lengths, not raw characters.
  Escaping can inflate a string (a newline, tab, quote, or backslash
  doubles; an ANSI escape or lone surrogate expands 6x), so a 25k-char
  colored build log can serialize to 78k. Raw counts would let
  escape-dense output slip past the cap.
- When a tool's serialized result JSON exceeds `toolOutputLimit` plus
  `toolOutputGrace`, the whole serialized payload is middle-truncated to
  `toolOutputLimit` (in serialized space) and wrapped in a single-field
  `{"truncated": …}` envelope; extra result structure does not survive the
  cut. `originalLength` preserves the payload's true size, and the shipped
  envelope itself stays within `toolOutputLimit + toolOutputGrace`.
- The truncation marker is the same `TRUNCATION_IDENTIFIER` /shake uses, so
  clients and /shake treat the cuts uniformly.

### Adding a harness tool

Implement `ToolSpec<TArgs, TResult>` (definition, validate, failure, run)
and add it to the registry:

```ts
const registry = new ToolRegistry([bashTool, myTool]);
// runTurn(client, modelId, messages, registry)
```

## Skills

The agent-skills subsystem discovers, loads, and unloads
[agentskills.io](https://agentskills.io)-style instruction bundles: a
`SKILL.md` (YAML frontmatter + markdown body) plus an optional
`scripts/`, `references/`, `assets/` package structure. Discovery scans
three sources in priority order (`/var/lib/yog/skills`, `~/.yog/skills`,
`.yog/skills`); bare `<name>.md` files and package directories are both
recognized, and one level of child skills (`<parent>:<child>`) is
supported. Discovery deduplicates by name (first source wins) and skips
invalid skills with a warning; a _loaded_ skill is validated loudly. A
`disable-model-invocation: true` frontmatter key hides the skill from the
agent entirely (list, prompt block) and makes `yog skills load <name>`
refuse it; there is no operator-side way to load these for agents yet.

Loaded skills contribute per session: their instructions are appended to
the system prompt (after the cache-stable prefix), the available-skills
block is appended after that, and each skill's `scripts/` directory is
added to the bash tool's PATH for that session. The agent manages skills
through the `/bin/yog` shim (agent-CLI `skills` command) or the
`skills.*` message types; a daemon built without the skills subsystem
answers those types `500 internal`.

## AgentFS state, audit trail, and the rewindable home

The harness opens an AgentFS database (per agent id under the configured
`stateRoot`; full-path override with `statePath`) at startup:

- Every tool call is recorded in the insert-only `tool_calls` table,
  stamped with a base62 `session_id` extension column, so the model's
  actions are queryable in SQL.
- The persistent bash shell state (cwd/env/functions) is mirrored into the
  database per session (`session:<id>:shell`), making the harness home
  rewindable. Both the `harness/<sessionId>` directories and these mirror
  rows are pruned at daemon startup once untouched for 7 days; there is no
  scheduled reaper.
- Snapshot state with `cp .agentfs/yog.db snapshot.db` (the SDK
  checkpoints WAL on `snapshotTo`); restore by pointing `statePath` at the
  copy.
- Opening/recording failures are non-fatal: the harness logs and continues.

The state layer (`src/state/`) is the only code allowed to import the
agentfs SDK (enforced by dependency-cruiser). The daemon keeps its own
sqlite state (`sessions.db`) under the same `stateRoot`.

## Token accounting

Turns carry usage on three surfaces: per-round `usage` on `tool.result`
(the provider's native counts for that round, when reported), terminal
`usage` on `turn.finished` / `turn.aborted` / `error`, and per-result
`resultTokens` estimates so a client can render context growth before the
next round's native count lands. Estimates come from tokenx with a
profile: a neutral default ships in code, and per-model overlays are
fitted offline from a session's own recorded traffic by
`yog calibrate <sessionId>` (quality-gated; see
[token-accuracy](../token-accuracy.md) for the analysis). Native usage is
authoritative whenever a session has any; the estimator only bridges the
one-round gap and the first round.
