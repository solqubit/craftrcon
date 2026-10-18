#!/usr/bin/env bash
# CraftRCON installer: shared shell library. Sourced (never executed) by the
# install/update/uninstall flows. It sets no shell options: the flows run with
# `set -Eeuo pipefail` and this file is written to be safe under it (test_common.sh
# exercises the conditional-use cases under exactly those options).
#
# Conventions:
#   - function locals are prefixed with `_` so they never shadow a caller's variable
#     (ask/read_secret assign to a caller-named variable with printf -v);
#   - no `cmd | grep -q` / `| head -n 1` pipelines (SIGPIPE + pipefail = false failures).
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
  local _lang="${1:-en}"
  case "$_lang" in
    en | es) ;;
    *) _lang=en ;;
  esac
  CRAFTRCON_LANG="$_lang"
  # shellcheck source=messages.en.sh
  . "$LIB_DIR/messages.en.sh"
  if [ "$_lang" != en ]; then
    # shellcheck source=messages.es.sh
    . "$LIB_DIR/messages.$_lang.sh"
  fi
}

# msg KEY [args...]: prints MSG_<KEY> through printf (no trailing newline).
# Callers pass exactly the arguments the format needs (printf would repeat the format
# for surplus ones). An unknown or malformed key is printed literally; it never fails.
msg() {
  local _key="$1" _var _fmt=''
  shift
  if [[ "$_key" =~ ^[A-Za-z0-9_]+$ ]]; then
    _var="MSG_$_key"
    _fmt="${!_var:-}"
  fi
  if [ -z "$_fmt" ]; then
    printf '%s' "$_key"
    return 0
  fi
  # shellcheck disable=SC2059 # the catalog entry is the format string
  printf -- "$_fmt" "$@"
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
  local _n="$1" _total="$2"
  shift 2
  printf '%s[%s/%s]%s %s\n' "$C_BOLD" "$_n" "$_total" "$C_RESET" "$(msg "$@")"
}

# ------------------------------------------------------------------ system --

# require_root [ENTRY]: dies unless running as root; ENTRY is the command to suggest.
require_root() {
  [ "$(id -u)" -eq 0 ] || die ERR_ROOT "${1:-./install.sh}"
}

# detect_arch: prints x64 or arm64.
detect_arch() {
  local _m="${CRAFTRCON_UNAME_M:-$(uname -m)}"
  case "$_m" in
    x86_64 | amd64) echo x64 ;;
    aarch64 | arm64) echo arm64 ;;
    *) die ERR_ARCH "$_m" ;;
  esac
}

# _os_field FILE KEY: value of KEY=... in an os-release file, without quotes.
_os_field() {
  sed -n "/^$2=/{s///;p;q;}" "$1" | tr -d "\"'"
}

