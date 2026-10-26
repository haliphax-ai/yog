# Build with: docker build -t yog .
#
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
RUN groupadd --system --gid 900 agent && \
  useradd --system --uid 900 --gid agent --shell /usr/sbin/nologin agent && \
  groupadd --system --gid 901 yog && \
  useradd --system --uid 901 --gid yog --shell /usr/sbin/nologin yog && \
  mkdir -p /home/agent /home/yog /yog && \
  chown agent:agent /home/agent && \
  chown yog:yog /home/yog /yog && \
  echo "user_allow_other" > /etc/fuse.conf

# Daemon/agent split: the harness runs as the `yog` daemon user; its bash
# worker drops to the `agent` user (needs CAP_SETUID/SETGID in the launcher).
# /yog is the FUSE mount root, served to the agent user with allow_other. The
# persistent shell state lives in the agent's home, and the harness's state db
# lives in the daemon's home.
ENV YOG_ALLOW_OTHER=1 \
  YOG_AGENT_UID=900 \
  YOG_AGENT_GID=900 \
  YOG_AGENT_HOME=/home/agent \
  HARNESS_STATE_DIR=/home/agent/.harness
COPY . /app
RUN cd /app && npm ci --omit=dev --ignore-scripts && chmod +x /app/entrypoint.sh
WORKDIR /home/yog
# The container starts as root only so the entrypoint can setpriv down to the
# `yog` daemon user with ambient CAP_SETUID/CAP_SETGID (needed to spawn the
# bash worker as the `agent` user). The harness itself never runs as root.
ENTRYPOINT ["/app/entrypoint.sh"]
