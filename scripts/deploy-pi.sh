#!/usr/bin/env bash
# deploy-pi.sh — cross-compile the Go server and deploy it to the Pi's
# systemd-managed service.
#
# NOTE: production on the Pi now runs as a Docker container via
# docker-compose.pi.yaml. This systemd path is a DISABLED legacy/rollback option
# kept for emergencies. It deploys the binary under **systemd** (not Docker):
# unit `kick-api.service`, ExecStart=<APP_DIR>/kick-api-arm64, Restart=always,
# with env set in the unit. The binary embeds static/ and templates/ via
# //go:embed, so only the binary is shipped. Re-enabling it conflicts with the
# container on :8081 — stop the container first.
#
# Usage:
#   ./scripts/deploy-pi.sh            # build + deploy + restart + verify
#   ./scripts/deploy-pi.sh --build    # cross-compile only (no deploy)
#
# Install the systemd unit once from deploy/kick-api.service (see README), then:
#
# Env overrides:
#   PI_HOST  SSH target            (default pi@raspberrypi.local)
#   APP_DIR  install dir on host   (default /opt/kick-api; must match the unit's ExecStart)
#   SERVICE  systemd unit name     (default kick-api)
#   PORT     health-check port     (default 8081)
#
# Example:
#   PI_HOST=pi@192.168.1.50 APP_DIR=/opt/kick-api ./scripts/deploy-pi.sh
#
# Assumes the SSH user can run `sudo systemctl restart` (e.g. passwordless sudo).
set -euo pipefail

PI_HOST="${PI_HOST:-pi@raspberrypi.local}"
APP_DIR="${APP_DIR:-/opt/kick-api}"
SERVICE="${SERVICE:-kick-api}"
PORT="${PORT:-8081}"

BUILD_ONLY=false
for arg in "$@"; do [[ "$arg" == "--build" ]] && BUILD_ONLY=true; done

BINARY=/tmp/kick-api-arm64
REMOTE_BIN="$APP_DIR/kick-api-arm64"

# ── 1. Cross-compile (stripped) ───────────────────────────────────────────────
echo "==> Building linux/arm64 binary (stripped)..."
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath -ldflags="-s -w" -o "$BINARY" ./cmd/server
echo "    $(ls -lh "$BINARY" | awk '{print $5, $9}')"

$BUILD_ONLY && { echo "==> Build only (--build set); skipping deploy."; exit 0; }

# ── 2. SSH multiplexing so password auth prompts at most once ─────────────────
CTL="/tmp/kick-deploy-%r@%h:%p"
SSH=(ssh -o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=120 -o StrictHostKeyChecking=accept-new)
cleanup() { "${SSH[@]}" -O exit "$PI_HOST" 2>/dev/null || true; }
trap cleanup EXIT
echo "==> Connecting to $PI_HOST (enter password once if prompted)..."
"${SSH[@]}" "$PI_HOST" true

# ── 3. Back up current binary, sync new one (rsync temp+rename avoids ETXTBSY) ─
echo "==> Backing up current binary → $REMOTE_BIN.bak ..."
"${SSH[@]}" "$PI_HOST" "cp -f '$REMOTE_BIN' '$REMOTE_BIN.bak' 2>/dev/null || true"
echo "==> Syncing new binary to $PI_HOST:$REMOTE_BIN ..."
rsync -az -e "ssh -o ControlPath=$CTL" "$BINARY" "$PI_HOST:$REMOTE_BIN"
"${SSH[@]}" "$PI_HOST" "chmod +x '$REMOTE_BIN'"

# ── 4. Restart via systemd ────────────────────────────────────────────────────
echo "==> Restarting $SERVICE ..."
"${SSH[@]}" "$PI_HOST" "sudo systemctl restart '$SERVICE'"

# ── 5. Health check (auto-rollback on failure) ────────────────────────────────
echo "==> Verifying health on :$PORT ..."
if "${SSH[@]}" "$PI_HOST" "curl -sf --retry 30 --retry-connrefused --retry-delay 0 --max-time 15 -o /dev/null http://127.0.0.1:$PORT/health/live"; then
  echo "    ✓ healthy"
else
  echo "    ✗ health check FAILED — rolling back to previous binary"
  "${SSH[@]}" "$PI_HOST" "cp -f '$REMOTE_BIN.bak' '$REMOTE_BIN' && sudo systemctl restart '$SERVICE'" || true
  exit 1
fi

echo ""
echo "==> Deployed and restarted $SERVICE on $PI_HOST."
"${SSH[@]}" "$PI_HOST" "systemctl show '$SERVICE' -p ActiveState -p MainPID -p ExecMainStartTimestamp 2>/dev/null | sed 's/^/    /'"
echo ""
echo "  Logs:     ssh $PI_HOST 'journalctl -u $SERVICE -f'"
echo "  Rollback: ssh $PI_HOST 'cp $REMOTE_BIN.bak $REMOTE_BIN && sudo systemctl restart $SERVICE'"
