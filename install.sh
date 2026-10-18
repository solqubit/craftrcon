#!/bin/sh
# CraftRCON install entry point (POSIX sh). Makes sure bash exists, then hands over
# to scripts/install-flow.sh. Usage: sudo ./install.sh [options]
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
FLOW="$DIR/scripts/install-flow.sh"

if [ ! -f "$FLOW" ]; then
  echo "craftrcon: cannot find $FLOW" >&2
  echo "craftrcon: run ./install.sh from a complete copy of the CraftRCON project." >&2
  exit 1
fi

if ! command -v bash >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then
      apk add --no-cache bash >&2
    else
      echo "craftrcon: bash is required. Install it as root with: apk add bash" >&2
      echo "craftrcon: or run this script with sudo: sudo ./install.sh" >&2
      exit 1
    fi
  else
    echo "craftrcon: bash is required but was not found. Install bash and try again." >&2
    exit 1
  fi
fi

exec bash "$FLOW" "$@"
