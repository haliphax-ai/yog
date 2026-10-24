# yog

An agent harness that mounts a virtual FUSE directory and runs a streaming
OpenAI-compatible chat completion with a single tool: `bash`. System features
are presented to agents as proxied virtual file descriptors.

## Usage

```sh
npm start -- <modelId> "<prompt>"
```

- Streams the model response to stdout and exits when the stream ends.
- Uses `OPENAI_BASE_URL` / `OPENAI_API_KEY` environment variables when set
  (compatible-proxy support), otherwise the SDK defaults.

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

- `src/index.ts` — CLI entry: parses `modelId` + `prompt`, mounts `./sys`,
  runs the agent turn engine, exits.
- `src/turn.ts` — agent turn engine: streams completions, executes tool calls,
  feeds results back until the model answers without tools.
- `src/mount.ts` — mount/unmount helpers (accepts any `FuseOps`).
- `src/fs/index.ts` — shared descriptor-tool plumbing: `DescriptorFile`
  interface + `DescriptorRegistry` (open/create fd handling, write buffering,
  commit-on-release, truncate, unlink denial, errno constants). Registry paths
  are assigned at registration time, not inside the descriptor.
- `src/fs/list.ts` — the list descriptor (`ListDescriptor`) backing the
  `sys/list` file.
- `src/host/index.ts` — host proxy: the only sanctioned path for descriptors
  and tools to touch the host — filesystem **and** subprocess spawning
  (direct `node:fs` / `node:child_process` imports elsewhere are blocked by
  dependency-cruiser).
- `src/tools/index.ts` — shared harness-tool plumbing: `ToolResult`,
  `ToolSpec<TArgs, TResult>`, JSON-schema validation, and the `ToolRegistry`.
- `src/tools/bash.ts` — the `bash` harness tool (persistent shell state, env
  hiding).
- `src/fuse-native.d.ts` — ambient typings for the untyped `fuse-native` package.
- `Dockerfile` — container image: node:24, a non-root `agent` user, and the
  `fuse`/CLI packages.
- `yog` — Docker launcher: runs the image under the `yog` AppArmor profile,
  with the FUSE device, `SYS_ADMIN`, and unconfined seccomp.
- `apparmor/yog.profile` — the `yog` AppArmor profile to load on the host.

### Adding a new descriptor tool

Implement `DescriptorFile` (mode, size, `render`, `commit`, `reset`) and
register it — with its mount path — on a `DescriptorRegistry`:

```ts
const descriptors = new DescriptorRegistry([['/myfile', myDescriptor]])
// mountSys(descriptors.buildOps())
```

### Adding a new harness tool

Implement `ToolSpec<TArgs, TResult>` (definition, validate, failure, run) and
add it to the registry:

```ts
const registry = new ToolRegistry([bashTool, myTool])
// runTurn(client, modelId, messages, registry)
```

## Virtual filesystem (`./sys`)

The mount contains a single file, `list`, a window onto the harness's
in-memory list:

- **read** — outputs the list, one item per line.
- **append open** (`>>`) — lines written are added to the list on close.
- **destructive write** (`>` / O_TRUNC) — written content replaces the list
  on close.
- **delete** (`rm`) — always fails; the list is never removable.

Permission model (enforced by the registry; the mount root is `0755` so the
kernel does not pre-empt mutations):

- The `DescriptorRegistry` is the sole guard: creating non-registered entries,
  unlinking, renaming, and overwriting all resolve against the registered
  descriptors and their capability flags (`CanRead`, `CanWrite`,
  `CanRemove`, `CanRename`, `CanOverwrite`) and optional lifecycle hooks
  (`onRead`, `onWrite`, `onTruncate`, `onDelete`, `onRename`,
  `onOverwrite`, `onChildCreate`, `onChildDelete`, `onChildRename`). No
  hardcoded paths.
- `list` is `0644`, owned by the harness user — appends and destructive
  rewrites work; it lacks `CanRemove` and `CanRename`, so it can never be
  deleted or moved away. It declares `onOverwrite` so rename-as-replace
  content can be written into it.

## Tools

A single model tool for starters, `bash`:

- **input**: `script: string` (required; no extra fields allowed). The
  script runs via `eval` inside a wrapper shell, giving it full bash syntax —
  pipelines, redirection, builtins, functions — and **persistent shell state**:
  cwd, exported variables, and shell functions carry over between calls.
  The agent rc (`BASH_ENV`, falling back to `~/.bashrc`) is sourced before
  each script as the home baseline, and the resulting state is snapshotted
  (`export -p` + `declare -f` + `pwd -P`) into the state dir (default
  `.harness/`, override with `HARNESS_STATE_DIR`) after every call.

  **Host env is hidden from the tool**: children are spawned with a minimal
  env — `HOME`, a fixed `PATH`, `TERM`, `TZ`, plus `BASH_ENV` and
  `HARNESS_*` plumbing. Everything else the model sees comes from the agent's
  home rc, which the operator controls. The shell-state snapshot therefore
  reflects only what the agent itself set; no secret filtering happens at
  capture time (an agent-set `MY_API_TOKEN` persists fine).
- **output**: `stdout: string | null`, `stderr: string | null`,
  `runtimeMs: number | null`, `exitCode: number | null`.

Every response also carries `error?: string`:

- schema violations (missing/extra/invalid fields) abort the tool call —
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

## Environment requirements

The `fuse-native` addon needs a FUSE device and mount privileges:

- `/dev/fuse` must be present in the container: `--device /dev/fuse`.
- Mounting requires `--cap-add SYS_ADMIN`, and the `fuse` (libfuse2)
  package so the setuid `fusermount` helper exists — both are set up by the
  image. The container runs as the non-root `agent` user; mounts go through
  `fusermount`.
- On hosts enforcing AppArmor/seccomp, the default profiles block mount
  syscalls. The image is therefore run with:

  ```sh
  docker run --device /dev/fuse \
    --cap-add SYS_ADMIN \
    --security-opt seccomp=unconfined \
    --security-opt apparmor=yog \
    ...
  ```

  `apparmor=yog` references an AppArmor profile named `yog` that must be
  loaded on the host before the container starts. The profile is checked in
  at `apparmor/yog.profile`:

  ```sh
  sudo apparmor_parser -r -W apparmor/yog.profile
  sudo aa-status | grep yog   # confirms it is loaded
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

If mounting fails, the harness logs a warning and continues without `./sys`.

## Scripts

- `npm test` — vitest unit tests (store, schema validation, tool execution,
  descriptor registry); excludes the `mount`-tagged suite.
- `npm run test:mount` — runs **only** the `mount`-tagged live FUSE mount
  integration tests (`test/mount.test.ts`). Requires `/dev/fuse`; fails
  loudly if the device is missing. Excluded from `npm test` and the pre-push
  hook by tag.
- `npm run depcruise` — architecture lint via dependency-cruiser (enforces
  the layered module rules; runs in the pre-commit hook)
- `npm run depcruise:graph` — render the module dependency graph to
  `docs/architecture.svg` (requires graphviz `dot`; manual, not in the hook)
- `npm run typecheck` — `tsc --noEmit` (TypeScript 7.x)
- `npm start -- <modelId> "<prompt>"` — run the harness (Node ≥ 22.18 for
  native TypeScript type stripping)
