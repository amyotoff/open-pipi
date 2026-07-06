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

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build
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

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY help.md README.md ./

# Run as non-root
USER node

EXPOSE 3000

CMD ["node", "dist/index.js"]
