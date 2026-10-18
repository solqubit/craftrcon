#!/usr/bin/env bash
# CraftRCON update flow. Started by ./update.sh (sudo ./update.sh [options]) from a copy of
# the new version downloaded anywhere (a git clone or an unpacked zip in /tmp, ...); it
# updates the installation in /opt/craftrcon.
#
# Checks (nothing changes): root, installed, versions (same: says so and exits 0; older:
# refused), confirmation, the copy, the system and what Node.js the new version needs.
#
# Update: stop the panel, back up the database (+ WAL), config.json and installed.json
# (keeping the newest 5 backups), move the application aside (app.prev), copy the new one,
# a newer Node.js only if package.json requires it, npm ci, start, and check that
# /api/health answers with the new version. Then installed.json gets the new version.
#
# From the stop on, ANY failure (a failing command, die, Ctrl-C) rolls back: stop, put
# app.prev (and the previous Node.js) back, restore the database if the new version ran,
# start and check the previous version; then it explains what failed and exits 1. If the
# rollback itself fails, it prints the exact manual recovery steps.
#
# It never touches config.json, secret.key, the panel password or the saved servers.
set -Eeuo pipefail

FLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$FLOW_DIR/lib/common.sh"
# shellcheck source=lib/node.sh
. "$FLOW_DIR/lib/node.sh"
# shellcheck source=lib/service.sh
. "$FLOW_DIR/lib/service.sh"
# shellcheck source=lib/flow.sh
. "$FLOW_DIR/lib/flow.sh"

HEALTH_TIMEOUT=30
BACKUPS_KEPT=5
TOTAL_STEPS=6
DB_FILES=(craftrcon.db craftrcon.db-wal craftrcon.db-shm)

OPT_NONINTERACTIVE=0
OPT_NO_SERVICE=0
OPT_YES=0
OLD_VERSION=''
NEW_VERSION=''
SOURCE_VERSION=''
PANEL_PORT=''       # where the panel listens (config.json): health checks and the URL
KEEP_PORT=''        # what installed.json says, kept as it is
KEEP_DOMAIN=''
KEEP_INSTALLED_AT=''
KEEP_FIREWALL=()
LOGS_HINT=''
APP_PREV=''
NODE_PREV=''
BACKUP_ROOT=''
BACKUP_DIR=''
WORK_DIR=''
CURRENT_STEP=''
# Rollback state. ARMED: from the service stop until installed.json has the new version.
ARMED=0
BACKUP_DONE=0
NEW_STARTED=0  # the new version may have run (and migrated the database)
RECORDING=0    # installed.json is being rewritten
DB_RESTORED=0
INSTALLED_RESTORED=0

# ------------------------------------------------------------------ options --

usage() { msg UPDATE_USAGE; }

parse_args() {
  apply_lang_args "$@"
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

# set_paths: paths derived from the common ones (computed late, so tests can move them).
set_paths() {
  APP_PREV="$APP_DIR.prev"
  NODE_PREV="$NODE_DIR.prev"
  BACKUP_ROOT="$DATA_DIR/backups"
}

# ------------------------------------------------------------------- checks --

# check_versions: sets NEW_VERSION / OLD_VERSION. Same version: says so and exits 0
# without touching anything; an older copy is refused.
check_versions() {
  local _cmp
  read_source_version
  [ -n "$SOURCE_VERSION" ] || die ERR_SOURCE_INCOMPLETE VERSION ./update.sh
  NEW_VERSION="$SOURCE_VERSION"
  OLD_VERSION="$(installed_version)"
  _cmp="$(version_cmp "$NEW_VERSION" "$OLD_VERSION" 2>/dev/null)" || die ERR_INSTALLED_VERSION "$INSTALLED_FILE"
  case "$_cmp" in
    0)
      ok UP_TO_DATE "$OLD_VERSION"
      exit 0
      ;;
    -1) die DOWNGRADE_REFUSED "$OLD_VERSION" "$NEW_VERSION" ;;
  esac
}

confirm_update() {
  local answer
  info UPDATE_PLAN "$OLD_VERSION" "$NEW_VERSION"
  [ "$OPT_YES" != 1 ] || return 0
  [ "$NONINTERACTIVE" != 1 ] || die ERR_UPDATE_NEEDS_YES
  ask Q_UPDATE_CONFIRM y answer
  if ! is_yes "$answer"; then
    info UPDATE_ABORTED
    exit 0
  fi
}

