#!/bin/sh
set -e

# The harness runs as the `yog` daemon user (per the daemon/agent split) but
# must keep the capabilities it needs to spawn its bash worker as the `agent`
# user. A plain `--cap-add` is not enough: a non-root process's capabilities
# are cleared on exec of node, so we transition to yog via setpriv while
# granting ambient CAP_SETUID/CAP_SETGID, which survive that exec and are
# inherited by the worker spawns.
export HOME=/home/yog

exec /usr/bin/setpriv \
  --reuid=yog \
  --regid=yog \
  --init-groups \
  --inh-caps=+setuid,+setgid \
  --ambient-caps=+setuid,+setgid \
  node /app/src/index.ts "$@"
