#!/bin/bash
set -e

# Load credentials from env file (not committed to git)
# Create ~/.kick-api.env with: PI_PASS="your_password"
# Or set up SSH key auth: ssh-copy-id pi@192.168.1.3
ENV_FILE="$HOME/.kick-api.env"
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
else
  echo "Warning: $ENV_FILE not found. Set PI_PASS or use SSH key auth."
  echo "Create it with: echo 'PI_PASS=\"your_password\"' > $ENV_FILE && chmod 600 $ENV_FILE"
fi

PI_HOST="192.168.1.3"
PI_USER="pi"
DEPLOY_DIR="/home/pi/Desktop/kick-api-v4"
CONTAINER_NAME="kick-api-kick-proxy-1"

# Use sshpass if PI_PASS is set, otherwise rely on SSH keys
if [ -n "$PI_PASS" ]; then
  SSH_CMD="sshpass -p $PI_PASS ssh ${PI_USER}@${PI_HOST}"
  RSYNC_CMD="sshpass -p $PI_PASS rsync"
else
  SSH_CMD="ssh ${PI_USER}@${PI_HOST}"
  RSYNC_CMD="rsync"
fi

echo "=== Step 1: Syncing code to Raspberry Pi ==="
$RSYNC_CMD -avz --delete \
  --exclude='venv' \
  --exclude='.DS_Store' \
  --exclude='__pycache__' \
  --exclude='.claude' \
  --exclude='.vscode' \
  --exclude='.git' \
  --exclude='.env' \
  /Users/humanleague/Desktop/kick-api/ \
  ${PI_USER}@${PI_HOST}:${DEPLOY_DIR}/

echo ""
echo "=== Step 2: Stopping old container ==="
$SSH_CMD "cd ${DEPLOY_DIR} && docker compose down 2>/dev/null || true"

echo ""
echo "=== Step 3: Building and starting new container ==="
$SSH_CMD "cd ${DEPLOY_DIR} && docker compose up --build -d"

echo ""
echo "=== Step 4: Waiting for container to start ==="
sleep 8

echo ""
echo "=== Step 5: Health check ==="
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://${PI_HOST}:8081/config/languages)
if [ "$HEALTH" = "200" ]; then
  echo "Health check PASSED (HTTP 200)"
else
  echo "Health check FAILED (HTTP $HEALTH)"
  echo "Checking container logs..."
  $SSH_CMD "docker logs --tail 30 ${CONTAINER_NAME}"
  exit 1
fi

echo ""
echo "=== Step 6: Testing Chromecast endpoints ==="
echo "GET /api/chromecast/status:"
curl -s http://${PI_HOST}:8081/api/chromecast/status | python3 -m json.tool

echo ""
echo "GET /api/chromecast/devices:"
curl -s http://${PI_HOST}:8081/api/chromecast/devices | python3 -m json.tool

echo ""
echo "=== Deployment complete ==="
echo "App running at: http://${PI_HOST}:8081"
echo "Swagger docs:   http://${PI_HOST}:8081/docs"
