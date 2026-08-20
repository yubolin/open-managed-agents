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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "🔨 [0/3] Building Web Console SPA locally on Mac..."
pnpm --filter managed-agents-console build

echo "🚀 [1/3] Preparing remote directory on ${SERVER_USER}@${SERVER_HOST}:${TARGET_DIR}..."
ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "mkdir -p ${TARGET_DIR}/data ${TARGET_DIR}/secrets"

echo "📦 [2/3] Syncing project files to ${SERVER_HOST}:${TARGET_DIR}..."
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

echo "🐳 [3/3] Building and starting Docker Compose containers on ${SERVER_HOST}..."
ssh ${SSH_OPTS} "${SERVER_USER}@${SERVER_HOST}" "
  cd ${TARGET_DIR}
  mkdir -p data/sandboxes data/memory-blobs data/session-outputs data/oma-vault-ca
  chown -R 1000:1000 data
  chmod -R 775 data
  echo 'Starting Docker Compose with PostgreSQL backend...'
  docker compose -f docker-compose.postgres.yml up --build -d --remove-orphans
  echo 'Checking running containers:'
  docker compose -f docker-compose.postgres.yml ps
"

echo "=============================================================================="
echo "✅ OpenMA successfully deployed and started on ${SERVER_HOST}!"
echo "🌐 Web Console:  http://${SERVER_HOST}:5173  (or http://${SERVER_HOST}:8787)"
echo "⚡ API Backend:  http://${SERVER_HOST}:8787"
echo "🔌 CMDB MCP:     http://${SERVER_HOST}:3910"
echo "=============================================================================="
