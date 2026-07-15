#!/usr/bin/env bash
# Cross-compile, atomically deploy, and verify the production systemd service.
# The previous version remains available for automatic rollback.
set -euo pipefail
export GOTOOLCHAIN="${GOTOOLCHAIN:-go1.26.5}"

PI_HOST="${PI_HOST:-pi@raspberrypi.local}"
APP_DIR="/opt/kick-api"
SERVICE="kick-api"
PORT="${PORT:-8081}"
ENV_FILE="/etc/kick-api/kick-api.env"

BUILD_ONLY=false
for arg in "$@"; do
  if [[ "$arg" == "--build" ]]; then
    BUILD_ONLY=true
  fi
done

GIT_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"
VERSION="4.0.0-${GIT_COMMIT}"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
  VERSION="${VERSION}-dirty"
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUILD_ID="$(date -u +%Y%m%d%H%M%S)"
BINARY="/tmp/kick-api-arm64-${GIT_COMMIT}"
RELEASE_NAME="kick-api-${VERSION}-${BUILD_ID}"
REMOTE_RELEASE="$APP_DIR/releases/$RELEASE_NAME"
REMOTE_UPLOAD="/tmp/$RELEASE_NAME"
REMOTE_UNIT="/tmp/kick-api.service"

echo "==> Running production preflight checks..."
go mod verify
go vet ./...
go test -race ./...
go run github.com/zricethezav/gitleaks/v8@v8.30.1 git --no-banner --redact .
go run golang.org/x/vuln/cmd/govulncheck@latest ./...

echo "==> Building $VERSION for linux/arm64..."
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 \
  go build -trimpath \
  -ldflags="-s -w -X kickapi/internal/buildinfo.Version=$VERSION -X kickapi/internal/buildinfo.Commit=$GIT_COMMIT -X kickapi/internal/buildinfo.BuiltAt=$BUILT_AT" \
  -o "$BINARY" ./cmd/server

if $BUILD_ONLY; then
  echo "==> Build verified: $BINARY"
  exit 0
fi

CTL="/tmp/kick-deploy-%r@%h:%p"
SSH=(ssh -o ControlMaster=auto -o "ControlPath=$CTL" -o ControlPersist=120 -o StrictHostKeyChecking=accept-new)
cleanup() {
  "${SSH[@]}" -O exit "$PI_HOST" 2>/dev/null || true
  rm -f "$BINARY"
}
trap cleanup EXIT

echo "==> Connecting to $PI_HOST..."
"${SSH[@]}" "$PI_HOST" true

echo "==> Uploading candidate binary and systemd unit..."
rsync -az -e "ssh -o ControlPath=$CTL" "$BINARY" "$PI_HOST:$REMOTE_UPLOAD"
rsync -az -e "ssh -o ControlPath=$CTL" deploy/kick-api.service "$PI_HOST:$REMOTE_UNIT"

echo "==> Preparing service account, state, and protected configuration..."
"${SSH[@]}" "$PI_HOST" "id -u kick-api >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/kick-api --shell /usr/sbin/nologin kick-api"
"${SSH[@]}" "$PI_HOST" "sudo mkdir -p '$APP_DIR/releases' && sudo chmod 0755 '$APP_DIR' '$APP_DIR/releases' && sudo install -d -o kick-api -g kick-api -m 0750 /var/lib/kick-api && sudo install -d -m 0750 '$(dirname "$ENV_FILE")'"
"${SSH[@]}" "$PI_HOST" "if [ -f '$APP_DIR/.kick_chromecast_cache.json' ] && [ ! -f /var/lib/kick-api/chromecast-state.json ]; then sudo install -o kick-api -g kick-api -m 0600 '$APP_DIR/.kick_chromecast_cache.json' /var/lib/kick-api/chromecast-state.json; fi"
if ! "${SSH[@]}" "$PI_HOST" "sudo grep -q '^CONTROL_TOKEN=' '$ENV_FILE' 2>/dev/null"; then
  "${SSH[@]}" "$PI_HOST" "token=\$(openssl rand -hex 16) && printf 'CONTROL_TOKEN=%s\n' \"\$token\" | sudo tee -a '$ENV_FILE' >/dev/null && sudo chmod 0600 '$ENV_FILE'"
  echo "    Created CONTROL_TOKEN in $ENV_FILE (retrieve it with sudo on the Pi)."
