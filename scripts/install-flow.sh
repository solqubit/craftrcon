#!/usr/bin/env bash
# CraftRCON fresh-install flow. Started by ./install.sh (sudo ./install.sh [options]).
#
# Phase 1 (no system changes): options, checks, questions, download sources.
# Phase 2 (changes): packages, Node, user, app, dependencies, config, service, firewall,
# start + health check. On failure it lists what was already done and how to go on.
#
# On a machine where CraftRCON is already installed it does not reinstall: it shows the
# versions and a menu (change the password, repair the service, uninstall), or runs the
# --reset-password / --uninstall shortcuts (section "existing installation" below).
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
OPT_RESET_PASSWORD=0
OPT_UNINSTALL=0
OPT_PURGE=0
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
      --reset-password) OPT_RESET_PASSWORD=1 && shift ;;
      --uninstall) OPT_UNINSTALL=1 && shift ;;
      --purge) OPT_PURGE=1 && shift ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) usage_error ERR_OPTION_UNKNOWN "$1" ;;
    esac
  done
  NONINTERACTIVE="$OPT_NONINTERACTIVE"
  if [ "$OPT_RESET_PASSWORD" = 1 ] && [ "$OPT_UNINSTALL" = 1 ]; then
    usage_error ERR_OPTION_CONFLICT --reset-password --uninstall
  fi
  if [ "$OPT_PURGE" = 1 ] && [ "$OPT_UNINSTALL" != 1 ]; then usage_error ERR_PURGE_ALONE; fi
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

# ------------------------------------------------------ existing installation --
# Reached when installed.json exists. Showing the versions never needs root; changing
# anything does.

# read_source_version: SOURCE_VERSION of this copy, or '' when VERSION is missing/invalid
# (the menu then simply does not compare; check_source is the strict check for installs).
read_source_version() {
  local _v=''
  SOURCE_VERSION=''
  if [ -r "$SRC_DIR/VERSION" ]; then _v="$(tr -d '[:space:]' <"$SRC_DIR/VERSION")"; fi
  if [[ "$_v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SOURCE_VERSION="$_v"; fi
}

# show_versions: prints both versions; sets INSTALLED_VERSION and COPY_CMP (1 when this
# copy is newer than the installed version, -1 older, 0 equal, '' when either is unknown).
show_versions() {
  INSTALLED_VERSION="$(installed_version)"
  read_source_version
  COPY_CMP=''
  if [ -n "$INSTALLED_VERSION" ] && [ -n "$SOURCE_VERSION" ]; then
    COPY_CMP="$(version_cmp "$SOURCE_VERSION" "$INSTALLED_VERSION" 2>/dev/null || true)"
  fi
  info EXISTING_VERSIONS "${INSTALLED_VERSION:-?}" "${SOURCE_VERSION:-?}"
}

# offer_update: this copy is newer. Offers ./update.sh; on yes it replaces this process
# with the update flow (same language). Until update-flow.sh exists it says so and returns.
offer_update() {
  local answer update="$FLOW_DIR/update-flow.sh"
  info COPY_NEWER "$SOURCE_VERSION" "$INSTALLED_VERSION"
  ask Q_RUN_UPDATE y answer
  is_yes "$answer" || return 0
  if [ -f "$update" ]; then
    exec bash "$update" --lang "$CRAFTRCON_LANG"
  fi
  warn UPDATE_NOT_AVAILABLE
}

# locate_node: NODE_BIN of the installed panel (the private Node, else the system one on
# Alpine) and a check that the application is there.
locate_node() {
  if [ -x "$NODE_DIR/bin/node" ]; then
    NODE_BIN="$NODE_DIR/bin/node"
  else
    NODE_BIN="$(command -v node || true)"
  fi
  if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then die ERR_NODE_MISSING "$NODE_DIR/bin/node"; fi
  [ -f "$APP_DIR/src/cli.js" ] || die ERR_APP_MISSING "$APP_DIR"
  export NODE_BIN
}

# panel_port: the port the panel listens on (config.json, else installed.json).
panel_port() {
  local _p=''
  if [ -r "$CONFIG_FILE" ]; then
    _p="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$CONFIG_FILE")"
  fi
  [ -n "$_p" ] || _p="$(installed_port)"
  echo "${_p:-$DEFAULT_PORT}"
}

# panel_pids: pids of a panel started without a service (node ... APP_DIR/src/server.js).
panel_pids() {
  local _p _args
  for _p in /proc/[0-9]*; do
    [ -r "$_p/cmdline" ] || continue
    _args="$(tr '\0' ' ' <"$_p/cmdline" 2>/dev/null || true)"
    # argv[0] must be node itself: the runuser/su wrappers also carry the script path.
    case "${_args%% *}" in
      node | */node)
        case "$_args" in *" $APP_DIR/src/server.js "*) echo "${_p#/proc/}" ;; esac
        ;;
    esac
  done
}

