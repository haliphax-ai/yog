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
  mkdir /home/agent && \
  chown agent:agent /home/agent
COPY . /app
RUN cd /app && npm ci --omit=dev --ignore-scripts
WORKDIR /home/agent
USER agent:agent
ENTRYPOINT ["node", "/app/src/index.ts"]
