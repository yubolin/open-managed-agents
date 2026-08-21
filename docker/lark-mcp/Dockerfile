# syntax=docker/dockerfile:1.7
#
# Feishu/Lark KB MCP sidecar — official @larksuiteoapi/lark-mcp, pinned.
#
# Upstream publishes no image (their docs only build a local :latest), so we
# pin the npm version ourselves. NEVER relax this to @latest or a bare
# `npx -y`: upstream is Beta (0.5.1 as of 2026-08) and the -t tool whitelist
# in CMD below is the ONLY write-isolation boundary — OMA's harness registers
# every tool a server returns (no second-layer enabled_tools filter).
# See docs/integrations/feishu-kb-p0-sds.md before changing anything here.

FROM node:22-slim AS build

# Re-pin deliberately when upgrading (SDS §5 boundary 5).
ARG LARK_MCP_VERSION=0.5.1

WORKDIR /app

RUN (sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list || true) \
  && apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ libsecret-1-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --omit=dev --no-fund --no-audit \
      --registry=https://registry.npmmirror.com \
      "@larksuiteoapi/lark-mcp@${LARK_MCP_VERSION}"

FROM node:22-slim

WORKDIR /app

RUN (sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list || true) \
  && apt-get update \
  && apt-get install -y --no-install-recommends libsecret-1-0 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app /app

ENV NODE_ENV=production

# Non-root. The credential config arrives as a read-only docker secret.
USER node
EXPOSE 3000

# Liveness: ANY http response from the streamable endpoint means the process
# is up (a bare GET normally 4xxs — that's fine, we only care that the
# listener answers).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/mcp').then(()=>process.exit(0)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/node_modules/.bin/lark-mcp"]

# Whitelisted read-only toolset (app identity / tenant_access_token — all four
# verified ['tenant','user'] in lark-mcp source). Credentials come only from
# the mounted secret (--config); app id/secret never appear as CLI args so
# they can't leak via `ps`. Keep this list in sync with
# docker/lark-mcp/config.example.json and the SDS §2 table.
CMD ["mcp", \
     "-m", "streamable", \
     "--host", "0.0.0.0", \
     "-p", "3000", \
     "-c", "snake", \
     "--token-mode", "tenant_access_token", \
     "-t", "wiki.v2.space.list,wiki.v2.spaceNode.list,wiki.v2.space.getNode,docx.v1.document.rawContent", \
     "--config", "/run/secrets/lark-mcp-config"]
