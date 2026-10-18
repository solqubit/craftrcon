#!/usr/bin/env bash
# CraftRCON fresh-install flow. Started by ./install.sh (sudo ./install.sh [options]).
#
# Phase 1 (no system changes): options, checks, questions, download sources.
# Phase 2 (changes): packages, Node, user, app, dependencies, config, service, firewall,
# start + health check. On failure it lists what was already done and how to go on.
set -Eeuo pipefail

FLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$FLOW_DIR/lib/common.sh"
# shellcheck source=lib/node.sh
. "$FLOW_DIR/lib/node.sh"
# shellcheck source=lib/service.sh
. "$FLOW_DIR/lib/service.sh"

DEFAULT_PORT=8080
MIN_PASSWORD_LENGTH=8
MAX_TRIES=5
HEALTH_TIMEOUT=30
TOTAL_STEPS=9

OPT_NONINTERACTIVE=0
OPT_NO_SERVICE=0
OPT_YES=0
PASSWORD=''
PORT=''
DOMAIN=''
ARCH=''
SOURCE_VERSION=''
FW_ACCEPT=0
WORK_DIR=''
CHANGES=()          # what phase 2 already did, for the failure summary
CHANGES_STARTED=0
INSTALLED_WRITTEN=0
CURRENT_STEP=''

# ------------------------------------------------------------------ options --

usage() { msg USAGE; }

usage_error() { # usage_error KEY [ARGS...]
  printf '%serror%s %s\n\n' "$C_RED" "$C_RESET" "$(msg "$@")" >&2
  usage >&2
  exit 2
}

_set_lang_opt() {
  case "$1" in
    en | es) set_lang "$1" ;;
    *) usage_error ERR_LANG "$1" ;;
  esac
}

parse_args() {
  local _a
  # --lang first, so every later message (including usage errors) is in that language.
  for ((_a = 1; _a <= $#; _a++)); do
    case "${!_a}" in
      --lang=*) _set_lang_opt "${!_a#--lang=}" ;;
      --lang)
        if ((_a < $#)); then
          _a=$((_a + 1))
          _set_lang_opt "${!_a}"
        fi
        ;;
    esac
  done
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --lang)
        [ "$#" -ge 2 ] || usage_error ERR_OPTION_VALUE "$1"
        shift 2
        ;;
      --lang=*) shift ;;
      --non-interactive) OPT_NONINTERACTIVE=1 && shift ;;
      --no-service) OPT_NO_SERVICE=1 && shift ;;
      -y | --yes) OPT_YES=1 && shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) usage_error ERR_OPTION_UNKNOWN "$1" ;;
    esac
  done
  NONINTERACTIVE="$OPT_NONINTERACTIVE"
}

# -------------------------------------------------------------- validation --

