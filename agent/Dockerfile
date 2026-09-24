FROM oven/bun:1.3.5-debian AS builder

WORKDIR /app

COPY bun.lock package.json ./
COPY agent/package.json ./agent/
COPY packages/runtime/package.json ./packages/runtime/
RUN bun install --frozen-lockfile --filter nouva-agent

COPY agent ./agent
COPY packages/runtime ./packages/runtime

WORKDIR /app/agent
RUN bun run check-types

FROM oven/bun:1.3.5-debian AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    bash \
    ca-certificates \
    gzip \
    rclone \
    redis-server \
    redis-tools \
    tar \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
ARG MONGODB_DATABASE_TOOLS_VERSION=100.18.0
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) mongodb_tools_platform="debian12-x86_64" ;; \
      arm64) mongodb_tools_platform="ubuntu2404-arm64" ;; \
      *) echo "Unsupported MongoDB Database Tools architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mongodb_tools_archive="mongodb-database-tools-${mongodb_tools_platform}-${MONGODB_DATABASE_TOOLS_VERSION}"; \
    curl -fL "https://fastdl.mongodb.org/tools/db/${mongodb_tools_archive}.tgz" -o /tmp/mongodb-database-tools.tgz; \
    tar -xzf /tmp/mongodb-database-tools.tgz -C /tmp; \
    install -m 0755 "/tmp/${mongodb_tools_archive}/bin/mongodump" /usr/local/bin/mongodump; \
    install -m 0755 "/tmp/${mongodb_tools_archive}/bin/mongorestore" /usr/local/bin/mongorestore; \
    rm -rf /tmp/mongodb-database-tools.tgz "/tmp/${mongodb_tools_archive}"

ARG RAILPACK_VERSION=0.23.0
RUN curl -fL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/railpack.tar.gz && \
    tar -xzf /tmp/railpack.tar.gz -C /tmp && \
    mv /tmp/railpack /usr/local/bin/railpack && \
    chmod +x /usr/local/bin/railpack && \
    rm -rf /tmp/railpack.tar.gz /tmp/metadata.json /tmp/checksums.txt

ARG BUILDKIT_VERSION=v0.17.0
RUN curl -sSL "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-amd64.tar.gz" -o /tmp/buildkit.tar.gz && \
    tar -xzf /tmp/buildkit.tar.gz -C /tmp && \
    mv /tmp/bin/buildctl /usr/local/bin/buildctl && \
    chmod +x /usr/local/bin/buildctl && \
    rm -rf /tmp/buildkit.tar.gz /tmp/bin

RUN railpack --version && buildctl --version && mongodump --version && mongorestore --version

WORKDIR /app

COPY bun.lock package.json ./
COPY agent/package.json ./agent/
COPY packages/runtime/package.json ./packages/runtime/
RUN bun install --frozen-lockfile --production --filter nouva-agent

COPY agent ./agent
COPY packages/runtime ./packages/runtime

ARG VCS_REF=local
LABEL org.opencontainers.image.source="https://github.com/nouvalabs/nouva-agent"
LABEL org.opencontainers.image.revision="${VCS_REF}"
LABEL org.opencontainers.image.licenses="Apache-2.0"

ENV NODE_ENV=production

WORKDIR /app/agent
CMD ["bun", "src/index.ts"]
