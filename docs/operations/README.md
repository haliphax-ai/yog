# Operations

Running the daemon: CLI, configuration, Docker, state, and environment.

## Usage

```sh
yog serve [--host <addr>] [--port <n>] [--config <path>]   # start the HTTP/SSE daemon
yog skills <list|load|unload|status> [name]                # manage agent skills (offline)
yog calibrate <sessionId> [--config <path>]                # fit a token profile from recorded traffic
```

(or via npm: `npm run start:serve`.)

- `serve` logs the listening URL and runs until SIGINT/SIGTERM (graceful
  shutdown: HTTP → worker pool → store → unmount).
- One-shot client turns are handled by the
  [yog-client-tui](https://github.com/haliphax-ai/yog-client-tui)
  application, which speaks the v1 contract directly (set `serverUrl` in
  the TUI config to the daemon origin).
- All daemon configuration comes from a JSON config file (below); there are
  no environment variables.

## Configuration

The daemon reads one JSON file at startup: `/var/lib/yog/config.json` by
default, overridable with `--config <path>`. The file is optional: a
missing file (or the empty-directory stub Docker Compose creates when the
host file does not exist) yields pure defaults. A file that exists but
fails to parse or validate fails the startup loudly: typos must not
silently fall back.

Resolution order (later wins): zod defaults ← config file ← explicit
injection (`createDaemon({ config })`, used by tests).

| Field                    | Type    | Default                        | Purpose                                                                                                                                                                                                                     |
| ------------------------ | ------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                   | string  | `127.0.0.1`                    | HTTP/SSE bind address                                                                                                                                                                                                       |
| `port`                   | int     | `8111`                         | HTTP/SSE port                                                                                                                                                                                                               |
| `apiToken`               | string? | unset                          | require `Authorization: Bearer …` on the contract                                                                                                                                                                           |
| `dbSlowMs`               | int     | `50`                           | log a warning when a store query exceeds this (log-only tripwire)                                                                                                                                                           |
| `stateRoot`              | string  | `/var/lib/yog`                 | state root (`sessions.db`, `agentfs/<agentId>.db`, `harness/<sessionId>`, `profiles/`, `model-info.json`)                                                                                                                   |
| `statePath`              | string? | derived                        | full-path override for the agent state db                                                                                                                                                                                   |
| `workers`                | int?    | `max(1, cpus - 1)`             | worker pool size for parallel tool execution                                                                                                                                                                                |
| `model`                  | string  | `gpt-4o-mini`                  | model id advertised by capabilities and used for turns                                                                                                                                                                      |
| `modelsDevPath`          | string  | bundled path                   | local models.dev API JSON for context-window lookups                                                                                                                                                                        |
| `compactionModel`        | string? | unset                          | model for compaction/handoff summary turns; unset = session model                                                                                                                                                           |
| `providerBaseUrl`        | string? | SDK default                    | OpenAI-compatible endpoint                                                                                                                                                                                                  |
| `providerApiKey`         | string? | SDK default                    | provider API key                                                                                                                                                                                                            |
| `mountPoint`             | string  | `/yog`                         | FUSE mountpoint                                                                                                                                                                                                             |
| `allowOther`             | bool    | `false`                        | allow other users to reach the mount (container: agent ≠ daemon user)                                                                                                                                                       |
| `maxRoundsPerTurn`       | int     | `200`                          | tool-call rounds allowed per turn before the engine stops it with `turn.finished { stopReason: "max_rounds" }`                                                                                                              |
| `rateLimitMaxAttempts`   | int     | `6`                            | provider 429 retry policy (per round, initial try included); `1` disables retrying                                                                                                                                          |
| `rateLimitBaseDelayMs`   | int     | `1000`                         | first exponential backoff wait (ms) after a 429 with no usable server hint                                                                                                                                                  |
| `rateLimitMaxDelayMs`    | int     | `60000`                        | cap for any single backoff wait (ms), server hints included                                                                                                                                                                 |
| `rateLimitBackoffFactor` | number  | `2`                            | exponential multiplier per failed attempt                                                                                                                                                                                   |
| `toolOutputLimit`        | int?    | unset (toolkit default 50,000) | per-tool serialized output budget in chars (see [harness](../harness/README.md))                                                                                                                                            |
| `toolOutputGrace`        | int?    | unset (toolkit default 1,000)  | chars allowed beyond `toolOutputLimit` before the fallback cap engages                                                                                                                                                      |
| `agentUid` / `agentGid`  | int     | `1100`                         | daemon/agent split: spawn bash workers as this uid/gid (the documented scheme: the `yog` daemon is uid 900, agents start at 1100, so model-executed code never runs as the daemon). Equal to the current process = no drop. |
| `agentHome`              | string  | `/home/agent`                  | HOME and cwd for agent-spawned workers                                                                                                                                                                                      |

Example `config.json`:

```json
{
  "host": "0.0.0.0",
  "port": 8111,
  "model": "my-model",
  "providerBaseUrl": "http://proxy.internal:3000/v1",
  "providerApiKey": "sk-…",
  "maxRoundsPerTurn": 200,
  "apiToken": "share-with-clients"
}
```

The schema is `YogConfigSchema` in `src/config.ts` (zod, `.strict()`:
unknown fields are rejected) and is enforced by `test/config.test.ts`. The
dependency-cruiser rules `config-leaf` and `config-only-at-composition`
keep the loader at the composition root: every other layer receives plain
injected values, which is what makes the daemon testable without a config
file on disk.

## Docker

Build the image and run the daemon through Docker Compose. The compose
manifest starts the daemon container (tini init; the entrypoint runs
`yog serve --host 0.0.0.0`), mounts `./config.json` read-only at
`/var/lib/yog/config.json` (create the host file to configure the daemon;
it is untracked), publishes port 8111 to the host, and waits for
`/v1/capabilities` to answer before accepting turns. When no config file
exists on the host, Compose creates an empty directory at the mountpoint;
the daemon treats that as "no config" and loads pure defaults.

```sh
docker compose up -d --build
# then point any client at it:
docker compose exec yog yog serve --help
```

Customize the base image and runtime with override files:

- `docker-compose.override.yml`: layer additional services, volume mounts,
  config values, or port mappings on top of the base manifest (the config
  file is a plain host mount, so an override can point it anywhere).
- `Dockerfile.local`: build a custom image variant (a different base node
  version, extra packages) and reference it from the override via
  `build: { context: ., dockerfile: Dockerfile.local }`.

### State on disk

The daemon's state lives under the configured `stateRoot` (default
`/var/lib/yog`):