valid_port() { [[ "$1" =~ ^[0-9]{1,5}$ ]] && ((10#$1 >= 1024 && 10#$1 <= 65535)); }

# valid_domain NAME: a lowercase DNS name with at least two labels (no IPs, no ports).
valid_domain() {
  [ "${#1}" -le 253 ] &&
    [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}

# normalize_domain TEXT: lowercase, without scheme, path, trailing dot or spaces.
normalize_domain() {
  local _d="$1"
  _d="${_d//[[:space:]]/}"
  _d="$(printf '%s' "$_d" | tr '[:upper:]' '[:lower:]')"
  _d="${_d#http://}"
  _d="${_d#https://}"
  _d="${_d%%/*}"
  _d="${_d%.}"
  printf '%s' "$_d"
}

# next_free_port START: first port >= START (up to START+100) that nothing listens on.
next_free_port() {
  local _p="$1" _end=$(($1 + 100))
  ((_end <= 65535)) || _end=65535
  while ((_p <= _end)); do
    if ! port_in_use "$_p"; then
      echo "$_p"
      return 0
    fi
    _p=$((_p + 1))
  done
  return 1
}

is_yes() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    y | yes | s | si | sí) return 0 ;;
    *) return 1 ;;
  esac
}

# --------------------------------------------------------------------- json --

# config_json PORT DOMAIN: the /etc/craftrcon/config.json document.
config_json() {
  local _host=0.0.0.0 _domain=null _trust=false
  if [ -n "$2" ]; then
    _host=127.0.0.1
    _domain="\"$2\""
    _trust=true
  fi
  printf '{\n  "host": "%s",\n  "port": %s,\n  "dataDir": "%s",\n  "domain": %s,\n  "trustProxy": %s\n}\n' \
    "$_host" "$1" "$DATA_DIR" "$_domain" "$_trust"
}

# installed_json VERSION COMMIT INSTALLED_AT PORT DOMAIN [TOOL:PORT...]
installed_json() {
  local _commit=null _domain=null _fw='' _e
  if [ -n "$2" ]; then _commit="\"$2\""; fi
  if [ -n "$5" ]; then _domain="\"$5\""; fi
  for _e in "${@:6}"; do
    _fw+="${_fw:+, }{ \"tool\": \"${_e%%:*}\", \"port\": ${_e#*:} }"
  done
  printf '{\n  "version": "%s",\n  "commit": %s,\n  "installedAt": "%s",\n  "port": %s,\n  "domain": %s,\n  "firewall": [%s]\n}\n' \
    "$1" "$_commit" "$3" "$4" "$_domain" "$_fw"
}

# source_commit: git HEAD of the copy being installed, or nothing (no .git or no git).
source_commit() {
  local _c=''
  if [ -e "$SRC_DIR/.git" ] && command -v git >/dev/null 2>&1; then
    _c="$(git -c safe.directory="$SRC_DIR" -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
  fi
  if [[ "$_c" =~ ^[0-9a-f]{40}$ ]]; then echo "$_c"; fi
}

# -------------------------------------------------------------- phase 1: checks --

already_installed() {
  local _v
  _v="$(installed_version)"
  info ALREADY_INSTALLED "${_v:-?}" "$OPT_DIR"
  info ALREADY_INSTALLED_HINT
}

check_source() {
  local _f _real_src _real_opt
  for _f in VERSION package.json package-lock.json src/server.js src/cli.js public locales \
    scripts/templates/craftrcon.service scripts/templates/craftrcon.openrc; do
    [ -e "$SRC_DIR/$_f" ] || die ERR_SOURCE_INCOMPLETE "$_f"
  done
  SOURCE_VERSION="$(tr -d '[:space:]' <"$SRC_DIR/VERSION")"
  [[ "$SOURCE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die ERR_SOURCE_INCOMPLETE VERSION
  # Installing from inside /opt/craftrcon would delete the source while copying it.
  _real_src="$(cd "$SRC_DIR" && pwd -P)"
  _real_opt="$OPT_DIR"
  if [ -d "$OPT_DIR" ]; then _real_opt="$(cd "$OPT_DIR" && pwd -P)"; fi
  case "$_real_src/" in
    "$_real_opt"/*) die ERR_SOURCE_IN_TARGET "$OPT_DIR" ;;
  esac
}

check_system() {
  require_root ./install.sh
  ARCH="$(detect_arch)"
  detect_os
  info DETECTED "$OS_ID" "${OS_VERSION:-?}" "$PKG" "$INIT" "$ARCH"
  if [ "$OPT_NO_SERVICE" != 1 ] && [ "$INIT" != systemd ] && [ "$INIT" != openrc ]; then
    die ERR_NO_INIT
  fi
  check_source
  firewall_detect
}

# ----------------------------------------------------------- phase 1: questions --
# The variables passed to ask/read_secret must not start with "_": the library's own
# "_" locals would shadow them and the answer would be lost.

# password_length TEXT: number of characters (UTF-8 code points, whatever the locale:
# sudo often runs with LANG=C, where ${#var} would count bytes). The CLI counts UTF-16
# units, which is never less, so a password accepted here is never rejected there.
password_length() {
  local LC_ALL=C _s="$1"
  _s="${_s//[$'\x80'-$'\xbf']/}" # drop UTF-8 continuation bytes
  echo "${#_s}"
}

# password_problem TEXT: prints the message key of what is wrong with a password, if any.
password_problem() {
  case "$1" in
    *$'\n'* | *$'\r'*) echo PASSWORD_NEWLINE ;;
    *) if [ "$(password_length "$1")" -lt "$MIN_PASSWORD_LENGTH" ]; then echo PASSWORD_SHORT; fi ;;
  esac
}

ask_password() {
  local p1 p2 problem _try
  if [ "$NONINTERACTIVE" = 1 ]; then
    read_secret Q_PASSWORD PASSWORD
    problem="$(password_problem "$PASSWORD")"
    case "$problem" in
      '') ;;
      PASSWORD_SHORT) die ERR_PASSWORD_SHORT "$MIN_PASSWORD_LENGTH" ;;
      *) die "ERR_$problem" ;;
    esac
    return 0
  fi
  for ((_try = 0; _try < MAX_TRIES; _try++)); do
    read_secret Q_PASSWORD p1
    problem="$(password_problem "$p1")"
    case "$problem" in
      '') ;;
      PASSWORD_SHORT)
        warn PASSWORD_SHORT "$MIN_PASSWORD_LENGTH"
        continue
        ;;
      *)
        warn "$problem"
        continue
        ;;
    esac
    read_secret Q_PASSWORD_AGAIN p2
    if [ "$p1" != "$p2" ]; then
      warn PASSWORD_MISMATCH
      continue
    fi
    PASSWORD="$p1"
    return 0
  done
  die ERR_TOO_MANY_TRIES
}

ask_port() {
  local _default="$DEFAULT_PORT" answer _free _try
  if [ "$NONINTERACTIVE" = 1 ]; then
    PORT="${CRAFTRCON_PORT:-$DEFAULT_PORT}"
    valid_port "$PORT" || die PORT_INVALID "$PORT"
    PORT=$((10#$PORT))
    if port_in_use "$PORT"; then
      # An explicit CRAFTRCON_PORT is respected; only the default moves to a free port.
      [ -z "${CRAFTRCON_PORT:-}" ] || die ERR_PORT_BUSY "$PORT"
      _free="$(next_free_port "$PORT")" || die ERR_NO_FREE_PORT "$PORT"
      warn PORT_BUSY_AUTO "$PORT" "$_free"
      PORT="$_free"
    fi
    return 0
  fi
  if port_in_use "$_default"; then
    _free="$(next_free_port "$_default")" || _free=''
    warn PORT_BUSY "$_default" "${_free:-?}"
    _default="${_free:-$_default}"
  fi
  for ((_try = 0; _try < MAX_TRIES; _try++)); do
    ask Q_PORT "$_default" answer
    if ! valid_port "$answer"; then
      warn PORT_INVALID "$answer"
      continue
    fi
    answer=$((10#$answer))
    if port_in_use "$answer"; then
      _free="$(next_free_port "$answer")" || _free=''
      warn PORT_BUSY "$answer" "${_free:-?}"
      _default="${_free:-$_default}"
      continue
    fi
    PORT="$answer"
    return 0
  done
  die ERR_TOO_MANY_TRIES
}

# _domain_problem DOMAIN: prints the message key of what is wrong with DOMAIN (or nothing).
_domain_problem() {
  if ! valid_domain "$1"; then
    echo DOMAIN_INVALID
  elif port_in_use 80 || port_in_use 443; then
    echo DOMAIN_PORTS_BUSY
  fi
}

ask_domain() {
  local answer _problem _try
  if [ "$NONINTERACTIVE" = 1 ]; then
    DOMAIN="$(normalize_domain "${CRAFTRCON_DOMAIN:-}")"
    if [ -n "$DOMAIN" ]; then
      _problem="$(_domain_problem "$DOMAIN")"
      [ -z "$_problem" ] || die "$_problem" "$DOMAIN"
    fi
  else
    info DOMAIN_INTRO
    for ((_try = 0; _try <= MAX_TRIES; _try++)); do
      ((_try < MAX_TRIES)) || die ERR_TOO_MANY_TRIES
      ask Q_DOMAIN '' answer
      DOMAIN="$(normalize_domain "$answer")"
      [ -n "$DOMAIN" ] || break
      _problem="$(_domain_problem "$DOMAIN")"
      [ -n "$_problem" ] || break
      warn "$_problem" "$DOMAIN"
    done
  fi
  [ -n "$DOMAIN" ] || return 0
  [ "$OPT_NO_SERVICE" != 1 ] || die ERR_NO_SERVICE_DOMAIN
  warn DOMAIN_NOTE "$DOMAIN"
  if command -v getent >/dev/null 2>&1 && ! getent hosts "$DOMAIN" >/dev/null 2>&1; then
    warn DOMAIN_NOT_RESOLVING "$DOMAIN"
  fi
}

# firewall_ports: the ports the firewall must let in (80/443 with a domain).
firewall_ports() {
  if [ -n "$DOMAIN" ]; then echo "80 443"; else echo "$PORT"; fi
}

ask_firewall() {
  local answer
  FW_ACCEPT=0
  [ -n "${FW_TOOL:-}" ] || return 0
  if [ "$OPT_YES" = 1 ]; then
    FW_ACCEPT=1
  elif [ "$NONINTERACTIVE" != 1 ]; then
    info FIREWALL_ACTIVE "$FW_TOOL" "$(firewall_ports)"
    ask Q_FIREWALL y answer
    if is_yes "$answer"; then FW_ACCEPT=1; fi
  fi
}

# ------------------------------------------------------- phase 2: bookkeeping --

begin_step() { # begin_step N KEY [ARGS...]
  local _n="$1"
  shift
  CURRENT_STEP="$(msg "$@")"
  step "$_n" "$TOTAL_STEPS" "$@"
}

record_change() { CHANGES+=("$(msg "$@")"); }

on_error() { # on_error LINE COMMAND (ERR trap; only the main shell reports)
  if [ "${BASH_SUBSHELL:-0}" -eq 0 ]; then
    printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$(msg ERR_COMMAND "$1" "$2")" >&2
  fi
}

on_exit() {
  local _rc=$? _c
  trap - ERR
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  if [ "$_rc" -ne 0 ] && [ "$CHANGES_STARTED" = 1 ]; then
    {
      echo
      printf '%s%s%s\n' "$C_RED$C_BOLD" "$(msg FAIL_HEADER "${CURRENT_STEP:-?}")" "$C_RESET"
      if [ "${#CHANGES[@]}" -eq 0 ]; then
        printf '  %s\n' "$(msg FAIL_NO_CHANGES)"
      else
        printf '  %s\n' "$(msg FAIL_CHANGES)"
        for _c in "${CHANGES[@]}"; do printf '    - %s\n' "$_c"; done
      fi
      if [ "$INSTALLED_WRITTEN" = 1 ]; then
        printf '  %s\n' "$(msg FAIL_UNINSTALL)"
      else
        printf '  %s\n' "$(msg FAIL_RETRY)"
      fi
    } >&2
  fi
  exit "$_rc"
}

# ------------------------------------------------------------ phase 2: steps --

# missing_packages: the distro packages needed for the commands that are not present.
missing_packages() {
  local _pkgs=() _f _ca=0
  command -v curl >/dev/null 2>&1 || _pkgs+=(curl)
  command -v tar >/dev/null 2>&1 || _pkgs+=(tar)
  if ! command -v xz >/dev/null 2>&1; then
    if [ "$PKG" = apt ]; then _pkgs+=(xz-utils); else _pkgs+=(xz); fi
  fi
  if [ -n "$DOMAIN" ] && ! command -v gzip >/dev/null 2>&1; then _pkgs+=(gzip); fi
  for _f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
    if [ -s "$_f" ]; then _ca=1; fi
  done
  [ "$_ca" = 1 ] || _pkgs+=(ca-certificates)
  if ! command -v useradd >/dev/null 2>&1 && ! command -v adduser >/dev/null 2>&1; then
    case "$PKG" in
      apt) _pkgs+=(passwd) ;;
      dnf | yum) _pkgs+=(shadow-utils) ;;
      *) _pkgs+=(shadow) ;;
    esac
  fi
  if ! command -v runuser >/dev/null 2>&1 && ! command -v su >/dev/null 2>&1; then
    _pkgs+=(util-linux)
  fi
  echo "${_pkgs[*]}"
}

# resolve_downloads: finds what will be downloaded (no system changes; dies if unreachable).
resolve_downloads() {
  info CHECK_DOWNLOADS
  node_resolve "$WORK_DIR"
  if [ -n "$DOMAIN" ]; then caddy_resolve; fi
}

step_packages() {
  local _missing _have_curl=0
  begin_step 1 STEP_PACKAGES
  _missing="$(missing_packages)"
  if command -v curl >/dev/null 2>&1; then
    _have_curl=1
    resolve_downloads
  fi
  CHANGES_STARTED=1
  if [ -n "$_missing" ]; then
    # shellcheck disable=SC2086 # word-split the package list
    pkg_install $_missing
    record_change CHANGE_PACKAGES "$_missing"
  else
    ok PACKAGES_PRESENT
  fi
  if [ "$_have_curl" = 0 ]; then resolve_downloads; fi
}

# service_user_can_run_node: true when the service user exists and can run NODE_BIN.
service_user_can_run_node() {
  id -u "$SVC_USER" >/dev/null 2>&1 || return 1
  init_run_as
  (cd / && as_craftrcon "$NODE_BIN" --version) >/dev/null 2>&1
}

step_node() {
  begin_step 2 STEP_NODE
  local _action="$NODE_ACTION"
  ensure_node "$WORK_DIR"
  case "$_action" in
    download) record_change CHANGE_NODE "$NODE_VERSION" "$NODE_DIR" ;;
    apk) record_change CHANGE_PACKAGES "nodejs npm" ;;
    keep)
      # Kept from an earlier run: root can always run it, the service user maybe not
      # (e.g. extracted under umask 027). Repair unless that user can run it already.
      if ! service_user_can_run_node; then
        node_fix_perms
        info NODE_PERMS_REPAIRED "$NODE_DIR"
      fi
      ;;
  esac
  ok NODE_READY "$NODE_VERSION"
}

create_user() {
  local _shell=/bin/false _s
  if id -u "$SVC_USER" >/dev/null 2>&1; then
    info USER_EXISTS "$SVC_USER"
    return 0
  fi
  for _s in /usr/sbin/nologin /sbin/nologin; do
    if [ -x "$_s" ]; then
      _shell="$_s"
      break
    fi
  done
  if command -v useradd >/dev/null 2>&1; then
    if getent group "$SVC_USER" >/dev/null 2>&1; then
      useradd --system --gid "$SVC_USER" --no-create-home --home-dir "$DATA_DIR" --shell "$_shell" "$SVC_USER"
    else
      useradd --system --user-group --no-create-home --home-dir "$DATA_DIR" --shell "$_shell" "$SVC_USER"
    fi
  elif command -v adduser >/dev/null 2>&1; then # Alpine / busybox
    getent group "$SVC_USER" >/dev/null 2>&1 || addgroup -S "$SVC_USER"
    adduser -S -D -H -h "$DATA_DIR" -s "$_shell" -G "$SVC_USER" "$SVC_USER"
  else
    die ERR_NO_USERADD
  fi
  record_change CHANGE_USER "$SVC_USER"
}

step_user() {
  begin_step 3 STEP_USER "$SVC_USER"
  create_user
  # Every owner and mode below is explicit: never rely on root's umask.
  install -d -m 0755 -o root -g root "$OPT_DIR"
  chown root:root "$OPT_DIR"
  chmod 0755 "$OPT_DIR"
  install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
  # A data folder left by an earlier attempt is kept, but must belong to the service user.
  chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
  chmod 0750 "$DATA_DIR"
  install -d -m 0750 -o root -g "$SVC_USER" "$CONF_DIR"
  chown root:"$SVC_USER" "$CONF_DIR"
  chmod 0750 "$CONF_DIR"
  record_change CHANGE_DIRS "$DATA_DIR" "$CONF_DIR"
  service_user_can_run_node || die ERR_NODE_NOT_RUNNABLE "$NODE_BIN" "$SVC_USER"
}

# app_items: the top-level entries of the source copy that go into APP_DIR. Exclusions
# are matched at the top level only (public/js/data must be copied, ./data must not).
app_items() {
  local _f _base
  for _f in "$SRC_DIR"/* "$SRC_DIR"/.[!.]* "$SRC_DIR"/..?*; do
    [ -e "$_f" ] || [ -L "$_f" ] || continue
    _base="${_f##*/}"
    case "$_base" in
      .git | .superpowers | .claude | node_modules | data | test | docs) continue ;;
    esac
    printf '%s\n' "$_base"
  done
}

step_app() {
  local _items=()
  begin_step 4 STEP_APP "$APP_DIR"
  mapfile -t _items < <(app_items)
  if [ -e "$APP_DIR" ]; then
    info APP_REPLACING "$APP_DIR"
    rm -rf "$APP_DIR"
  fi
  mkdir -p "$APP_DIR"
  chmod 0755 "$APP_DIR"
  tar -C "$SRC_DIR" -cf - "${_items[@]}" | tar -C "$APP_DIR" -xf - --no-same-owner
  record_change CHANGE_APP "$APP_DIR"
}

step_deps() {
  begin_step 5 STEP_DEPS
  (
    cd "$APP_DIR"
    PATH="$(dirname "$NODE_BIN"):$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false \
      "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  )
  # root owns the code; the service user can only read it.
  chown -R root:root "$APP_DIR"
  chmod -R u+rwX,go+rX,go-w "$APP_DIR"
  if command -v restorecon >/dev/null 2>&1; then restorecon -R "$OPT_DIR" >/dev/null 2>&1 || true; fi
}

# run_cli ARGS...: node src/cli.js ARGS as the service user (stdin passes through).
run_cli() {
  (
    cd "$DATA_DIR"
    as_craftrcon env CRAFTRCON_CONFIG="$CONFIG_FILE" "$NODE_BIN" --disable-warning=ExperimentalWarning \
      "$APP_DIR/src/cli.js" "$@"
  )
}

step_config() {
  local _rc=0
  begin_step 6 STEP_CONFIG
  config_json "$PORT" "$DOMAIN" >"$WORK_DIR/config.json"
  install -m 0640 -o root -g "$SVC_USER" "$WORK_DIR/config.json" "$CONFIG_FILE"
  init_run_as
  run_cli init
  # The password only travels through a pipe (printf is a builtin: never in argv).
  printf '%s\n' "$PASSWORD" | run_cli set-password || _rc=$?
  PASSWORD=''
  case "$_rc" in
    0) ;;
    2) die ERR_PASSWORD_REJECTED "$MIN_PASSWORD_LENGTH" ;;
    *) die ERR_SET_PASSWORD ;;
  esac
  record_change CHANGE_CONFIG "$CONFIG_FILE" "$DATA_DIR"
}

