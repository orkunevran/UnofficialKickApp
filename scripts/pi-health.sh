#!/usr/bin/env bash
# pi-health.sh — Raspberry Pi health snapshot.
#
# Runs a battery of checks and prints a green/yellow/red verdict for each.
# Designed to be safe to run on demand or via cron (e.g., daily at 03:00).
#
# Usage:
#   ./pi-health.sh              # interactive — colourised output
#   ./pi-health.sh --json       # machine-readable JSON, one object per check
#   ./pi-health.sh --quiet      # only output if something is yellow/red
#
# Exit code: 0 if all green, 1 if any yellow, 2 if any red.
# Requires (on the Pi): smartmontools, mmc-utils, iotop, vcgencmd.

set -u

# ── Output style ────────────────────────────────────────────────────────────
MODE="text"
QUIET=0
for arg in "$@"; do
  case "$arg" in
    --json)  MODE="json" ;;
    --quiet) QUIET=1 ;;
    --help|-h)
      sed -n '2,15p' "$0"
      exit 0
      ;;
  esac
done

if [ -t 1 ] && [ "$MODE" = "text" ]; then
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  GREEN=""; YELLOW=""; RED=""; DIM=""; RESET=""
fi

WORST=0  # 0=green, 1=yellow, 2=red
RESULTS=()

emit() {
  # emit <level> <check> <value> <note>
  local level="$1" check="$2" value="$3" note="${4:-}"
  case "$level" in
    green)  [ "$WORST" -lt 0 ] && WORST=0 ;;
    yellow) [ "$WORST" -lt 1 ] && WORST=1 ;;
    red)    WORST=2 ;;
  esac
  if [ "$MODE" = "json" ]; then
    RESULTS+=("{\"level\":\"$level\",\"check\":\"$check\",\"value\":\"$value\",\"note\":\"$note\"}")
  elif [ "$QUIET" -eq 1 ] && [ "$level" = "green" ]; then
    return
  else
    local colour
    case "$level" in
      green)  colour="$GREEN"  ;;
      yellow) colour="$YELLOW" ;;
      red)    colour="$RED"    ;;
    esac
    printf "%s%-7s%s  %-30s  %s%s%s\n" "$colour" "[$level]" "$RESET" "$check" "$value" "$DIM" "${note:+— $note}$RESET"
  fi
}

# ── Checks ──────────────────────────────────────────────────────────────────

# CPU temperature
if command -v vcgencmd >/dev/null 2>&1; then
  TEMP=$(vcgencmd measure_temp 2>/dev/null | sed -E "s/temp=([0-9.]+).*/\1/")
  THROTTLED=$(vcgencmd get_throttled 2>/dev/null | sed -E "s/throttled=//")
  if [ -n "$TEMP" ]; then
    INT_TEMP=${TEMP%.*}
    if   [ "$INT_TEMP" -lt 70 ]; then emit green  cpu_temp     "${TEMP}°C"
    elif [ "$INT_TEMP" -lt 80 ]; then emit yellow cpu_temp     "${TEMP}°C" "approaching throttle threshold"
    else                              emit red    cpu_temp     "${TEMP}°C" "thermal throttle imminent"
    fi
  fi
  if [ -n "${THROTTLED:-}" ]; then
    if [ "$THROTTLED" = "0x0" ]; then
      emit green throttling "$THROTTLED" "no throttle events"
    else
      emit yellow throttling "$THROTTLED" "see https://www.raspberrypi.com/documentation/computers/os.html#get_throttled"
    fi
  fi
fi

# Root filesystem usage
ROOT_PCT=$(df / | awk 'NR==2 {gsub("%",""); print $5}')
ROOT_FREE=$(df -h / | awk 'NR==2 {print $4}')
if   [ "$ROOT_PCT" -lt 80 ]; then emit green  disk_root "${ROOT_PCT}% used, ${ROOT_FREE} free"
elif [ "$ROOT_PCT" -lt 90 ]; then emit yellow disk_root "${ROOT_PCT}% used, ${ROOT_FREE} free" "investigate large files"
else                              emit red    disk_root "${ROOT_PCT}% used, ${ROOT_FREE} free" "near full — risk of OS instability"
fi

