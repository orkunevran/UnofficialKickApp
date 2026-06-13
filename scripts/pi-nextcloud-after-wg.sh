#!/bin/sh
set -eu

CONTAINER="${CONTAINER:-nextcloud}"
IFACE="${IFACE:-wg0}"
ADDR="${ADDR:-10.0.0.2}"
TIMEOUT="${TIMEOUT:-180}"
DEPENDENCIES="${DEPENDENCIES:-nextcloud_db nextcloud_redis}"
HEALTH_GRACE="${HEALTH_GRACE:-90}"
NETWORK="${NETWORK:-nextcloud_nextcloud_default}"

wait_until() {
  label="$1"
  shift
  deadline=$(($(date +%s) + TIMEOUT))

  while :; do
    if "$@"; then
      return 0
    fi

    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "Timed out waiting for $label" >&2
      return 1
    fi

    sleep 2
  done
}

has_wireguard_addr() {
  ip -4 addr show dev "$IFACE" | grep -q "$ADDR/"
}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null || echo false)" = "true" ]
}

container_health() {
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo missing
}

container_on_network() {
  docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$1" 2>/dev/null | grep -qx "$NETWORK"
}

ensure_container_network() {
  container="$1"

  if [ -z "$NETWORK" ] || ! container_running "$container"; then
    return 0
  fi

  if container_on_network "$container"; then
    return 0
  fi

  echo "Connecting $container to $NETWORK"
  docker network connect "$NETWORK" "$container"
}

container_ready() {
  health=$(container_health "$1")

  if [ "$health" = "healthy" ] || [ "$health" = "none" ]; then
    container_running "$1"
    return
  fi

  return 1
}

wait_container_ready() {
  container="$1"
  wait_until "$container to be ready" container_ready "$container"
}

wait_container_health_grace() {
  container="$1"
  deadline=$(($(date +%s) + HEALTH_GRACE))

  while :; do
    health=$(container_health "$container")
    if [ "$health" = "healthy" ] || [ "$health" = "none" ]; then
      return 0
    fi

    if [ "$(date +%s)" -ge "$deadline" ]; then
      return 1
    fi

    sleep 2
  done
}

wait_until "$IFACE to have $ADDR" has_wireguard_addr

for dependency in $DEPENDENCIES; do
  wait_container_ready "$dependency"
done

ensure_container_network "$CONTAINER"

if container_ready "$CONTAINER"; then
  echo "$CONTAINER already running"
  exit 0
fi

if container_running "$CONTAINER"; then
  if wait_container_health_grace "$CONTAINER"; then
    echo "$CONTAINER became ready"
    exit 0
  fi

  echo "$CONTAINER is running but not ready after dependencies; restarting"
  docker restart "$CONTAINER"
  exit 0
fi

echo "Starting $CONTAINER after $IFACE and dependencies are ready"
docker start "$CONTAINER"
ensure_container_network "$CONTAINER"
