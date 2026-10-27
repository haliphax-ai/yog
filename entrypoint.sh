#!/bin/sh
set -e

# The harness runs as the `yog` daemon user (per the daemon/agent split) but
# must keep the capabilities it needs to spawn its bash worker as the `agent`
# user. A plain `--cap-add` is not enough: a non-root process's capabilities
# are cleared on exec of node, so we transition to yog via setpriv while
# granting ambient CAP_SETUID/CAP_SETGID, which survive that exec and are
# inherited by the worker spawns.
export HOME=/home/yog

# Server bind: inside the container the daemon must be reachable from the
# host via the published port, so it listens on all interfaces. YOG_HOST is
# exported only as a default — an explicit `-e YOG_HOST=...` on `docker run`
# overrides it (docker -e wins over ENV in the image).
export YOG_HOST="${YOG_HOST:-0.0.0.0}"

# The state volume (/var/lib/yog) may have been created root-owned by Docker
# (fresh named volume) — ensure the daemon can write it no matter its origin.
mkdir -p /var/lib/yog/agentfs
chown -R yog:yog /var/lib/yog

# Default command: start the HTTP/SSE daemon (`yog serve`). Explicit args
# are passed through, so the launcher can run the one-shot client in the
# same image (`entrypoint.sh run <model> "<prompt>"`).
if [ "$#" -eq 0 ]; then
  set -- serve
fi

exec /usr/bin/setpriv \
  --reuid=yog \
  --regid=yog \
  --init-groups \
  --inh-caps=+setuid,+setgid \
  --ambient-caps=+setuid,+setgid \
  node /app/src/index.ts "$@"