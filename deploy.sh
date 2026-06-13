#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_REPO_DIR="${LOCAL_REPO_DIR:-$SCRIPT_DIR}"

# Load credentials from env file (not committed to git)
# Create ~/.kick-api.env with:
#   PI_HOST="192.168.68.53"
#   PI_USER="pi"
#   PI_PASS="your_password"
ENV_FILE="$HOME/.kick-api.env"
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
else
  echo "Warning: $ENV_FILE not found. Set PI_HOST and, if needed, PI_PASS manually."
  echo "Create it with: printf 'PI_HOST=\"192.168.68.53\"\\nPI_USER=\"pi\"\\n' > $ENV_FILE && chmod 600 $ENV_FILE"
fi

# Allow positional arguments as a convenience:
#   ./deploy.sh <pi_host> [pi_user] [pi_pass]
PI_HOST="${PI_HOST:-${1:?PI_HOST required}}"
PI_USER="${PI_USER:-${2:-pi}}"
PI_PASS="${PI_PASS:-${3:-}}"

DEPLOY_DIR="${DEPLOY_DIR:-/home/pi/Desktop/kick-api-v4}"
PI_COMPOSE_CMD="${PI_COMPOSE_CMD:-docker compose -f docker-compose.yaml -f docker-compose.pi.yaml}"

# Forward optional Chromecast network overrides to remote compose interpolation.
# This allows per-network fallback subnet tuning from ~/.kick-api.env.
COMPOSE_ENV_PREFIX=""
if [ -n "${CHROMECAST_FALLBACK_SCAN_SUBNETS:-}" ]; then
  printf -v ESCAPED_CHROMECAST_SUBNETS '%q' "${CHROMECAST_FALLBACK_SCAN_SUBNETS}"
  COMPOSE_ENV_PREFIX="CHROMECAST_FALLBACK_SCAN_SUBNETS=${ESCAPED_CHROMECAST_SUBNETS} "
fi

run_remote_compose() {
  local compose_args="$1"
  "${SSH_CMD[@]}" "${PI_USER}@${PI_HOST}" "cd ${DEPLOY_DIR} && ${COMPOSE_ENV_PREFIX}${PI_COMPOSE_CMD} ${compose_args}"
}

# Use sshpass if PI_PASS is set, otherwise rely on SSH keys
if [ -n "${PI_PASS:-}" ]; then
  SSH_CMD=(sshpass -p "$PI_PASS" ssh)
  RSYNC_CMD=(sshpass -p "$PI_PASS" rsync)
else
  SSH_CMD=(ssh)
  RSYNC_CMD=(rsync)
fi

echo "=== Step 1: Syncing code to Raspberry Pi ==="
"${RSYNC_CMD[@]}" -avz --delete \
  --exclude='venv' \
  --exclude='.DS_Store' \
  --exclude='__pycache__' \
  --exclude='.claude' \
  --exclude='.kilo' \
  --exclude='.kilocode' \
  --exclude='.pytest_cache' \
  --exclude='.vscode' \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='docs' \
  "${LOCAL_REPO_DIR}/" \
  "${PI_USER}@${PI_HOST}:${DEPLOY_DIR}/"

echo ""
echo "=== Step 2: Verifying Pi compose networking for Chromecast ==="
NETWORK_MODE=$("${SSH_CMD[@]}" "${PI_USER}@${PI_HOST}" \
  "cd ${DEPLOY_DIR} && ${COMPOSE_ENV_PREFIX}${PI_COMPOSE_CMD} config | awk '/^[[:space:]]*network_mode:/{print \$2; exit}'")
if [ "$NETWORK_MODE" != "host" ]; then
  echo "ERROR: Effective docker compose config is using network_mode='${NETWORK_MODE:-<missing>}'"
  echo "Chromecast discovery requires host networking on Raspberry Pi."
  echo "Check PI_COMPOSE_CMD and docker-compose.pi.yaml on ${PI_HOST}."
  exit 1
fi
echo "Chromecast networking check passed (network_mode: host)."

echo ""
echo "=== Step 3: Stopping old container ==="
run_remote_compose "down 2>/dev/null || true"

echo ""
echo "=== Step 4: Cleaning up old Docker artifacts (frees disk space) ==="
"${SSH_CMD[@]}" "${PI_USER}@${PI_HOST}" "docker image prune -f 2>/dev/null || true; docker builder prune -f 2>/dev/null || true"
DISK_BEFORE=$("${SSH_CMD[@]}" "${PI_USER}@${PI_HOST}" "df -h / | tail -1 | awk '{print \$4}'")
echo "Available disk space: ${DISK_BEFORE}"

echo ""
echo "=== Step 5: Building and starting new container ==="
run_remote_compose "up --build -d"

echo ""
echo "=== Step 6: Post-build cleanup (remove dangling images from this build) ==="
"${SSH_CMD[@]}" "${PI_USER}@${PI_HOST}" "docker image prune -f 2>/dev/null || true"
DISK_AFTER=$("${SSH_CMD[@]}" "${PI_USER}@${PI_HOST}" "df -h / | tail -1 | awk '{print \$4}'")
echo "Available disk space: ${DISK_AFTER}"

echo ""
echo "=== Step 7: Waiting for container to start ==="
sleep 8

echo ""
echo "=== Step 8: Health check ==="
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://${PI_HOST}:8081/health/live)
if [ "$HEALTH" = "200" ]; then
  echo "Health check PASSED (HTTP 200)"
else
  echo "Health check FAILED (HTTP $HEALTH)"
  echo "Checking container logs..."
  run_remote_compose "logs --tail 60 kick-proxy"
  exit 1
fi

echo ""
echo "=== Step 9: Testing Chromecast endpoints ==="
echo "GET /api/chromecast/status:"
curl -s http://${PI_HOST}:8081/api/chromecast/status | python3 -m json.tool

echo ""
echo "GET /api/chromecast/devices:"
curl -s http://${PI_HOST}:8081/api/chromecast/devices | python3 -m json.tool

echo ""
echo "=== Deployment complete ==="
echo "App running at: http://${PI_HOST}:8081"
echo "Swagger docs:   http://${PI_HOST}:8081/docs"