# Any data-mount filesystem (e.g., HDD on /mnt)
while read -r MOUNT PCT FREE; do
  [ -z "$MOUNT" ] && continue
  if   [ "$PCT" -lt 80 ]; then emit green  "disk_$MOUNT" "${PCT}% used, ${FREE} free"
  elif [ "$PCT" -lt 90 ]; then emit yellow "disk_$MOUNT" "${PCT}% used, ${FREE} free" "watch growth rate"
  else                         emit red    "disk_$MOUNT" "${PCT}% used, ${FREE} free" "near full"
  fi
done < <(df -h | awk '/^\/dev/ && $6 != "/" && $6 !~ /boot/ {gsub("%","",$5); print $6, $5, $4}')

# HDD SMART
if command -v smartctl >/dev/null 2>&1; then
  for DRIVE in /dev/sda /dev/sdb /dev/nvme0n1; do
    [ -b "$DRIVE" ] || continue
    HEALTH=$(sudo smartctl -H "$DRIVE" 2>/dev/null | awk -F: '/SMART overall-health/ {gsub(/^[ \t]+/,"",$2); print $2}')
    if [ -z "$HEALTH" ]; then
      emit yellow "smart_$DRIVE" "unknown" "no SMART support or permission denied"
    elif echo "$HEALTH" | grep -qi PASSED; then
      # Drill into pending sectors
      PENDING=$(sudo smartctl -A "$DRIVE" 2>/dev/null | awk '/Current_Pending_Sector/ {print $10}')
      REALLOC=$(sudo smartctl -A "$DRIVE" 2>/dev/null | awk '/Reallocated_Sector_Ct/ {print $10}')
      PENDING=${PENDING:-0}; REALLOC=${REALLOC:-0}
      if [ "$PENDING" -gt 0 ] || [ "$REALLOC" -gt 0 ]; then
        emit yellow "smart_$DRIVE" "PASSED" "pending=$PENDING realloc=$REALLOC — monitor; not yet a failure"
      else
        emit green  "smart_$DRIVE" "PASSED"
      fi
    else
      emit red "smart_$DRIVE" "$HEALTH" "drive failure imminent — back up now"
    fi
  done
fi

# SD card lifetime (eMMC / industrial SD only — consumer SD won't report this)
if command -v mmc >/dev/null 2>&1 && [ -b /dev/mmcblk0 ]; then
  LIFE=$(sudo mmc extcsd read /dev/mmcblk0 2>/dev/null | awk '/LIFE_TIME_EST_TYP_A/ {print $NF; exit}')
  if [ -n "$LIFE" ]; then
    case "$LIFE" in
      0x01|0x02|0x03) emit green  sd_lifetime "$LIFE" "0–30% used" ;;
      0x04|0x05|0x06) emit yellow sd_lifetime "$LIFE" "30–60% used — plan replacement" ;;
      *)              emit red    sd_lifetime "$LIFE" "60%+ used — replace soon" ;;
    esac
  fi
fi

# Memory pressure
MEM_USED_PCT=$(free | awk '/^Mem:/ {printf "%d", ($3/$2)*100}')
if   [ "$MEM_USED_PCT" -lt 80 ]; then emit green  memory   "${MEM_USED_PCT}% used"
elif [ "$MEM_USED_PCT" -lt 90 ]; then emit yellow memory   "${MEM_USED_PCT}% used" "watch for OOM"
else                                  emit red    memory   "${MEM_USED_PCT}% used" "near OOM"
fi

SWAP_USED=$(free | awk '/^Swap:/ {print $3}')
SWAP_TOTAL=$(free | awk '/^Swap:/ {print $2}')
if [ "$SWAP_TOTAL" -gt 0 ]; then
  SWAP_PCT=$(( SWAP_USED * 100 / SWAP_TOTAL ))
  if   [ "$SWAP_PCT" -lt 30 ]; then emit green  swap     "${SWAP_PCT}% used"
  elif [ "$SWAP_PCT" -lt 60 ]; then emit yellow swap     "${SWAP_PCT}% used" "memory pressure"
  else                              emit red    swap     "${SWAP_PCT}% used" "heavy swap — investigate"
  fi
fi