- `sessions.db` — sessions, turns, transcript rows, and stream events
  (sqlite via knex; 30-day retention for dormant sessions).
- `agentfs/<agentId>.db` — the agentfs database: the insert-only
  `tool_calls` audit table and the per-session shell-state mirror.
- `harness/<sessionId>` — the per-session persistent shell state
  (`cwd`/`env`/`functions`), written by the agent user. Both these
  directories and their agentfs mirror rows are pruned at startup after 7
  days untouched.
- `profiles/<model-slug>.json` — token-estimator overlays written by
  `yog calibrate` (see [token-accuracy](../token-accuracy.md)).
- `model-info.json` — the models.dev cache backing context-window lookups.

Mount that path from the host so state persists across runs and
turso/libsql's file locking works (it misbehaves on Docker's overlay
filesystem). If you see `Failed to unlock file: Permission denied`, ensure
the volume mount is present (or set `statePath` to a path on a real
volume). The entrypoint re-owns `/var/lib/yog` to the `yog` user on start,
so a freshly created root-owned named volume is usable immediately.

## Environment requirements

The `fuse-native` addon needs a FUSE device and mount privileges:

- `/dev/fuse` must be present in the container: the compose manifest mounts
  it (`devices: - /dev/fuse:/dev/fuse`).
- The container runs the harness as the non-root `yog` daemon user (stable
  uid 900); its bash worker drops to the non-root `agent` user (the
  daemon/agent split), so model-executed code never runs as the harness
  user. Agents are allocated from a pool starting at uid 1100 (above the
  1000 host-user region); the bootstrap agent is 1100.
- Mounting requires `SYS_ADMIN` and the `fuse` (libfuse2) package so the
  setuid `fusermount` helper exists; both are set up by the image. Mounts
  go through `fusermount` as the `yog` user into `/yog`. The `/yog`
  mountpoint must exist and be readable/searchable by the harness user
  (the image creates and owns it).
- Seccomp runs with a custom profile (`seccomp/yog.json`): Docker's default
  profile plus an unconditional allowance for `mount`/`umount2` (the
  default only allows them with `CAP_SYS_ADMIN`). The compose manifest
  references the file on the host; set seccomp to `unconfined` in a
  `docker-compose.override.yml` to fall back to Docker's default profile.
- The worker's drop to the `agent` user requires the harness process to
  hold effective `CAP_SETUID`/`CAP_SETGID`. The image's entrypoint starts
  as root and uses `setpriv` to drop to the `yog` daemon user while
  granting ambient `CAP_SETUID`/`CAP_SETGID` (a plain `--cap-add` is
  cleared on exec for a non-root process, so the ambient caps are what make
  the split work). The compose manifest adds `SETUID` and `SETGID` to put
  those caps in the container's bounding set.
- The entrypoint defaults to `yog serve` with a container-default config
  (bind `0.0.0.0`, so the published port is reachable from the host); a
  mounted `config.json` always wins.
- `tini` is the container init (PID 1): it reaps zombies and forwards
  signals to the daemon; the entrypoint script runs as its child.
- The compose manifest opts the container out of AppArmor entirely
  (`security_opt: [apparmor=unconfined]`), so no host AppArmor profile,
  default or otherwise, applies to it. Only seccomp still confines it.
- On hosts enforcing seccomp, the default profile blocks mount syscalls,
  so the image is run with:

  ```sh
  docker run --device /dev/fuse \
    --cap-add SYS_ADMIN \
    --cap-add SETUID,SETGID \
    --security-opt seccomp=unconfined \
  ```

All of the above is wired into the `docker-compose.yml` manifest:
`docker compose up -d --build`.

For a bare local run (no container), `fuse-native` bundles its own
`libfuse.so`, but the addon's `DT_NEEDED` entry is `libfuse.so.2`; if no
system libfuse2 is installed, provide it:

```sh
LD_LIBRARY_PATH=$PWD/node_modules/fuse-native/prebuilds/linux-x64 npm start -- …
```

## Scripts

- `npm test` — vitest unit tests (store, schema validation, tool execution,
  descriptor registry, HTTP adapter, network client, conformance); excludes
  the `mount`-tagged suite.
- `npm run test:mount` — runs only the `mount`-tagged live FUSE mount
  integration tests. Requires `/dev/fuse`; fails loudly if the device is
  missing. Excluded from `npm test` by tag.
- `npm run depcruise` — architecture lint via dependency-cruiser (enforces
  the layered module rules; runs in the pre-commit hook).
- `npm run depcruise:graph` — emit the module dependency graph as a Mermaid
  flowchart to stdout.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run start:serve` — start the HTTP/SSE daemon (Node ≥ 22.18 for
  native TypeScript type stripping).