fi

PREVIOUS="$("${SSH[@]}" "$PI_HOST" "if [ -e '$APP_DIR/current' ]; then readlink -f '$APP_DIR/current'; elif [ -x '$APP_DIR/kick-api-arm64' ]; then printf '%s' '$APP_DIR/kick-api-arm64'; fi")"
HAD_UNIT="$("${SSH[@]}" "$PI_HOST" "if sudo test -f /etc/systemd/system/kick-api.service; then printf yes; fi")"
if [[ "$HAD_UNIT" == "yes" ]]; then
  "${SSH[@]}" "$PI_HOST" "sudo cp -f /etc/systemd/system/kick-api.service /tmp/kick-api.service.previous"
fi

rollback_remote() {
  echo "    Restoring the previous unit and binary..."
  if [[ "$HAD_UNIT" == "yes" ]]; then
    "${SSH[@]}" "$PI_HOST" "sudo install -o root -g root -m 0644 /tmp/kick-api.service.previous /etc/systemd/system/kick-api.service"
  else
    "${SSH[@]}" "$PI_HOST" "sudo rm -f /etc/systemd/system/kick-api.service"
  fi
  if [[ -n "$PREVIOUS" ]]; then
    "${SSH[@]}" "$PI_HOST" "sudo ln -sfn '$PREVIOUS' '$APP_DIR/current' && sudo systemctl daemon-reload && sudo systemctl restart '$SERVICE'"
  else
    "${SSH[@]}" "$PI_HOST" "sudo systemctl daemon-reload && sudo systemctl stop '$SERVICE'"
  fi
}

echo "==> Installing $REMOTE_RELEASE and switching atomically..."
"${SSH[@]}" "$PI_HOST" "sudo install -o root -g root -m 0755 '$REMOTE_UPLOAD' '$REMOTE_RELEASE' && rm -f '$REMOTE_UPLOAD' && sudo ln -sfn '$REMOTE_RELEASE' '$APP_DIR/current' && sudo install -o root -g root -m 0644 '$REMOTE_UNIT' /etc/systemd/system/kick-api.service && rm -f '$REMOTE_UNIT'"
if ! "${SSH[@]}" "$PI_HOST" "sudo systemd-analyze verify /etc/systemd/system/kick-api.service && sudo systemctl daemon-reload && sudo systemctl enable '$SERVICE' >/dev/null && sudo systemctl restart '$SERVICE'"; then
  echo "    Service activation failed."
  rollback_remote
  exit 1
fi

echo "==> Verifying readiness, assets, configuration, and build identity..."
if "${SSH[@]}" "$PI_HOST" "curl -fsS --retry 20 --retry-connrefused --retry-delay 1 --max-time 5 http://127.0.0.1:$PORT/health/ready >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:$PORT/ >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:$PORT/config/languages >/dev/null && curl -fsS --max-time 5 http://127.0.0.1:$PORT/version | grep -F '\"commit\":\"$GIT_COMMIT\"' >/dev/null"; then
  echo "    Healthy: $VERSION"
else
  echo "    Verification failed; rolling back."
  rollback_remote
  "${SSH[@]}" "$PI_HOST" "sudo journalctl -u '$SERVICE' -n 40 --no-pager" || true
  exit 1
fi

echo "==> Deployment complete."
"${SSH[@]}" "$PI_HOST" "sudo rm -f /tmp/kick-api.service.previous"
"${SSH[@]}" "$PI_HOST" "systemctl show '$SERVICE' -p ActiveState -p MainPID -p ExecMainStartTimestamp"
echo "    Version: $VERSION"
echo "    Logs: ssh $PI_HOST 'journalctl -u $SERVICE -f'"
echo "    Control token: ssh $PI_HOST \"sudo sed -n 's/^CONTROL_TOKEN=//p' $ENV_FILE\""