write_installed() {
  installed_json "$SOURCE_VERSION" "$(source_commit)" "$INSTALLED_AT" "$PORT" "$DOMAIN" \
    ${FIREWALL_OPENED[@]+"${FIREWALL_OPENED[@]}"} >"$WORK_DIR/installed.json" # (bash < 4.4: empty array + set -u)
  install -m 0644 -o root -g root "$WORK_DIR/installed.json" "$INSTALLED_FILE"
}

step_service() {
  begin_step 7 STEP_SERVICE "$SVC"
  INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_installed
  INSTALLED_WRITTEN=1
  record_change CHANGE_INSTALLED "$INSTALLED_FILE"
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    info NO_SERVICE_SKIP
    return 0
  fi
  write_service
  service_enable
  record_change CHANGE_SERVICE "$SVC"
  if [ -n "$DOMAIN" ]; then
    setup_caddy "$DOMAIN" "$PORT" "$WORK_DIR"
    service_enable "$PROXY_SVC"
    record_change CHANGE_CADDY "$CADDY_BIN" "$PROXY_SVC"
  fi
}

# on_firewall_opened: open_firewall hook, run right after each rule it really added.
# installed.json is rewritten every time, so a later failure never orphans a rule (R3).
on_firewall_opened() {
  write_installed
  record_change CHANGE_FIREWALL "${FIREWALL_OPENED[${#FIREWALL_OPENED[@]}-1]#*:}" "$FW_TOOL"
}

