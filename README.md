# yog

An agent harness that mounts a virtual FUSE directory and runs a streaming
OpenAI-compatible chat completion with a single tool: `bash`. System features
are presented to agents as proxied virtual file descriptors.

## Usage

The harness entrypoint is `yog run <modelId> "<prompt>"` (pre-1.0
replace-and-delete: the bare `yog <model> <prompt>` form is gone).

```sh
npm start -- run <modelId> "<prompt>"
```

- Streams the model response to stdout and exits when the stream ends.
- Uses `OPENAI_BASE_URL` / `OPENAI_API_KEY` environment variables when set
  (compatible-proxy support), otherwise the SDK defaults.
- Runs the `bash` tool through a dedicated worker process; the persistent
  shell state is mirrored into the agentfs database (see below).

### Docker

Build the image and run through the bundled launcher, which runs the image
under the `yog` AppArmor profile and forwards `OPENAI_BASE_URL` /
`OPENAI_API_KEY`:

```sh
docker build -t yog .
./yog "<prompt>"
```

`./yog` defaults the model to `nvidia/nemotron-3-ultra-550b-a55b:free`;
place a model id in a `model` file (host cwd) to override it.

## Layout

<details><summary>Files</summary><br />

- `src/`
  - `cli.ts` - CLI arg parsing: the `run` subcommand (the bare form is
    deleted).
  - `index.ts` - CLI entry: parses args via `cli.ts`, opens the agent state,
    mounts `/yog`, runs the agent turn engine, exits.
  - `turn.ts` - agent turn engine: streams completions, executes tool calls,
    feeds results back until the model answers without tools.
  - `mount.ts` — mount/unmount helpers (accepts any `FuseOps`).
  - `host.ts` - host proxy: the only sanctioned path for descriptors
    and tools to touch the host - filesystem **and** subprocess spawning
    (direct `node:fs` / `node:child_process` imports elsewhere are blocked by
    dependency-cruiser).
  - `fuse-native.d.ts` - ambient typings for the untyped `fuse-native` package.
  - `vfs/`
    - `index.ts` — shared descriptor-tool plumbing: `DescriptorFile`
      interface + `DescriptorRegistry` (open/create fd handling, write
      buffering, commit-on-release, truncate, unlink denial, errno
      constants). Registry paths are assigned at registration time, not
      inside the descriptor.
    - `descriptors/list.ts` — the list descriptor (`ListDescriptor`) backing
      the `sys/list` file.
  - `toolkit/`
    - `index.ts` — shared harness-tool plumbing: `ToolResult`,
      `ToolSpec<TArgs, TResult>`, JSON-schema validation, and the
      `ToolRegistry`.
    - `tools/bash.ts` — the `bash` harness tool (persistent shell state, env
      hiding; executes through the worker).
  - `worker/`
    - `protocol.ts` — JSONL wire protocol (requests/responses, shell snapshot).
    - `wrapper.ts` — persistent-shell wrapper + minimal env builder.
    - `client.ts` — daemon-side worker client (spawn, id-correlated responses).
    - `main.ts` — worker entrypoint (runs bash on behalf of the harness).
  - `state/`
    - `agentfs.ts` — `AgentFSState` wrapper: audit recorder, snapshots, and
      the agentfs-backed shell home. The only module that imports the agentfs
      SDK.
    - `session.ts` — base62 session id generation.
- `apparmor/`
  - `yog.profile` - the `yog` AppArmor profile to load on the host.
- `Dockerfile` - container image: node:24, a non-root `agent` user, and the
  `fuse`/CLI packages.
- `yog` - Docker launcher: runs the image under the `yog` AppArmor profile,
  with the FUSE device, `SYS_ADMIN`, and unconfined seccomp.

</details>

<details><summary>Dependency graph</summary><div><br />

