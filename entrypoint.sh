#!/bin/sh
set -e

# The harness runs as the `yog` daemon user (per the daemon/agent split) but
# must keep the capabilities it needs to spawn its bash worker as the `agent`
# user. A plain `--cap-add` is not enough: a non-root process's capabilities
# are cleared on exec of node, so we transition to yog via setpriv while
# granting ambient CAP_SETUID/CAP_SETGID, which survive that exec and are
# inherited by the worker spawns.
export HOME=/home/yog

# Runtime configuration lives at /var/lib/yog/config.json (mounted read-only
# by the compose manifest) — it is the host operator's file: never chowned,
# never written. A missing, empty, or directory-stub file means "no config":
# the daemon loads pure defaults, which already carry the documented
# agent/daemon split (agent uid/gid 1100, agent HOME /home/agent) —
# model-executed code never runs as the daemon. The bind address is passed
# on the command line below so the published port is reachable from the host
# regardless of what (if anything) is in the config.

# The state volume (/var/lib/yog) may have been created root-owned by Docker
# (fresh named volume) — ensure the daemon can write it no matter its origin,
# without touching the host-owned config file.
mkdir -p /var/lib/yog/agentfs /var/lib/yog/harness
chown -R yog:yog /var/lib/yog/agentfs
# Per-session shell state is written by the agent user (bash workers) and
# pruned by the daemon at start-up: the harness root is agent-owned,
# setgid group-writable (the daemon is in the agent group — see the
# Dockerfile), and per-session dirs inherit that group. Re-assert the
# root's ownership/mode on every start so a fresh volume is usable.
chown agent:agent /var/lib/yog/harness
chmod 2775 /var/lib/yog/harness

# Default command: start the HTTP/SSE daemon (`yog serve`), bound to all
# interfaces so the published port is reachable from the host. Explicit args
# are passed through, so the launcher can run other commands in the same
# image.
if [ "$#" -eq 0 ]; then
  set -- serve --host 0.0.0.0
fi

exec /usr/bin/setpriv \
  --reuid=yog \
  --regid=yog \
  --init-groups \
  --inh-caps=+setuid,+setgid \
  --ambient-caps=+setuid,+setgid \
  node /app/src/index.ts "$@"