# detect_os: exports OS_ID OS_VERSION OS_LIKE PKG INIT LIBC.
detect_os() {
  local _file="${OS_RELEASE_FILE:-/etc/os-release}" _id _like _ver _major _tok _f _ldd_out
  [ -r "$_file" ] || die ERR_OS_FILE "$_file"
  _id="$(_os_field "$_file" ID)"
  _like="$(_os_field "$_file" ID_LIKE)"
  _ver="$(_os_field "$_file" VERSION_ID)"
  _major="${_ver%%.*}"
  OS_ID="$_id"
  OS_VERSION="$_ver"
  OS_LIKE="$_like"

  PKG=''
  for _tok in $_id $_like; do
    case "$_tok" in
      debian | ubuntu | raspbian | linuxmint | pop) PKG=apt ;;
      fedora) PKG=dnf ;;
      rhel | centos | rocky | almalinux | ol)
        # EL 8+ ships dnf; EL 7 only has yum.
        if [ "${_major:-0}" -ge 8 ] 2>/dev/null; then PKG=dnf; else PKG=yum; fi
        ;;
      amzn)
        if [ "$_major" = 2 ]; then PKG=yum; else PKG=dnf; fi
        ;;
      suse | opensuse | opensuse-leap | opensuse-tumbleweed | sles) PKG=zypper ;;
      arch | manjaro) PKG=pacman ;;
      alpine) PKG=apk ;;
    esac
    if [ -n "$PKG" ]; then break; fi
  done
  [ -n "$PKG" ] || die ERR_OS_UNSUPPORTED "${_id:-unknown}"

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
    LIBC=''
    # musl's ldd prints its banner on stderr and exits 1; glibc's names GNU libc/GLIBC.
    _ldd_out="$(ldd --version 2>&1 || true)"
    case "$_ldd_out" in
      *[Mm][Uu][Ss][Ll]*) LIBC=musl ;;
      *[Gg][Nn][Uu]*[Ll][Ii][Bb][Cc]* | *[Gg][Ll][Ii][Bb][Cc]*) LIBC=glibc ;;
    esac
    if [ -z "$LIBC" ]; then
      # ldd gave no verdict (missing or unrecognised): look for the musl loader.
      LIBC=glibc
      for _f in /lib/ld-musl-*; do
        if [ -e "$_f" ]; then
          LIBC=musl
          break
        fi
      done
    fi
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
    pacman) pacman -Syu --needed --noconfirm "$@" ;; # -Sy alone would risk a partial upgrade
    apk) apk add --no-cache "$@" ;;
    *) die ERR_NO_PKG_MANAGER ;;
  esac
}

# ---------------------------------------------------------------- versions --

