# ---- Build stage ----
FROM node:24-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN pnpm build

# ---- Development stage ----
# Keeps devDependencies, npm and corepack, because this is the image that runs
# nodemon and ts-node. docker-compose.dev.yml mounts ./src over the copy baked
# in above, so edits on the host restart the process in the container.
#
# Nothing else should use this image: it carries a compiler toolchain and a
# package manager, which is exactly what the runtime stage below strips out.
FROM builder AS dev
ENV NODE_ENV=development
CMD ["pnpm", "dev"]

# ---- Pruned dependency tree ----
# Split from the builder so the dev stage above can keep its devDependencies.
# Pruning inside the builder would take them from both.
FROM builder AS pruned
RUN pnpm prune --prod --ignore-scripts

# ---- Runtime stage ----
FROM node:24-slim

# System deps for network tools (used by net-debug and network skills)
RUN apt-get update && apt-get install -y --no-install-recommends \
    iputils-ping \
    net-tools \
    nmap \
    tcpdump \
    traceroute \
    dnsutils \
    iproute2 \
    procps \
    bluez \
    rfkill \
    ca-certificates \
    libgnutls30 \
    && rm -rf /var/lib/apt/lists/*

# The runtime starts with `node dist/index.js` and never installs anything, so
# npm is dead weight here — and it vendors its own dependency tree, which is
# where the image's CVEs keep coming from (CVE-2026-59873 in npm's bundled tar
# being the current one). Dropping it removes the whole class.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY --from=pruned /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY help.md README.md ./

# Run as non-root
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
