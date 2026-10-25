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
    && \
  rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 900 agent && \
  useradd --system --uid 900 --gid agent --shell /usr/sbin/nologin agent && \
  groupadd --system --gid 901 yog && \
  useradd --system --uid 901 --gid yog --shell /usr/sbin/nologin yog && \
  mkdir -p /home/agent /yog && \
  chown agent:agent /home/agent /yog && \
  echo "user_allow_other" > /etc/fuse.conf

# The mount root lives at /yog and is served to the agent user. The harness
# may run as the yog (daemon) user and drops its bash worker to the agent on
# spawn; allow_other lets other users reach the mount.
ENV YOG_ALLOW_OTHER=1 \
  YOG_AGENT_UID=900 \
  YOG_AGENT_GID=900
COPY . /app
RUN cd /app && npm ci --omit=dev --ignore-scripts
WORKDIR /home/agent
USER agent:agent
ENTRYPOINT ["node", "/app/src/index.ts"]
