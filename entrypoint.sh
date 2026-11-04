#!/bin/sh
set -e

# The harness runs as the `yog` daemon user (per the daemon/agent split) but
# must keep the capabilities it needs to spawn its bash worker as the `agent`
# user. A plain `--cap-add` is not enough: a non-root process's capabilities
# are cleared on exec of node, so we transition to yog via setpriv while
# granting ambient CAP_SETUID/CAP_SETGID, which survive that exec and are
# inherited by the worker spawns.
export HOME=/home/yog

# Runtime configuration lives at /var/lib/yog/config.json (mounted by the
# compose manifest). When no config file was mounted, Docker leaves an empty
# directory there — write container defaults so a config-less container still
# binds 0.0.0.0, runs the agent split, and allows other users on the mount.
# A real config file always wins; adjust it instead of these defaults.
if [ -d /var/lib/yog/config.json ]; then
  rmdir /var/lib/yog/config.json 2>/dev/null || true
  cat > /var/lib/yog/config.json <<'EOF'
{
  "host": "0.0.0.0",
  "port": 8111,
  "mountPoint": "/yog",
  "allowOther": true,
  "stateRoot": "/var/lib/yog",
  "agentUid": 1100,
  "agentGid": 1100,
  "agentHome": "/home/agent",
  "agentStateDir": "/home/agent/.harness"
}
EOF
  chown yog:yog /var/lib/yog/config.json
fi

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