# Load average vs CPU count
LOAD=$(uptime | awk -F'load average: ' '{print $2}' | awk -F, '{print $1}')
CPUS=$(nproc 2>/dev/null || echo 1)
LOAD_RATIO=$(awk -v l="$LOAD" -v c="$CPUS" 'BEGIN{printf "%.2f", l/c}')
if awk -v r="$LOAD_RATIO" 'BEGIN{exit !(r < 0.7)}'; then
  emit green  load     "$LOAD (ratio ${LOAD_RATIO} on ${CPUS} CPUs)"
elif awk -v r="$LOAD_RATIO" 'BEGIN{exit !(r < 1.0)}'; then
  emit yellow load     "$LOAD (ratio ${LOAD_RATIO} on ${CPUS} CPUs)" "elevated"
else
  emit red    load     "$LOAD (ratio ${LOAD_RATIO} on ${CPUS} CPUs)" "sustained overload"
fi

# Top container log sizes — anything over 500 MB is suspicious
if command -v docker >/dev/null 2>&1; then
  DOCKER_ROOT=$(docker info 2>/dev/null | awk -F': ' '/Docker Root Dir/ {print $2}')
  if [ -n "$DOCKER_ROOT" ]; then
    # shellcheck disable=SC2016
    LARGEST=$(sudo find "$DOCKER_ROOT/containers" -name '*-json.log*' -printf '%s %p\n' 2>/dev/null | sort -nr | head -1)
    if [ -n "$LARGEST" ]; then
      SIZE_BYTES=${LARGEST%% *}
      SIZE_PATH=${LARGEST#* }
      CID=$(basename "$(dirname "$SIZE_PATH")")
      NAME=$(docker inspect --format '{{.Name}}' "$CID" 2>/dev/null | sed 's|^/||')
      SIZE_HUMAN=$(numfmt --to=iec --suffix=B "$SIZE_BYTES" 2>/dev/null || echo "${SIZE_BYTES}B")
      if   [ "$SIZE_BYTES" -lt 104857600 ]; then  emit green  "docker_log_max" "${SIZE_HUMAN} (${NAME})"
      elif [ "$SIZE_BYTES" -lt 524288000 ]; then  emit yellow "docker_log_max" "${SIZE_HUMAN} (${NAME})" "approaching rotation cap"
      else                                        emit red    "docker_log_max" "${SIZE_HUMAN} (${NAME})" "log rotation may be misconfigured"
      fi
    fi

    # Containers without explicit log limits (relying on daemon default)
    MISSING=()
    for C in $(docker ps -q); do
      CFG=$(docker inspect --format '{{.HostConfig.LogConfig.Config}}' "$C")
      if [ "$CFG" = "map[]" ]; then
        N=$(docker inspect --format '{{.Name}}' "$C" | sed 's|^/||')
        MISSING+=("$N")
      fi
    done
    if [ "${#MISSING[@]}" -eq 0 ]; then
      emit green container_log_config "all containers have explicit log limits"
    else
      emit yellow container_log_config "${#MISSING[@]} containers using daemon default" "${MISSING[*]}"
    fi
  fi
fi

# Network — ping default gateway
GATEWAY=$(ip route | awk '/^default/ {print $3; exit}')
if [ -n "$GATEWAY" ]; then
  if ping -c 1 -W 1 "$GATEWAY" >/dev/null 2>&1; then
    emit green  network "gateway $GATEWAY reachable"
  else
    emit red    network "gateway $GATEWAY unreachable"
  fi
fi

# Uptime info (always green, just informational)
UP=$(uptime -p)
emit green uptime "$UP"

# ── Summary ─────────────────────────────────────────────────────────────────

if [ "$MODE" = "json" ]; then
  printf '{"results":['
  IFS=,; printf '%s' "${RESULTS[*]}"
  printf '],"worst":%d}\n' "$WORST"
fi

case "$WORST" in
  0) [ "$QUIET" -eq 1 ] || echo "${GREEN}✓ All green${RESET}"; exit 0 ;;
  1) echo "${YELLOW}△ Yellow findings — investigate${RESET}"; exit 1 ;;
  2) echo "${RED}✗ Red findings — act now${RESET}"; exit 2 ;;
esac