# engines_node_min: the X.Y.Z of "engines": { "node": ">=X.Y.Z" } in the new package.json.
engines_node_min() {
  [ -r "$SRC_DIR/package.json" ] || return 0
  tr -d '\r\n' <"$SRC_DIR/package.json" |
    sed -n 's/.*"engines"[[:space:]]*:[[:space:]]*{[^}]*"node"[[:space:]]*:[[:space:]]*">=[[:space:]]*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p'
}

check_update_system() {
  local _d _min
  check_source ./update.sh
  detect_os
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    LOGS_HINT="tail -n 50 $LOG_FILE"
  else
    if [ "$INIT" != systemd ] && [ "$INIT" != openrc ]; then die ERR_UPDATE_NO_INIT; fi
    [ -e "$(_svc_path "$SVC")" ] || die ERR_UPDATE_NO_SERVICE "$SVC" "$(_svc_path "$SVC")"
    LOGS_HINT="$(service_logs_hint)"
  fi
  command -v curl >/dev/null 2>&1 || die ERR_NO_CURL
  locate_node
  for _d in "$APP_PREV" "$NODE_PREV"; do
    if [ -e "$_d" ]; then die ERR_UPDATE_LEFTOVER "$_d" "$_d"; fi
  done
  init_run_as
  # The new version decides which Node.js it needs (node_resolve keeps the installed one
  # when it is new enough).
  _min="$(engines_node_min)"
  if [ -n "$_min" ] && [ "$(version_cmp "$_min" "$NODE_MIN_VERSION")" = 1 ]; then NODE_MIN_VERSION="$_min"; fi
}

# read_kept_settings: what installed.json and the URL keep from the current installation.
read_kept_settings() {
  PANEL_PORT="$(panel_port)"
  KEEP_PORT="$(installed_port)"
  KEEP_PORT="${KEEP_PORT:-$PANEL_PORT}"
  KEEP_DOMAIN="$(installed_string domain)"
  KEEP_INSTALLED_AT="$(installed_string installedAt)"
  mapfile -t KEEP_FIREWALL < <(installed_firewall)
}

# -------------------------------------------------------------- the panel --

stop_panel() {
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    stop_background_panel || true # (none running is fine)
  else
    service_stop
  fi
}

start_panel() {
  if [ "$OPT_NO_SERVICE" = 1 ]; then start_background; else service_start; fi
}

health_url() { echo "http://127.0.0.1:$PANEL_PORT/api/health"; }

