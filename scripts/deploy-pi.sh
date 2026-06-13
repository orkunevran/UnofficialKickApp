#!/usr/bin/env bash
# deploy-pi.sh — cross-compile the Go server for the Pi and deploy it.
#
# Usage:
#   ./scripts/deploy-pi.sh            # build + deploy + restart
#   ./scripts/deploy-pi.sh --build    # build only (skip rsync / restart)
#
# Environment:
#   PI_HOST  — SSH target, default pi@192.168.1.3
#   PI_BASE  — base dir on Pi, default /home/pi/Desktop
#
set -euo pipefail

PI_HOST="${PI_HOST:-pi@192.168.1.3}"
PI_BASE="${PI_BASE:-/home/pi/Desktop}"
BUILD_ONLY=false

for arg in "$@"; do
  [[ "$arg" == "--build" ]] && BUILD_ONLY=true
done

VERSION="v$(date +%Y%m%d-%H%M%S)"
DEPLOY_DIR="$PI_BASE/kick-api-$VERSION"
BINARY=/tmp/kick-api-arm64

# ── 1. Cross-compile ─────────────────────────────────────────────────────────
echo "==> Building linux/arm64 binary..."
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags="-s -w" -o "$BINARY" ./cmd/server
echo "    $(ls -lh "$BINARY" | awk '{print $5, $9}')"

$BUILD_ONLY && { echo "==> Build complete (--build flag set, skipping deploy)."; exit 0; }

# ── 2. Rsync to versioned directory ─────────────────────────────────────────
echo "==> Creating $DEPLOY_DIR on Pi..."
ssh "$PI_HOST" "mkdir -p $DEPLOY_DIR"

echo "==> Syncing files..."
rsync -az --progress \
  "$BINARY" \
  static/ templates/ docker-compose.yaml docker-compose.pi.yaml \
  "$PI_HOST:$DEPLOY_DIR/"

# Copy .env if present
[[ -f .env ]] && rsync -az .env "$PI_HOST:$DEPLOY_DIR/.env"

ssh "$PI_HOST" "chmod +x $DEPLOY_DIR/kick-api-arm64"

# ── 3. Smoke-test on an alternate port, then cut over ────────────────────────
echo "==> Running smoke test on Pi (port 8082)..."
ssh "$PI_HOST" bash <<REMOTE
set -euo pipefail
cd $DEPLOY_DIR

# Start on port 8082 to avoid clashing with the running Python container.
PORT=8082 ./kick-api-arm64 &
NEW_PID=\$!
trap "kill \$NEW_PID 2>/dev/null; exit 1" ERR

sleep 3

if PORT=8082 ./kick-api-arm64 -healthcheck 2>/dev/null; then
  echo "  ✓ healthcheck passed"
else
  echo "  ✗ healthcheck FAILED — aborting; existing service untouched"
  kill \$NEW_PID
  exit 1
fi
kill \$NEW_PID
trap - ERR
REMOTE

echo "==> Smoke test passed. Cutting over..."
ssh "$PI_HOST" bash <<REMOTE
set -euo pipefail

# Stop the existing Python container.
OLD_DIR=\$(ls -td $PI_BASE/kick-api-v* 2>/dev/null | grep -v "$VERSION" | head -1 || echo "")
if [[ -n "\$OLD_DIR" && -f "\$OLD_DIR/docker-compose.yaml" ]]; then
  echo "  Stopping previous service in \$OLD_DIR"
  cd "\$OLD_DIR"
  docker compose down 2>/dev/null || true
fi

# Start the Go binary directly with a restart wrapper via nohup.
cd $DEPLOY_DIR
nohup ./kick-api-arm64 > kick-api.log 2>&1 &
echo \$! > kick-api.pid
sleep 3

if ./kick-api-arm64 -healthcheck 2>/dev/null; then
  echo "  ✓ Go server is up on port 8081 (PID \$(cat kick-api.pid))"
else
  echo "  ✗ Go server failed to start — check $DEPLOY_DIR/kick-api.log"
  exit 1
fi
REMOTE

echo ""
echo "==> Deployed $VERSION"
echo ""
echo "  Health: curl http://192.168.1.3:8081/health/live"
echo "  Metrics: curl http://192.168.1.3:8081/metrics"
echo "  Logs:   ssh $PI_HOST 'tail -f $DEPLOY_DIR/kick-api.log'"
echo ""
echo "  Rollback (restart Python container from previous dir):"
echo "    ssh $PI_HOST 'kill \$(cat $DEPLOY_DIR/kick-api.pid); cd <prev-dir> && docker compose up -d'"
