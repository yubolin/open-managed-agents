#!/usr/bin/env bash
# ==============================================================================
# OpenMA Remote Server Deployment & Synchronization Script (Docker Compose + PG)
# Target: root@117.72.219.106:/opt/openma
# ==============================================================================
set -euo pipefail

SERVER_HOST="${SERVER_HOST:-117.72.219.106}"
SERVER_USER="${SERVER_USER:-root}"
TARGET_DIR="${TARGET_DIR:-/opt/openma}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15"
ALLOW_DIRTY="${ALLOW_DIRTY:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Safety gate: verify clean git working tree unless explicitly bypassed
if [ "${ALLOW_DIRTY}" != "1" ]; then
  if ! git -C "${REPO_ROOT}" diff-index --quiet HEAD --; then
    echo "❌ Error: Working tree has uncommitted changes. Commit or stash them first, or pass ALLOW_DIRTY=1." >&2
    git -C "${REPO_ROOT}" status --short
    exit 1
  fi
fi

GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse HEAD)"
GIT_SHORT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
GIT_BRANCH="$(git -C "${REPO_ROOT}" rev-parse --abbrev-ref HEAD)"

echo "=============================================================================="
echo "🚀 Deploying OpenMA to ${SERVER_HOST} [Git: ${GIT_SHORT_SHA} (${GIT_BRANCH})]"
echo "=============================================================================="

echo "🔨 [0/4] Building Web Console SPA locally on Mac..."
pnpm --filter managed-agents-console build

echo "🚀 [1/4] Preparing remote directory on ${SERVER_USER}@${SERVER_HOST}:${TARGET_DIR}..."
ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ${TARGET_DIR}/data ${TARGET_DIR}/secrets"

echo "📦 [2/4] Syncing project files to ${SERVER_HOST}:${TARGET_DIR}..."
rsync -avz --delete -e "ssh ${SSH_OPTS}" \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.turbo' \
  --exclude '.wrangler-shared' \
  --exclude 'apps/*/.wrangler' \
  --exclude 'apps/main/dist' \
  --exclude 'apps/agent/dist' \
  --exclude 'apps/integrations/dist' \
  --exclude 'apps/docs/dist' \
  --exclude '.env*' \
  --exclude 'secrets/**' \
  --exclude 'data/**' \
  --exclude '.sync-*.sql' \
  --exclude '.vscode' \
  --exclude '.idea' \
  --exclude 'coverage' \
  --exclude '.pnpm-store' \
  "${REPO_ROOT}/" "${SERVER_USER}@${SERVER_HOST}:${TARGET_DIR}/"

# Write deploy version stamp
ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "
  echo 'GIT_COMMIT_SHA=${GIT_SHA}' > ${TARGET_DIR}/.version
  echo 'DEPLOYED_AT=$(date -u +'%Y-%m-%dT%H:%M:%SZ')' >> ${TARGET_DIR}/.version
"

echo "🐳 [3/4] Building and starting Docker Compose containers on ${SERVER_HOST}..."
ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "
  cd ${TARGET_DIR}
  mkdir -p data/sandboxes data/memory-blobs data/session-outputs data/oma-vault-ca
  chown -R 1000:1000 data
  chmod -R 775 data
  echo 'Starting Docker Compose with PostgreSQL backend...'
  docker compose -f docker-compose.postgres.yml up --build -d --remove-orphans
"

echo "🩺 [4/4] Polling container health (http://${SERVER_HOST}:8787/health)..."
READY=0
for i in $(seq 1 30); do
  if curl -s -f --connect-timeout 2 "http://${SERVER_HOST}:8787/health" > /dev/null 2>&1; then
    READY=1
    echo "   ✅ Health check passed (attempt ${i}/30)"
    break
  fi
  echo "   ⏳ Waiting for server startup... (${i}/30)"
  sleep 2
done

if [ "${READY}" -ne 1 ]; then
  echo "❌ Error: oma-server failed health check after 60s." >&2
  ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "cd ${TARGET_DIR} && docker compose -f docker-compose.postgres.yml logs --tail 50 oma-server"
  exit 1
fi

echo "=============================================================================="
echo "✅ OpenMA successfully deployed and verified healthy on ${SERVER_HOST}!"
echo "📌 Deployed Commit: ${GIT_SHORT_SHA} (${GIT_SHA})"
echo "🌐 Web Console:     http://${SERVER_HOST}:5173  (or http://${SERVER_HOST}:8787)"
echo "⚡ API Backend:     http://${SERVER_HOST}:8787"
echo "🔌 CMDB MCP:        http://${SERVER_HOST}:3910"
echo "=============================================================================="
