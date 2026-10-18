#!/usr/bin/env bash
# CraftRCON installer: shared shell library. Sourced (never executed) by the
# install/update/uninstall flows. It sets no shell options: the flows run with
# `set -Eeuo pipefail` and this file is written to be safe under it.
#
# Environment knobs (mostly for tests):
#   CRAFTRCON_LANG      en|es message language (default en); see also set_lang
#   NO_COLOR            disables colors; colors are only used when stdout is a TTY
#   NONINTERACTIVE=1    ask/read_secret never prompt (defaults / CRAFTRCON_PASSWORD)
#   OS_RELEASE_FILE     os-release file read by detect_os (default /etc/os-release)
#   INIT_OVERRIDE       force INIT (systemd|openrc|none)
#   LIBC_OVERRIDE       force LIBC (glibc|musl)
#   CRAFTRCON_UNAME_M   force the machine name used by detect_arch
#   INSTALLED_FILE      path of installed.json (default /opt/craftrcon/installed.json)
#   CRAFTRCON_NO_SS=1, PROC_NET_TCP_FILES   port_in_use: skip ss / read other files
#   HEALTH_INTERVAL     seconds between wait_health polls (default 1)

# shellcheck disable=SC2034 # the constants below are read by the flows that source this file
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$LIB_DIR/../.." && pwd)"

OPT_DIR=/opt/craftrcon
APP_DIR=/opt/craftrcon/app
NODE_DIR=/opt/craftrcon/node
DATA_DIR=/var/lib/craftrcon
CONF_DIR=/etc/craftrcon
SVC=craftrcon
INSTALLED_FILE="${INSTALLED_FILE:-$OPT_DIR/installed.json}"

# ---------------------------------------------------------------- messages --

# set_lang LANG: loads messages.<LANG>.sh (en or es); anything else falls back to en.
set_lang() {
  local lang="${1:-en}"
  case "$lang" in
    en | es) ;;
    *) lang=en ;;
  esac
  CRAFTRCON_LANG="$lang"
  # shellcheck source=messages.en.sh
  . "$LIB_DIR/messages.en.sh"
  if [ "$lang" != en ]; then
    # shellcheck source=messages.es.sh
    . "$LIB_DIR/messages.$lang.sh"
  fi
}

# msg KEY [args...]: prints MSG_<KEY> through printf (no trailing newline).
# An unknown key prints the key itself; it never fails.
msg() {
  local key="$1" var fmt
  shift
  var="MSG_$key"
  fmt="${!var:-}"
  if [ -z "$fmt" ]; then
    printf '%s' "$key"
    return 0
  fi
  # shellcheck disable=SC2059 # the catalog entry is the format string
  printf "$fmt" "$@"
}

# ------------------------------------------------------------------ output --

init_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RESET=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'
    C_BLUE=$'\033[34m'
  else
    C_RESET='' C_BOLD='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE=''
  fi
}

# info/ok/warn/die KEY [args...]: print a catalog message; warn and die use stderr.
info() { printf '%s==>%s %s\n' "$C_BLUE" "$C_RESET" "$(msg "$@")"; }
ok() { printf '%s ok%s %s\n' "$C_GREEN" "$C_RESET" "$(msg "$@")"; }
warn() { printf '%swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$(msg "$@")" >&2; }
die() {
  printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$(msg "$@")" >&2
  exit 1
}

# step N TOTAL KEY [args...]
step() {
  local n="$1" total="$2"
  shift 2
  printf '%s[%s/%s]%s %s\n' "$C_BOLD" "$n" "$total" "$C_RESET" "$(msg "$@")"
}

# ------------------------------------------------------------------ system --

# require_root [ENTRY]: dies unless running as root; ENTRY is the command to suggest.
require_root() {
  [ "$(id -u)" -eq 0 ] || die ERR_ROOT "${1:-./install.sh}"
}

# detect_arch: prints x64 or arm64.
detect_arch() {
  local m="${CRAFTRCON_UNAME_M:-$(uname -m)}"
  case "$m" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) die ERR_ARCH "$m" ;;
  esac
}

# _os_field FILE KEY: value of KEY=... in an os-release file, without quotes.
_os_field() {
  sed -n "s/^$2=//p" "$1" | head -n 1 | tr -d "\"'"
}

# detect_os: exports OS_ID OS_VERSION OS_LIKE PKG INIT LIBC.
detect_os() {
  local file="${OS_RELEASE_FILE:-/etc/os-release}" id like ver major tok
  [ -r "$file" ] || die ERR_OS_FILE "$file"
  id="$(_os_field "$file" ID)"
  like="$(_os_field "$file" ID_LIKE)"
  ver="$(_os_field "$file" VERSION_ID)"
  major="${ver%%.*}"
  OS_ID="$id"
  OS_VERSION="$ver"
  OS_LIKE="$like"

  PKG=''
  for tok in $id $like; do
    case "$tok" in
      debian | ubuntu | raspbian | linuxmint | pop) PKG=apt ;;
      fedora) PKG=dnf ;;
      rhel | centos | rocky | almalinux | ol)
        # EL 8+ ships dnf; EL 7 only has yum.
        if [ "${major:-0}" -ge 8 ] 2>/dev/null; then PKG=dnf; else PKG=yum; fi
        ;;
      amzn)
        if [ "$major" = 2 ]; then PKG=yum; else PKG=dnf; fi
        ;;
      suse | opensuse | opensuse-leap | opensuse-tumbleweed | sles) PKG=zypper ;;
      arch | manjaro) PKG=pacman ;;
      alpine) PKG=apk ;;
    esac
    [ -z "$PKG" ] || break
  done
  [ -n "$PKG" ] || die ERR_OS_UNSUPPORTED "${id:-unknown}"

  if [ -n "${INIT_OVERRIDE:-}" ]; then
    INIT="$INIT_OVERRIDE"
  elif [ -d /run/systemd/system ]; then
    INIT=systemd
  elif command -v rc-service >/dev/null 2>&1; then
    INIT=openrc
  else
    INIT=none # e.g. containers: the flows only support this with --no-service
  fi

  if [ -n "${LIBC_OVERRIDE:-}" ]; then
    LIBC="$LIBC_OVERRIDE"
  else
    LIBC=glibc
    local f ldd_out
    ldd_out="$(ldd --version 2>&1 || true)" # musl prints its banner on stderr and exits 1
    case "$ldd_out" in
      *[Mm][Uu][Ss][Ll]*) LIBC=musl ;;
    esac
    for f in /lib/ld-musl-*; do
      if [ -e "$f" ]; then
        LIBC=musl
        break
      fi
    done
  fi
  export OS_ID OS_VERSION OS_LIKE PKG INIT LIBC
}