step_firewall() {
  local _ports=()
  begin_step 8 STEP_FIREWALL
  if [ -z "${FW_TOOL:-}" ]; then
    info FW_NONE
    return 0
  fi
  read -ra _ports <<<"$(firewall_ports)"
  open_firewall "${_ports[@]}"
}

# start_background: --no-service (containers without init): nohup as the service user.
start_background() {
  touch "$LOG_FILE"
  chown "$SVC_USER:$SVC_USER" "$LOG_FILE"
  chmod 0640 "$LOG_FILE"
  (
    cd "$APP_DIR"
    nohup "${RUN_AS[@]}" env CRAFTRCON_CONFIG="$CONFIG_FILE" NODE_ENV=production "$NODE_BIN" \
      --disable-warning=ExperimentalWarning "$APP_DIR/src/server.js" >>"$LOG_FILE" 2>&1 </dev/null &
  )
}

step_start() {
  local _logs
  begin_step 9 STEP_START
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    start_background
    _logs="tail -n 50 $LOG_FILE"
  else
    service_start
    _logs="$(service_logs_hint)"
    if [ -n "$DOMAIN" ]; then service_start "$PROXY_SVC"; fi
  fi
  wait_health "http://127.0.0.1:$PORT/api/health" "$HEALTH_TIMEOUT" ||
    die ERR_HEALTH "$PORT" "$HEALTH_TIMEOUT" "$_logs"
  ok PANEL_HEALTHY "$PORT"
}

show_result() {
  show_urls "$PORT" "$DOMAIN"
  echo
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    info NOHUP_STARTED "$LOG_FILE"
  else
    case "$INIT" in
      systemd) info SERVICE_HINT "systemctl status $SVC" ;;
      *) info SERVICE_HINT "rc-service $SVC status" ;;
    esac
  fi
  if [ -z "$DOMAIN" ]; then
    info CLOUD_HINT "$PORT"
    echo
    warn HTTP_WARNING
  fi
}

# --------------------------------------------------------------------- main --

main() {
  parse_args "$@"
  if is_installed; then
    already_installed
    exit 0
  fi
  check_system
  ask_password
  ask_port
  ask_domain
  ask_firewall

  WORK_DIR="$(mktemp -d)"
  trap on_exit EXIT
  trap 'exit 130' INT TERM
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  info READY "$SOURCE_VERSION"

  step_packages
  step_node
  step_user
  step_app
  step_deps
  step_config
  step_service
  step_firewall
  step_start
  show_result
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