# stop_background_panel: ends a panel that runs without a service (--no-service installs).
# Returns 1 when there was none.
stop_background_panel() {
  local _pids _pid _i
  _pids="$(panel_pids)"
  [ -n "$_pids" ] || return 1
  for _pid in $_pids; do kill "$_pid" 2>/dev/null || true; done
  for ((_i = 0; _i < 20; _i++)); do
    [ -n "$(panel_pids)" ] || return 0
    sleep 0.5
  done
  for _pid in $(panel_pids); do kill -9 "$_pid" 2>/dev/null || true; done
  return 0
}

# ---- 1) change the password

action_reset_password() {
  local _rc=0
  require_root ./install.sh
  locate_node
  init_run_as
  ask_password
  # Same path as the install: the password only travels through a pipe, never in argv.
  printf '%s\n' "$PASSWORD" | run_cli set-password || _rc=$?
  PASSWORD=''
  case "$_rc" in
    0) ;;
    2) die ERR_PASSWORD_REJECTED "$MIN_PASSWORD_LENGTH" ;;
    *) die ERR_SET_PASSWORD ;;
  esac
  # No restart: set-password already deleted every session in the database.
  ok PASSWORD_CHANGED
}

# ---- 2) repair the service

action_repair() {
  local _port _logs
  require_root ./install.sh
  detect_os
  locate_node
  init_run_as
  _port="$(panel_port)"
  info REPAIR_START
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    # Containers without init: there is no service to recreate, restart the process.
    info REPAIR_BACKGROUND
    stop_background_panel || true
    start_background
    _logs="tail -n 50 $LOG_FILE"
  else
    if [ "$INIT" != systemd ] && [ "$INIT" != openrc ]; then die ERR_NO_INIT; fi
    write_service
    service_enable
    service_start
    _logs="$(service_logs_hint)"
    if [ -x "$CADDY_BIN" ] && [ -f "$CADDYFILE" ]; then # installed with a domain
      write_proxy_service
      service_enable "$PROXY_SVC"
      service_start "$PROXY_SVC"
    fi
  fi
  wait_health "http://127.0.0.1:$_port/api/health" "$HEALTH_TIMEOUT" ||
    die ERR_HEALTH "$_port" "$HEALTH_TIMEOUT" "$_logs"
  ok REPAIR_DONE "$_port"
}

# ---- 3) uninstall

REMOVED=()
KEPT=()

# remove_unit NAME: stops, disables and deletes the init script of NAME. Returns 1 when
# there was none (no service manager, or the service was never created).
remove_unit() {
  local _path
  case "${INIT:-}" in
    systemd | openrc) ;;
    *) return 1 ;;
  esac
  _path="$(_svc_path "$1")"
  [ -e "$_path" ] || return 1
  service_stop "$1" || warn SVC_STOP_FAILED "$1"
  service_disable "$1" >/dev/null 2>&1 || true
  rm -f "$_path"
}

# delete_service_user: removes the craftrcon user (and its group). The tools' exit codes
# are not trusted (userdel returns 12 for a missing mail spool after removing the user).
delete_service_user() {
  id -u "$SVC_USER" >/dev/null 2>&1 || return 1
  if command -v userdel >/dev/null 2>&1; then
    userdel "$SVC_USER" >/dev/null 2>&1 || true
    if getent group "$SVC_USER" >/dev/null 2>&1; then groupdel "$SVC_USER" >/dev/null 2>&1 || true; fi
  elif command -v deluser >/dev/null 2>&1; then # Alpine / busybox
    deluser "$SVC_USER" >/dev/null 2>&1 || true
    if getent group "$SVC_USER" >/dev/null 2>&1; then delgroup "$SVC_USER" >/dev/null 2>&1 || true; fi
  fi
  ! id -u "$SVC_USER" >/dev/null 2>&1
}

on_uninstall_exit() {
  local _rc=$?
  trap - ERR
  if [ "$_rc" -ne 0 ]; then warn UNINSTALL_FAILED; fi
  exit "$_rc"
}

print_uninstall_summary() {
  local _i
  printf '\n%s%s%s\n' "$C_GREEN$C_BOLD" "$(msg UNINSTALL_DONE)" "$C_RESET"
  printf '%s\n' "$(msg REMOVED_HEADER)"
  for _i in "${REMOVED[@]}"; do printf '  - %s\n' "$_i"; done
  printf '%s\n' "$(msg KEPT_HEADER)"
  for _i in "${KEPT[@]}"; do printf '  - %s\n' "$_i"; done
}