# pkg_install pkgs...: installs system packages with the detected package manager.
pkg_install() {
  [ "$#" -gt 0 ] || return 0
  info PKG_INSTALLING "$*"
  case "${PKG:-}" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y --no-install-recommends "$@"
      ;;
    dnf) dnf install -y "$@" ;;
    yum) yum install -y "$@" ;;
    zypper) zypper --non-interactive install "$@" ;;
    pacman) pacman -Sy --noconfirm --needed "$@" ;;
    apk) apk add --no-cache "$@" ;;
    *) die ERR_NO_PKG_MANAGER ;;
  esac
}

# ---------------------------------------------------------------- versions --

# version_cmp A B: prints -1, 0 or 1 comparing two X.Y.Z versions.
# Returns 2 (and prints nothing on stdout) when either one is not X.Y.Z.
version_cmp() {
  local v a b i
  for v in "$1" "$2"; do
    if ! [[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      msg ERR_VERSION_INVALID "$v" >&2
      echo >&2
      return 2
    fi
  done
  IFS=. read -ra a <<<"$1"
  IFS=. read -ra b <<<"$2"
  for i in 0 1 2; do
    if ((10#${a[i]} > 10#${b[i]})); then
      echo 1
      return 0
    elif ((10#${a[i]} < 10#${b[i]})); then
      echo -1
      return 0
    fi
  done
  echo 0
}

# is_installed: true when installed.json exists.
is_installed() { [ -f "$INSTALLED_FILE" ]; }

# installed_version: prints the "version" recorded in installed.json (nothing if absent).
installed_version() {
  is_installed || return 1
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$INSTALLED_FILE" | head -n 1
}

# ------------------------------------------------------------------- input --

_check_varname() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die ERR_BAD_VARNAME "$1"
}

# ask PROMPT_KEY DEFAULT VAR: asks a question; empty answer / EOF / NONINTERACTIVE=1 -> DEFAULT.
ask() {
  local key="$1" default="$2" var="$3" answer=''
  _check_varname "$var"
  if [ "${NONINTERACTIVE:-0}" != 1 ]; then
    printf '%s [%s]: ' "$(msg "$key")" "$default" >&2
    IFS= read -r answer || answer=''
  fi
  printf -v "$var" '%s' "${answer:-$default}"
}

# read_secret PROMPT_KEY VAR: reads a secret without echo; with NONINTERACTIVE=1 takes CRAFTRCON_PASSWORD.
read_secret() {
  local key="$1" var="$2" secret=''
  _check_varname "$var"
  if [ "${NONINTERACTIVE:-0}" = 1 ]; then
    secret="${CRAFTRCON_PASSWORD:-}"
    [ -n "$secret" ] || die ERR_PASSWORD_MISSING
  else
    printf '%s: ' "$(msg "$key")" >&2
    IFS= read -rs secret || secret=''
    echo >&2
  fi
  printf -v "$var" '%s' "$secret"
}

# ----------------------------------------------------------------- network --

# port_in_use PORT: true if something is listening on the TCP port (ss, else /proc/net/tcp*).
port_in_use() {
  local port="$1" hex
  if [ -z "${CRAFTRCON_NO_SS:-}" ] && command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p="$port" '$4 ~ ("[:.]" p "$") { found = 1 } END { exit !found }'
    return
  fi
  hex="$(printf '%04X' "$port")"
  # shellcheck disable=SC2086 # the variable holds a whitespace-separated file list
  awk -v p="$hex" '
    $4 == "0A" { n = split($2, a, ":"); if (a[n] == p) found = 1 }
    END { exit !found }
  ' ${PROC_NET_TCP_FILES:-/proc/net/tcp /proc/net/tcp6} 2>/dev/null
}

# wait_health URL TIMEOUT_S: polls URL with curl until the body has "ok":true; returns 1 on timeout.
wait_health() {
  local url="$1" timeout="$2" start="$SECONDS" body
  while ((SECONDS - start < timeout)); do
    body="$(curl -fsS -m 2 "$url" 2>/dev/null || true)"
    if grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$body"; then
      return 0
    fi
    sleep "${HEALTH_INTERVAL:-1}"
  done
  return 1
}

# ------------------------------------------------------------------- setup --

init_colors
set_lang "${CRAFTRCON_LANG:-en}"