![Dependency graph](https://raw.githubusercontent.com/haliphax-ai/yog/refs/heads/assets/dependencies.jpg)
</div></details>

### Adding a new descriptor tool

Implement `DescriptorFile` (mode, size, `render`, `commit`, `reset`) and
register it - with its mount path - on a `DescriptorRegistry`:

```ts
const descriptors = new DescriptorRegistry(["/myfile", myDescriptor]);
// mountSys(descriptors.buildOps())
```

### Adding a new harness tool

Implement `ToolSpec<TArgs, TResult>` (definition, validate, failure, run) and
add it to the registry:

```ts
const registry = new ToolRegistry([bashTool, myTool]);
// runTurn(client, modelId, messages, registry)
```

## Virtual filesystem (`/yog`)

The mount contains a single file, `list`, which proxies access to an in-memory
array in the harness process to demonstrate the descriptor tool concept:

- **read** - outputs the list, one item per line.
- **append open** (`>>`) - lines written are added to the list on close.
- **destructive write** (`>` / O_TRUNC) - written content replaces the list
  on close.
- **delete** (`rm`) - always fails; the list is never removable.

### Permission model

Enforced by the registry; the mount root is `0755` so the kernel does not
pre-empt mutations:

- The `DescriptorRegistry` is the sole guard: creating non-registered entries,
  unlinking, renaming, and overwriting all resolve against the registered
  descriptors and their capability flags (`CanRead`, `CanWrite`,
  `CanRemove`, `CanRename`, `CanOverwrite`) and optional lifecycle hooks
  (`onRead`, `onWrite`, `onTruncate`, `onDelete`, `onRename`,
  `onOverwrite`, `onChildCreate`, `onChildDelete`, `onChildRename`). No
  hardcoded paths.
- `list` is `0644`, served as owned by the agent user (descriptors default
  to the agent; they may declare their own uid/gid) - appends and destructive
  rewrites work; it lacks `CanRemove` and `CanRename`, so it can never be
  deleted or moved away. It declares `onOverwrite` so rename-as-replace
  content can be written into it.

## Tools

A single tool is provided to agents - `bash` - through which they interact with
a persistent shell **and the harness's descriptors**:

- **input**: `script: string` (required; no extra fields allowed). The
  script runs via `eval` inside a wrapper shell, giving it full bash syntax -
  pipelines, redirection, builtins, functions - and **persistent shell state**:
  cwd, exported variables, and shell functions carry over between calls.
  The agent rc (`BASH_ENV`, falling back to `~/.bashrc`) is sourced before
  each script as the home baseline, and the resulting state is snapshotted
  (`export -p` + `declare -f` + `pwd -P`) into the state dir (default
  `.harness/`, override with `HARNESS_STATE_DIR`) after every call.

  **Host env is hidden from the tool**: children are spawned with a minimal
  env - `HOME`, a fixed `PATH`, `TERM`, `TZ`, plus `BASH_ENV` and
  `HARNESS_*` plumbing. Everything else the model sees comes from the agent's
  home rc, which the operator controls. The shell-state snapshot therefore
  reflects only what the agent itself set; no secret filtering happens at
  capture time (an agent-set `MY_API_TOKEN` persists fine).

- **output**: `stdout: string | null`, `stderr: string | null`,
  `runtimeMs: number | null`, `exitCode: number | null`.

Every response also carries `error?: string`:

- schema violations (missing/extra/invalid fields) abort the tool call -
  `error` describes the problem and `stdout`/`stderr`/`exitCode` are `null`;
- thrown exceptions are caught and reported the same way;
- otherwise `error` is absent and the output fields map to the executed
  process (null only if the process could not be spawned).

### Virtual filesystem action log

Every mutation of `sys/list` is logged to **stderr** via `console.error`, so
observers can see the descriptor being acted on:

- append: `{ action: 'append', items: [...] }` (contents after the action)
- destructive rewrite: `{ action: 'replace', items: [...] }` (contents after
  the action)
- standalone truncate: `{ action: 'truncate', items: [...] }`
- rejected delete: `{ action: 'unlink', error: 'EPERM' }`

### AgentFS state, audit trail, and rewindable home

The harness opens an AgentFS database (default `.agentfs/yog.db`, override
with `YOG_STATE_DB`) at startup:

- Every tool call is recorded in the insert-only `tool_calls` table, stamped
  with a base62 `session_id` extension column — the model's actions are
  queryable in SQL.
- The persistent bash shell state (cwd/env/functions) is mirrored into the
  database per session (`session:<id>:shell`), making the harness home
  rewindable.
- Snapshot state with `cp .agentfs/yog.db snapshot.db` (the SDK checkpoints
  WAL on `snapshotTo`); restore by pointing `YOG_STATE_DB` at the copy.
- Opening/recording failures are non-fatal: the harness logs and continues.

The state layer (`src/state/`) is the only code allowed to import the agentfs
SDK (enforced by dependency-cruiser).

## Environment requirements

The `fuse-native` addon needs a FUSE device and mount privileges:

- `/dev/fuse` must be present in the container: `--device /dev/fuse`.
- The container runs the harness as the non-root `yog` daemon user (stable
  uid 900); its bash worker drops to the non-root `agent` user (the
  daemon/agent split), so model-executed code never runs as the harness
  user. Agents are allocated from a pool starting at uid 1100 (above the
  1000 host-user region); the bootstrap agent is 1100.
- Mounting requires `--cap-add SYS_ADMIN`, and the `fuse` (libfuse2)
  package so the setuid `fusermount` helper exists; both are set up by the
  image. Mounts go through `fusermount` as the `yog` user into `/yog`.
- Seccomp is enabled with a custom profile (`seccomp/yog.json`): Docker's
  default profile plus an unconditional allowance for `mount`/`umount2`
  (the default only allows them with CAP_SYS_ADMIN, so this is belt-and-
  suspenders for the FUSE mount). The launcher references the file on the
  host; set `YOG_SECCOMP=unconfined` to fall back to the old behavior.
- The worker's drop to the `agent` user requires the harness process to hold
  effective `CAP_SETUID`/`CAP_SETGID`. The image's entrypoint starts as root
  and uses `setpriv` to drop to the `yog` daemon user while granting ambient
  `CAP_SETUID`/`CAP_SETGID` (a plain `--cap-add` is cleared on exec for a
  non-root process, so the ambient caps are what make the split work). The
  launcher still adds `--cap-add SETUID` and `--cap-add SETGID` to put those
  caps in the container's bounding set.
- The harness's state database is daemon-owned runtime data — it lives under
  a dedicated root, `/var/lib/yog` (`YOG_STATE_ROOT`), in per-agent files:
  `/var/lib/yog/agentfs/<agentId>.db`. Agent identity is a runtime value
  (currently the default `agent`), never an env var — multi-agent
  orchestration opens one database per agent id. Set `YOG_STATE_PATH` for a
  full path override (the launcher passes it through). The `/yog` mountpoint
  must exist and be readable/searchable by the harness user (the image
  creates and owns it).
- The entrypoint re-owns `/var/lib/yog` (the state volume) to the `yog`
  user on start, so a freshly-created root-owned named volume is usable
  immediately.
- `/var/lib/yog` (which holds the state db) is mounted as the named volume
  `yog-state` by the launcher; set `YOG_STATE_BIND=/host/path` to bind-mount
  a host directory there instead. A volume/bind mount is required in
  practice: the turso/libsql native binding's file locking fails with
  `Failed to unlock file: Permission denied` when the database sits on
  Docker's overlay filesystem. If you see that panic, ensure the volume mount
  is present (or set `YOG_STATE_DB` to a path on a real volume); to confirm
  the cause, rerun with `--security-opt apparmor=unconfined` — AppArmor
  denies would disappear there, whereas an overlay-filesystem problem would
  not.
- On hosts enforcing AppArmor/seccomp, the default profiles block mount
  syscalls. The image is therefore run with:

  ```sh
  docker run --device /dev/fuse \
    --cap-add SYS_ADMIN \
    --cap-add SETUID,SETGID \
    --security-opt seccomp=unconfined \
    --security-opt apparmor=yog \
    ...
  ```

  `apparmor=yog` references an AppArmor profile named `yog` that must be
  loaded on the host before the container starts. The profile is checked in
  at `apparmor/yog.profile` and must be kept in sync with the home/mount
  paths (agent + daemon homes, `/yog`, and `capability setuid/setgid` for
  the worker drop):

  ```sh
  ./apparmor/install.sh          # copies, reloads, and verifies the profile
  # equivalent manually:
  # sudo cp apparmor/yog.profile /etc/apparmor.d/yog
  # sudo apparmor_parser -r -W /etc/apparmor.d/yog
  # sudo aa-status | grep yog    # confirms it is loaded
  ```

All of the above is wired into the bundled `yog` launcher:

```sh
docker build -t yog .
./yog "<prompt>"
```

For a bare local run (no container), `fuse-native` bundles its own
`libfuse.so`, but the addon's `DT_NEEDED` entry is `libfuse.so.2`; if no
system libfuse2 is installed, provide it:

```sh
LD_LIBRARY_PATH=$PWD/node_modules/fuse-native/prebuilds/linux-x64 npm start -- ...
```

If mounting fails, the harness logs a warning and continues without `/yog`.

## Scripts

- `npm test` - vitest unit tests (store, schema validation, tool execution,
  descriptor registry); excludes the `mount`-tagged suite.
- `npm run test:mount` - runs **only** the `mount`-tagged live FUSE mount
  integration tests (`test/mount.test.ts`). Requires `/dev/fuse`; fails
  loudly if the device is missing. Excluded from `npm test` by tag.
- `npm run depcruise` - architecture lint via dependency-cruiser (enforces
  the layered module rules; runs in the pre-commit hook)
- `npm run depcruise:graph` - emit the module dependency graph as a Mermaid
  flowchart to stdout
- `npm run typecheck` - `tsc --noEmit` (TypeScript 7.x)
- `npm start -- <modelId> "<prompt>"` - run the harness (Node ≥ 22.18 for
  native TypeScript type stripping)
