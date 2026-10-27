# Build with: docker build -t yog .
#
# The image's default command starts the HTTP/SSE daemon: the entrypoint runs
# `yog serve` (bound to YOG_HOST=0.0.0.0 so the published port is reachable)
# unless explicit args are passed (the launcher passes `run <model> "<prompt>"`.
FROM node:24
LABEL AUTHOR="haliphax <haliphax@gmail.com>" NAME="yog"
RUN --mount=type=cache,mode=0755,target=/var/cache/apt \
  rm -rf /etc/apt/apt.conf.d/docker-clean && \
  apt-get update -qq && \
  apt-get install -yqq --no-install-recommends \
    ca-certificates \
    curl \
    fuse \
    git \
    gnupg \
    jq \
    ripgrep \
    util-linux \
    && \
  rm -rf /var/lib/apt/lists/*
# UID scheme: the daemon (yog) is the stable id 900; agents are allocated
# from a pool starting at 1100 (above the 1000 host-user region) and will be
# reconciled at runtime as the system grows. The bootstrap agent is the base
# of that pool.
RUN groupadd --system --gid 900 yog && \
  useradd --system --uid 900 --gid yog --shell /usr/sbin/nologin yog && \
  groupadd --gid 1100 agent && \
  useradd --uid 1100 --gid agent --shell /usr/sbin/nologin agent && \
  mkdir -p /home/agent /home/yog /yog /var/lib/yog/agentfs && \
  chown yog:yog /home/yog /yog /var/lib/yog && \
  chown agent:agent /home/agent && \
  echo "user_allow_other" > /etc/fuse.conf

# Daemon/agent split: the harness runs as the `yog` daemon user; its bash
# worker drops to the `agent` user (needs CAP_SETUID/SETGID in the launcher).
# /yog is the FUSE mount root, served to the agent user with allow_other. The
# persistent shell state lives in the agent's home, and the harness's state db
# lives in the daemon's home.
# Server bind: the container must be reachable from outside its netns, so the
# daemon listens on all interfaces (loopback remains the local default).
ENV YOG_ALLOW_OTHER=1 \
  YOG_AGENT_UID=1100 \
  YOG_AGENT_GID=1100 \
  YOG_AGENT_HOME=/home/agent \
  HARNESS_STATE_DIR=/home/agent/.harness \
  YOG_STATE_ROOT=/var/lib/yog \
  YOG_HOST=0.0.0.0 \
  YOG_PORT=8111
COPY . /app
# better-sqlite3 v13 ships its native binding as a prebuild:
#   node_modules/better-sqlite3/prebuilds/linux-x64.node
# (N-API, verified present for node:24/linux-x64), which is why `npm ci` can
# run with --ignore-scripts — no compile happens at install time and the
# addon loads that prebuilt .node directly. If the prebuild is ever missing
# for the target platform, fall back to a node-gyp source build instead:
#   npm rebuild better-sqlite3 --build-from-source
# (needs python3/make/g++ — add them to the apt layer above first).
RUN cd /app && \
  npm ci --omit=dev --ignore-scripts && \
  node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.close(); console.log('[yog] better-sqlite3 prebuild ok')" && \
  chmod +x /app/entrypoint.sh
WORKDIR /home/yog
# The daemon's state database lives in /var/lib/yog (dedicated runtime data
# dir, not a home) — place it on a volume (see the `yog` launcher) so
# turso's file locking works and state persists.
VOLUME ["/var/lib/yog"]
# The container starts as root only so the entrypoint can setpriv down to the
# `yog` daemon user with ambient CAP_SETUID/CAP_SETGID (needed to spawn the
# bash worker as the `agent` user). The harness itself never runs as root.
# With no args the entrypoint runs `yog serve`; explicit args (e.g.
# `run <model> "<prompt>"`) are passed through to the CLI.
ENTRYPOINT ["/app/entrypoint.sh"]