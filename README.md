# fuse-overlay-harness

An agent harness that mounts a virtual FUSE directory and runs a streaming
OpenAI-compatible chat completion with tools.

## Usage

```sh
npm start -- <modelId> "<prompt>"
```

- Streams the model response to stdout and exits when the stream ends.
- Uses `OPENAI_BASE_URL` / `OPENAI_API_KEY` environment variables when set
  (compatible-proxy support), otherwise the SDK defaults.

## Layout

- `src/index.ts` — CLI entry: parses `modelId` + `prompt`, mounts `./sys`,
  runs the streaming completion with tool-calling loop, exits.
- `src/store.ts` — the in-memory `string[]` backing the virtual file.
- `src/fs.ts` — FUSE operations for the mount (see semantics below).
- `src/mount.ts` — mount/unmount helpers.
- `src/tools.ts` — tool registry, JSON-schema validation, and the `bash` tool.
- `src/fuse-native.d.ts` — ambient typings for the untyped `fuse-native` package.

## Virtual filesystem (`./sys`)

The mount contains a single file, `tool`, a window onto the harness's
in-memory list:

- **read** — outputs the list, one item per line.
- **append open** (`>>`) — lines written are added to the list on close.
- **destructive write** (`>` / O_TRUNC) — written content replaces the list
  on close.
- **delete** (`rm`) — always fails with `EPERM`; the list is never removable.

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
- **output**: `stdout: string | null`, `stderr: string | null`,
  `runtimeMs: number | null`, `exitCode: number | null`.

Every response also carries `error?: string`:

- schema violations (missing/extra/invalid fields) abort the tool call —
  `error` describes the problem and `stdout`/`stderr`/`exitCode` are `null`;
- thrown exceptions are caught and reported the same way;
- otherwise `error` is absent and the output fields map to the executed
  process (null only if the process could not be spawned).

### Virtual filesystem action log

Every mutation of `sys/tool` is logged to **stderr** via `console.error`, so
observers can see the descriptor being acted on:

- append: `{ action: 'append' }`
- destructive rewrite: `{ action: 'replace', items: [...] }` (contents after
  the action)
- standalone truncate: `{ action: 'truncate', items: [...] }`
- rejected delete: `{ action: 'unlink', error: 'EPERM' }`

## Environment requirements

The `fuse-native` addon needs:

1. `/dev/fuse` in the container: `docker run --device /dev/fuse ...`
2. mount capability: `--cap-add SYS_ADMIN` (and typically running as root,
   or an installed setuid `fusermount`)
3. the `fuse` (libfuse2) package so `fusermount` exists

`fuse-native` bundles its own `libfuse.so`, but the addon's `DT_NEEDED` entry
is `libfuse.so.2`; if no system libfuse2 is installed, provide it:

```sh
LD_LIBRARY_PATH=$PWD/node_modules/fuse-native/prebuilds/linux-x64 npm start -- ...
```

If mounting fails, the harness logs a warning and continues without `./sys`.

## Scripts

- `npm test` — vitest unit tests (store, schema validation, tool execution)
- `npm run typecheck` — `tsc --noEmit` (TypeScript 7.x)
- `npm start -- <modelId> "<prompt>"` — run the harness (Node ≥ 22.18 for
  native TypeScript type stripping)