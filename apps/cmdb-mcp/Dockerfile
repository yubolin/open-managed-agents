# syntax=docker/dockerfile:1.7
#
# CMDB MCP Connector — self-host standalone service.

FROM node:22-slim AS deps

RUN (sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list || true) \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpm-approve-builds.json* ./
COPY apps/cmdb-mcp/package.json apps/cmdb-mcp/
COPY apps/oma-vault/package.json apps/oma-vault/
COPY apps/main-node/package.json apps/main-node/
COPY apps/main/package.json apps/main/
COPY apps/agent/package.json apps/agent/
COPY apps/integrations/package.json apps/integrations/
COPY apps/console/package.json apps/console/
COPY apps/docs/package.json apps/docs/
COPY packages packages

RUN corepack enable \
  && pnpm config set registry https://registry.npmmirror.com \
  && pnpm install --frozen-lockfile

COPY apps/cmdb-mcp apps/cmdb-mcp
COPY tsconfig.json ./

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM node:22-slim AS runtime

RUN corepack enable && corepack prepare pnpm@11.0.8 --activate
WORKDIR /app

COPY --from=deps /app /app

RUN mkdir -p /app/certs && chown -R node:node /app/certs

ENV NODE_ENV=production
ENV PORT=3910
ENV NODE_EXTRA_CA_CERTS=/app/certs/cmdb-ca.crt

EXPOSE 3910
USER node
WORKDIR /app/apps/cmdb-mcp

CMD ["pnpm", "start"]