# health_version URL: the "version" that /api/health reports (nothing if it does not answer).
health_version() {
  local _body
  _body="$(curl -fsS -m 2 "$1" 2>/dev/null || true)"
  printf '%s\n' "$_body" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# ------------------------------------------------------------------ backups --

# make_backup: BACKUP_ROOT/<YYYYMMDD-HHMMSS>-<OLD>/ (root only) with the database files,
# config.json and installed.json. Never secret.key: it stays where it is.
make_backup() {
  local _f
  install -d -m 0700 -o root -g root "$BACKUP_ROOT"
  chown root:root "$BACKUP_ROOT"
  chmod 0700 "$BACKUP_ROOT"
  BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-$OLD_VERSION"
  while [ -e "$BACKUP_DIR" ]; do # two updates within one second
    sleep 1
    BACKUP_DIR="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)-$OLD_VERSION"
  done
  install -d -m 0700 -o root -g root "$BACKUP_DIR"
  for _f in "${DB_FILES[@]}"; do
    if [ -f "$DATA_DIR/$_f" ]; then cp -p "$DATA_DIR/$_f" "$BACKUP_DIR/$_f"; fi
  done
  if [ -f "$CONFIG_FILE" ]; then cp -p "$CONFIG_FILE" "$BACKUP_DIR/config.json"; fi
  cp -p "$INSTALLED_FILE" "$BACKUP_DIR/installed.json"
  BACKUP_DONE=1
  ok BACKUP_SAVED "$BACKUP_DIR"
}

# prune_backups: keeps the BACKUPS_KEPT newest backups (by name: the date comes first).
# Folders that do not look like one of ours are never touched.
prune_backups() {
  local _d _all=() _i
  for _d in "$BACKUP_ROOT"/*; do
    [ -d "$_d" ] || continue
    [[ "${_d##*/}" =~ ^[0-9]{8}-[0-9]{6}-[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    _all+=("$_d")
  done
  [ "${#_all[@]}" -gt "$BACKUPS_KEPT" ] || return 0
  mapfile -t _all < <(printf '%s\n' "${_all[@]}" | LC_ALL=C sort)
  for ((_i = 0; _i < ${#_all[@]} - BACKUPS_KEPT; _i++)); do
    rm -rf "${_all[_i]}"
    info BACKUP_PRUNED "${_all[_i]}" "$BACKUPS_KEPT"
  done
}

# restore_db: puts the backed-up database files back (the service is stopped). A -wal or
# -shm the new version left is removed: SQLite would apply it to the old database.
restore_db() {
  local _f
  [ -f "$BACKUP_DIR/craftrcon.db" ] || return 0
  rm -f "$DATA_DIR/craftrcon.db-wal" "$DATA_DIR/craftrcon.db-shm" || return 1
  for _f in "${DB_FILES[@]}"; do
    [ -f "$BACKUP_DIR/$_f" ] || continue
    cp -p "$BACKUP_DIR/$_f" "$DATA_DIR/.$_f.restore" || return 1
    mv -f "$DATA_DIR/.$_f.restore" "$DATA_DIR/$_f" || return 1
  done
}

# -------------------------------------------------------------------- steps --

step_stop() {
  begin_step 1 STEP_UPD_STOP
  stop_panel
}

step_backup() {
  begin_step 2 STEP_UPD_BACKUP
  make_backup
  prune_backups
}

step_app() {
  begin_step 3 STEP_UPD_APP "$APP_DIR"
  mv "$APP_DIR" "$APP_PREV"
  copy_app
}

step_node() {
  begin_step 4 STEP_UPD_NODE
  # A download replaces NODE_DIR: keep the current one until the update succeeds.
  if [ "$NODE_ACTION" = download ] && [ -e "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_PREV"; fi
  ensure_node "$WORK_DIR"
  if [ "$NODE_ACTION" != keep ]; then ok NODE_READY "$NODE_VERSION"; fi
}

step_deps() {
  begin_step 5 STEP_DEPS
  install_app_deps
}

step_start() {
  local _v
  begin_step 6 STEP_UPD_START
  NEW_STARTED=1
  start_panel
  wait_health "$(health_url)" "$HEALTH_TIMEOUT" || die ERR_HEALTH "$PANEL_PORT" "$HEALTH_TIMEOUT" "$LOGS_HINT"
  _v="$(health_version "$(health_url)")"
  [ "$_v" = "$NEW_VERSION" ] || die ERR_UPDATE_VERSION_MISMATCH "${_v:-?}" "$NEW_VERSION"
  ok PANEL_HEALTHY "$PANEL_PORT"
}

# step_record: installed.json gets the new version, commit and updatedAt (port, domain,
# firewall rules and installedAt stay); then the previous copies are deleted.
step_record() {
  local _d
  CURRENT_STEP="$(msg STEP_UPD_RECORD)"
  RECORDING=1
  UPDATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  installed_json "$NEW_VERSION" "$(source_commit)" "${KEEP_INSTALLED_AT:-$UPDATED_AT}" "$KEEP_PORT" "$KEEP_DOMAIN" \
    ${KEEP_FIREWALL[@]+"${KEEP_FIREWALL[@]}"} >"$WORK_DIR/installed.json" # (bash < 4.4: empty array + set -u)
  install -m 0644 -o root -g root "$WORK_DIR/installed.json" "$INSTALLED_FILE"
  ARMED=0
  for _d in "$APP_PREV" "$NODE_PREV"; do
    if [ -e "$_d" ]; then rm -rf "$_d" || warn UPDATE_CLEANUP_FAILED "$_d" "$_d"; fi
  done
}

show_update_result() {
  show_urls "$PANEL_PORT" "$KEEP_DOMAIN" "$(msg UPDATED "$OLD_VERSION" "$NEW_VERSION")"
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    echo
    info NOHUP_STARTED "$LOG_FILE"
  fi
}

# ----------------------------------------------------------------- rollback --

MANUAL_N=0
manual_step() { # manual_step KEY ARGS...: one numbered recovery step
  MANUAL_N=$((MANUAL_N + 1))
  printf '  %s. %s\n' "$MANUAL_N" "$(msg "$@")" >&2
}

# manual_recovery PROBLEMS: the rollback did not finish; prints exactly what is left to do.
manual_recovery() {
  local _stop _start
  if [ "$OPT_NO_SERVICE" = 1 ]; then
    _stop="pkill -f $APP_DIR/src/server.js"
    _start="$(msg MANUAL_START_NO_SERVICE)"
  elif [ "$INIT" = openrc ]; then
    _stop="rc-service $SVC stop"
    _start="rc-service $SVC start"
  else
    _stop="systemctl stop $SVC"
    _start="systemctl start $SVC"
  fi
  printf '%serror%s %s\n' "$C_RED" "$C_RESET" \
    "$(msg ROLLBACK_FAILED "$NEW_VERSION" "${CURRENT_STEP:-?}" "$1" "$OLD_VERSION")" >&2
  MANUAL_N=0
  manual_step MANUAL_STOP "$_stop"
  if [ -d "$APP_PREV" ]; then manual_step MANUAL_APP "rm -rf $APP_DIR && mv $APP_PREV $APP_DIR"; fi
  if [ -d "$NODE_PREV" ]; then manual_step MANUAL_NODE "rm -rf $NODE_DIR && mv $NODE_PREV $NODE_DIR"; fi
  if [ "$BACKUP_DONE" = 1 ] && [ "$NEW_STARTED" = 1 ] && [ "$DB_RESTORED" != 1 ]; then
    manual_step MANUAL_DB "rm -f $DATA_DIR/craftrcon.db-wal $DATA_DIR/craftrcon.db-shm && cp -p $BACKUP_DIR/craftrcon.db* $DATA_DIR/"
  fi
  if [ "$RECORDING" = 1 ] && [ "$INSTALLED_RESTORED" != 1 ]; then
    manual_step MANUAL_INSTALLED "cp -p $BACKUP_DIR/installed.json $INSTALLED_FILE"
  fi
  manual_step MANUAL_START "$_start"
  manual_step MANUAL_CHECK "$OLD_VERSION" "curl -s $(health_url)"
}

# rollback: runs from the EXIT trap (errexit off). Every step is checked; a failing one is
# recorded and the others still run. Functions that may `die` run in a subshell.
rollback() {
  local _problems=() _joined _backup
  ARMED=0
  echo >&2
  warn ROLLBACK_START "${CURRENT_STEP:-?}"
  (stop_panel) || _problems+=("$(msg RB_STOP)")
  if [ -d "$APP_PREV" ]; then
    { rm -rf "$APP_DIR" && mv "$APP_PREV" "$APP_DIR"; } || _problems+=("$(msg RB_APP)")
  fi
  if [ -d "$NODE_PREV" ]; then
    { rm -rf "$NODE_DIR" && mv "$NODE_PREV" "$NODE_DIR"; } || _problems+=("$(msg RB_NODE)")
    NODE_BIN="$NODE_DIR/bin/node"
  fi
  if [ "$BACKUP_DONE" = 1 ] && [ "$NEW_STARTED" = 1 ]; then
    if restore_db; then DB_RESTORED=1; else _problems+=("$(msg RB_DB)"); fi
  fi
  if [ "$RECORDING" = 1 ]; then
    if cp -p "$BACKUP_DIR/installed.json" "$INSTALLED_FILE"; then INSTALLED_RESTORED=1; else _problems+=("$(msg RB_INSTALLED)"); fi
  fi
  if (start_panel); then
    if ! wait_health "$(health_url)" "$HEALTH_TIMEOUT" ||
      [ "$(health_version "$(health_url)")" != "$OLD_VERSION" ]; then
      _problems+=("$(msg RB_HEALTH "$OLD_VERSION")")
    fi
  else
    _problems+=("$(msg RB_START)")
  fi

  if [ "${#_problems[@]}" -eq 0 ]; then
    _backup="$BACKUP_DIR"
    if [ "$BACKUP_DONE" != 1 ]; then _backup="$(msg BACKUP_NONE)"; fi
    printf '%serror%s %s\n' "$C_RED" "$C_RESET" \
      "$(msg UPDATE_ROLLED_BACK "$NEW_VERSION" "${CURRENT_STEP:-?}" "$OLD_VERSION" "$_backup")" >&2
  else
    _joined="$(printf '%s; ' "${_problems[@]}")"
    manual_recovery "${_joined%; }"
  fi
}

on_exit() {
  local _rc=$?
  trap - ERR
  trap '' INT TERM # the rollback must not be interrupted halfway
  set +e
  if [ "$_rc" -ne 0 ] && [ "$ARMED" = 1 ]; then
    rollback
    _rc=1
  fi
  if [ -n "$WORK_DIR" ]; then rm -rf "$WORK_DIR"; fi
  exit "$_rc"
}

# --------------------------------------------------------------------- main --

main() {
  parse_args "$@"
  set_paths
  trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
  require_root ./update.sh
  is_installed || die ERR_NOT_INSTALLED
  check_versions
  confirm_update
  check_update_system
  read_kept_settings

  WORK_DIR="$(mktemp -d)"
  trap on_exit EXIT
  trap 'exit 130' INT TERM
  node_resolve "$WORK_DIR" # may fetch the Node.js release list; still no changes

  info UPDATE_START "$OLD_VERSION" "$NEW_VERSION"
  ARMED=1
  step_stop
  step_backup
  step_app
  step_node
  step_deps
  step_start
  step_record
  show_update_result
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