action_uninstall() {
  local fw=() purge=0 answer _e _tool _port _name
  REMOVED=()
  KEPT=()
  require_root ./install.sh
  detect_os
  # The firewall rules are listed in installed.json, which goes away with /opt/craftrcon.
  mapfile -t fw < <(installed_firewall)

  # Every question comes before the first change.
  if [ "$NONINTERACTIVE" != 1 ] && [ "$OPT_YES" != 1 ]; then
    ask Q_UNINSTALL_CONFIRM n answer
    if ! is_yes "$answer"; then
      info UNINSTALL_ABORTED
      return 0
    fi
  fi
  if [ "$OPT_PURGE" = 1 ]; then
    purge=1
  elif [ "$NONINTERACTIVE" != 1 ]; then
    ask Q_DELETE_DATA n answer
    if is_yes "$answer"; then purge=1; fi
  fi

  # installed.json is deleted last: until then a failed run can simply be repeated.
  trap on_uninstall_exit EXIT
  info UNINSTALL_STOPPING
  for _name in "$PROXY_SVC" "$SVC"; do # the proxy first: it forwards to the panel
    if remove_unit "$_name"; then REMOVED+=("$(msg RM_SERVICE "$_name")"); fi
  done
  if [ "$INIT" = systemd ] && [ -z "$SERVICE_ROOT" ]; then systemctl daemon-reload; fi
  # Always: a panel started with --no-service (or by hand) would keep running its deleted files.
  if stop_background_panel; then
    info BACKGROUND_STOPPED
    REMOVED+=("$(msg RM_BACKGROUND)")
  fi

  for _e in ${fw[@]+"${fw[@]}"}; do
    _tool="${_e%%:*}"
    _port="${_e#*:}"
    if firewall_close_rule "$_tool" "$_port"; then
      ok FW_CLOSED "$_port" "$_tool"
      REMOVED+=("$(msg RM_FIREWALL "$_port" "$_tool")")
    else
      warn FW_CLOSE_FAILED "$_port" "$_tool" "$(firewall_close_cmds "$_tool" "$_port")"
    fi
  done

  info UNINSTALL_FILES
  rm -rf "$CONF_DIR"
  REMOVED+=("$(msg RM_CONFIG "$CONF_DIR")")
  rm -f "$LOG_FILE" "$PROXY_LOG_FILE"
  REMOVED+=("$(msg RM_LOGS)")
  if [ "$purge" = 1 ]; then
    rm -rf "$DATA_DIR"
    REMOVED+=("$(msg RM_DATA "$DATA_DIR")")
    if delete_service_user; then REMOVED+=("$(msg RM_USER "$SVC_USER")"); fi
  else
    if [ -e "$DATA_DIR" ]; then KEPT+=("$(msg KEPT_DATA "$DATA_DIR" "$DATA_DIR")"); fi
    if id -u "$SVC_USER" >/dev/null 2>&1; then KEPT+=("$(msg KEPT_USER "$SVC_USER")"); fi
  fi
  rm -rf "$OPT_DIR"
  REMOVED+=("$(msg RM_APP "$OPT_DIR")")
  KEPT+=("$(msg KEPT_PACKAGES)")
  print_uninstall_summary
}

# ---- entry

existing_menu() {
  local choice _try
  for ((_try = 0; _try < MAX_TRIES; _try++)); do
    echo
    printf '%s%s%s\n' "$C_BOLD" "$(msg MENU_TITLE)" "$C_RESET"
    printf '  %s\n' "$(msg MENU_RESET)" "$(msg MENU_REPAIR)" "$(msg MENU_UNINSTALL)" "$(msg MENU_QUIT)"
    ask Q_MENU_CHOICE 4 choice # empty answer or end of input -> 4 (exit)
    case "$choice" in
      1)
        action_reset_password
        return 0
        ;;
      2)
        action_repair
        return 0
        ;;
      3)
        action_uninstall
        return 0
        ;;
      4) return 0 ;;
      *) warn MENU_INVALID "$choice" ;;
    esac
  done
  die ERR_TOO_MANY_TRIES
}

# run_existing: CraftRCON is installed; do what was asked (a shortcut flag, or the menu).
run_existing() {
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  if [ "$OPT_UNINSTALL" = 1 ]; then
    action_uninstall
    return 0
  fi
  if [ "$OPT_RESET_PASSWORD" = 1 ]; then
    action_reset_password
    return 0
  fi
  show_versions
  if [ "$NONINTERACTIVE" = 1 ]; then
    if [ "$COPY_CMP" = 1 ]; then info COPY_NEWER "$SOURCE_VERSION" "$INSTALLED_VERSION"; fi
    info ALREADY_INSTALLED "${INSTALLED_VERSION:-?}" "$OPT_DIR"
    info ALREADY_INSTALLED_HINT
    return 0
  fi
  require_root ./install.sh
  if [ "$COPY_CMP" = 1 ]; then offer_update; fi
  existing_menu
}

# --------------------------------------------------------------------- main --

main() {
  parse_args "$@"
  if is_installed; then
    run_existing
    exit 0
  fi
  if [ "$OPT_UNINSTALL" = 1 ]; then
    info NOT_INSTALLED_UNINSTALL
    exit 0
  fi
  if [ "$OPT_RESET_PASSWORD" = 1 ]; then die ERR_NOT_INSTALLED; fi
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