# version_cmp A B: prints -1, 0 or 1 comparing two X.Y.Z versions.
# Returns 2 (and prints nothing on stdout) when either one is not X.Y.Z.
version_cmp() {
  local _v _a _b _i
  for _v in "$1" "$2"; do
    if ! [[ "$_v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      msg ERR_VERSION_INVALID "$_v" >&2
      echo >&2
      return 2
    fi
  done
  IFS=. read -ra _a <<<"$1"
  IFS=. read -ra _b <<<"$2"
  for _i in 0 1 2; do
    if ((10#${_a[_i]} > 10#${_b[_i]})); then
      echo 1
      return 0
    elif ((10#${_a[_i]} < 10#${_b[_i]})); then
      echo -1
      return 0
    fi
  done
  echo 0
}

# is_installed: true when installed.json exists.
is_installed() { [ -f "$INSTALLED_FILE" ]; }

# installed_version: prints the top-level "version" of installed.json. Prints nothing
# (and still returns 0, so `v="$(installed_version)"` is safe under set -e) when the
# file is absent or has no such key; nested "version" keys are ignored.
installed_version() {
  is_installed || return 0
  awk '
    BEGIN { RS = "\001" }
    {
      s = $0; n = length(s); depth = 0; i = 1
      while (i <= n) {
        c = substr(s, i, 1)
        if (c == "{" || c == "[") depth++
        else if (c == "}" || c == "]") depth--
        else if (c == "\"") {
          # read a JSON string token
          j = i + 1; tok = ""
          while (j <= n) {
            d = substr(s, j, 1)
            if (d == "\\") { tok = tok substr(s, j, 2); j += 2; continue }
            if (d == "\"") break
            tok = tok d; j++
          }
          k = j + 1
          while (substr(s, k, 1) ~ /[ \t\r\n]/) k++
          if (depth == 1 && tok == "version" && substr(s, k, 1) == ":") {
            k++
            while (substr(s, k, 1) ~ /[ \t\r\n]/) k++
            if (substr(s, k, 1) == "\"") {
              k++; v = ""
              while (k <= n && substr(s, k, 1) != "\"") { v = v substr(s, k, 1); k++ }
              print v
              exit
            }
          }
          i = j
        }
        i++
      }
    }
  ' "$INSTALLED_FILE"
}

# ------------------------------------------------------------------- input --

_check_varname() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die ERR_BAD_VARNAME "$1"
}

# ask PROMPT_KEY DEFAULT VAR: asks a question; empty answer / EOF / NONINTERACTIVE=1 -> DEFAULT.
# A last line without trailing newline is still accepted.
ask() {
  local _key="$1" _default="$2" _var="$3" _answer=''
  _check_varname "$_var"
  if [ "${NONINTERACTIVE:-0}" != 1 ]; then
    printf '%s [%s]: ' "$(msg "$_key")" "$_default" >&2
    IFS= read -r _answer || true # at EOF read still stores a partial last line
  fi
  printf -v "$_var" '%s' "${_answer:-$_default}"
}

# read_secret PROMPT_KEY VAR: reads a secret without echo; with NONINTERACTIVE=1 takes
# CRAFTRCON_PASSWORD (and unsets it so child processes do not inherit it).
read_secret() {
  local _key="$1" _var="$2" _secret=''
  _check_varname "$_var"
  if [ "${NONINTERACTIVE:-0}" = 1 ]; then
    _secret="${CRAFTRCON_PASSWORD:-}"
    unset CRAFTRCON_PASSWORD
    [ -n "$_secret" ] || die ERR_PASSWORD_MISSING
  else
    printf '%s: ' "$(msg "$_key")" >&2
    IFS= read -rs _secret || true
    echo >&2
  fi
  printf -v "$_var" '%s' "$_secret"
}

# ----------------------------------------------------------------- network --

# port_in_use PORT: true if something is listening on the TCP port (ss, else /proc/net/tcp*).
port_in_use() {
  local _port="$1" _hex _f _files=()
  if [ -z "${CRAFTRCON_NO_SS:-}" ] && command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p="$_port" '$4 ~ ("[:.]" p "$") { found = 1 } END { exit !found }'
    return
  fi
  # Only pass readable files: mawk/busybox awk abort on a missing one before END runs
  # (e.g. no /proc/net/tcp6 when IPv6 is disabled) and would lose a listener found earlier.
  # shellcheck disable=SC2086 # the variable holds a whitespace-separated file list
  for _f in ${PROC_NET_TCP_FILES:-/proc/net/tcp /proc/net/tcp6}; do
    if [ -r "$_f" ]; then _files+=("$_f"); fi
  done
  [ "${#_files[@]}" -gt 0 ] || return 1
  _hex="$(printf '%04X' "$_port")"
  awk -v p="$_hex" '
    $4 == "0A" { n = split($2, a, ":"); if (a[n] == p) found = 1 }
    END { exit !found }
  ' "${_files[@]}"
}

# CURL_SECURE: flags for every download (nodejs.org, GitHub, ipify): https only, also
# after redirects. CRAFTRCON_TEST_ALLOW_HTTP=1 (tests only) also allows plain http.
if [ "${CRAFTRCON_TEST_ALLOW_HTTP:-}" = 1 ]; then
  CURL_SECURE=(--proto "=http,https" --proto-redir "=http,https")
else
  CURL_SECURE=(--proto "=https" --proto-redir "=https")
fi

# curl_progress: the curl flag for big downloads (a progress bar only on a terminal).
curl_progress() {
  if [ -t 2 ]; then echo --progress-bar; else echo -sS; fi
}

# wait_health URL TIMEOUT_S: polls URL with curl until the body has "ok":true; returns 1 on
# timeout. Always polls at least once, even with a timeout of 0.
wait_health() {
  local _url="$1" _timeout="$2" _start="$SECONDS" _body
  command -v curl >/dev/null 2>&1 || die ERR_NO_CURL
  while :; do
    _body="$(curl -fsS -m 2 "$_url" 2>/dev/null || true)"
    if grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$_body"; then
      return 0
    fi
    if ((SECONDS - _start >= _timeout)); then
      return 1
    fi
    sleep "${HEALTH_INTERVAL:-1}"
  done
}

# ------------------------------------------------------------------- setup --

init_colors
set_lang "${CRAFTRCON_LANG:-en}"
