#!/usr/bin/env bash
# CraftRCON update flow. Started by ./update.sh (sudo ./update.sh [options]) from a copy of
# the new version downloaded anywhere (a git clone or an unpacked zip in /tmp, ...); it
# updates the installation in /opt/craftrcon.
#
# Checks (nothing changes): root, installed, versions (same: says so and exits 0; older:
# refused), the copy, the system, the data paths, what Node.js the new version needs, and
# the confirmation.
#
# Update: stop the panel, back up the database (+ WAL), config.json, installed.json and the
# service files (keeping the newest 5 backups), move the application aside (app.prev), copy
# the new one, a newer Node.js only if package.json requires it, npm ci, re-render the
# service files, start, and check that /api/health answers with the new version. Then
# installed.json gets the new version.
#
# From the stop on, ANY failure (a failing command, die, Ctrl-C, SIGTERM, a dropped SSH
# session, a closed output pipe) rolls back: stop, put app.prev (and the previous Node.js
# and service files) back, restore the database if the new version ran, start and check the
# previous version; then it explains what failed (also in update.log in the backup folder)
# and exits 1. If the rollback itself fails, it prints the exact manual recovery steps.
#
# The data folder belongs to the service user, so nothing there is trusted: its owner can
# rename entries and plant links at any time. Backups live outside it, in the root-only
# BACKUP_ROOT (/var/backups/craftrcon, R16); database files that are links or have extra
# hard links are refused; copies out of it never follow links; restores into it are staged
# in the root-only backup and renamed into place (a rename never follows a link).
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
DB_DIR=''           # where the database lives (config.json dataDir, else DATA_DIR)
APP_PREV=''
NODE_PREV=''
BACKUP_DIR=''
BACKUP_PARTIAL=''   # the backup while it is being written (a name prune never matches)
UPDATE_LOG=''
WORK_DIR=''
CURRENT_STEP=''
# Rollback state. ARMED: from the service stop until installed.json has the new version.
ARMED=0
BACKUP_DONE=0
NEW_STARTED=0      # the new version may have run (and migrated the database)
UNITS_WRITTEN=0    # the service files were re-rendered
PROXY_CHANGED=0    # ... and the proxy's changed (it is restarted)
RECORDING=0        # installed.json is being rewritten
DB_RESTORED=0
UNITS_RESTORED=0
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
}

# config_data_dir: dataDir from config.json when it is an absolute path, else DATA_DIR.
config_data_dir() {
  local _d=''
  if [ -r "$CONFIG_FILE" ]; then
    _d="$(tr -d '\r\n' <"$CONFIG_FILE" | sed -n 's/.*"dataDir"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  fi
  _d="${_d%/}"
  case "$_d" in
    /?*) echo "$_d" ;;
    *) echo "$DATA_DIR" ;;
  esac
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

# engines_node_min: the minimum Node.js X.Y.Z that "engines": { "node": ... } of the new
# package.json asks for (">=X.Y.Z", ">=X.Y" or "^X.Y.Z"); nothing for other forms.
engines_node_min() {
  local _spec _re='^(>=|\^)([0-9]+\.[0-9]+)(\.[0-9]+)?'
  [ -r "$SRC_DIR/package.json" ] || return 0
  _spec="$(tr -d '\r\n' <"$SRC_DIR/package.json" |
    sed -n 's/.*"engines"[[:space:]]*:[[:space:]]*{[^}]*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  _spec="${_spec//[[:space:]]/}"
  if [[ "$_spec" =~ $_re ]]; then echo "${BASH_REMATCH[2]}${BASH_REMATCH[3]:-.0}"; fi
}

# owned_by_root PATH (the path itself, not a link target).
owned_by_root() { [ "$(stat -c %u -- "$1" 2>/dev/null)" = 0 ]; }

# safe_file PATH: a regular file, not a symbolic link, without other hard links (a hard
# link to a root file would otherwise be copied as if it were the database).
safe_file() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %h -- "$1" 2>/dev/null)" = 1 ]; }

# root_only_dir PATH: a folder (not a link) owned by root that only root can write to, so
# nobody else can rename or replace what is inside.
root_only_dir() {
  local _m
  [ -d "$1" ] && [ ! -L "$1" ] && owned_by_root "$1" || return 1
  _m="$(stat -c %a -- "$1" 2>/dev/null)" || return 1
  (((8#$_m & 8#022) == 0))
}

# backup_base: the folder that holds BACKUP_ROOT (/var/backups).
backup_base() { dirname "$BACKUP_ROOT"; }

# check_data_paths: the data folder is writable by the service user, so a compromised
# panel could plant links there for root to follow. Refuses (dies) unless the database
# files are plain files with one link each, and the backup folders that already exist
# (/var/backups, /var/backups/craftrcon) are root-only. Run before any change, and again
# with the panel stopped.
check_data_paths() {
  local _f
  if ! safe_file "$DB_DIR/craftrcon.db"; then
    if [ -e "$DB_DIR/craftrcon.db" ] || [ -L "$DB_DIR/craftrcon.db" ]; then
      die ERR_UPDATE_UNSAFE_PATH "$DB_DIR/craftrcon.db" "$DB_DIR/craftrcon.db"
    fi
    die ERR_UPDATE_NO_DB "$DB_DIR/craftrcon.db"
  fi
  for _f in craftrcon.db-wal craftrcon.db-shm; do
    if [ -e "$DB_DIR/$_f" ] || [ -L "$DB_DIR/$_f" ]; then
      safe_file "$DB_DIR/$_f" || die ERR_UPDATE_UNSAFE_PATH "$DB_DIR/$_f" "$DB_DIR/$_f"
    fi
  done
  for _f in "$(backup_base)" "$BACKUP_ROOT"; do
    if [ -e "$_f" ] || [ -L "$_f" ]; then
      root_only_dir "$_f" || die ERR_UPDATE_UNSAFE_PATH "$_f" "$_f"
    fi
  done
}

# ensure_root_dir PATH MODE: creates PATH (mkdir never follows a link planted there) and
# dies unless it is then a root-only folder.
ensure_root_dir() {
  if [ ! -e "$1" ] && [ ! -L "$1" ]; then mkdir -m "$2" "$1"; fi
  root_only_dir "$1" || die ERR_UPDATE_UNSAFE_PATH "$1" "$1"
}

check_update_system() {
  local _min
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
  if [ -e "$APP_PREV" ]; then die ERR_UPDATE_LEFTOVER "$APP_PREV" "$APP_DIR" "$APP_PREV" "$APP_DIR" "$APP_PREV"; fi
  if [ -e "$NODE_PREV" ]; then die ERR_UPDATE_LEFTOVER "$NODE_PREV" "$NODE_DIR" "$NODE_PREV" "$NODE_DIR" "$NODE_PREV"; fi
  DB_DIR="$(config_data_dir)"
  check_data_paths
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

# proxy_installed: true when the HTTPS proxy (Caddy, installs with a domain) is set up.
proxy_installed() { [ -x "$CADDY_BIN" ] && [ -f "$CADDYFILE" ] && [ -e "$(_svc_path "$PROXY_SVC")" ]; }

# ------------------------------------------------------------------ backups --

# make_backup: BACKUP_ROOT/<YYYYMMDD-HHMMSS>-<OLD>/ (root only) with the database files,
# config.json, installed.json and the service files. Never secret.key: it stays where it
# is. Written under a temporary name and renamed when complete.
make_backup() {
  local _f _name _n
  check_data_paths # again: the panel is stopped now
  ensure_root_dir "$(backup_base)" 0755
  ensure_root_dir "$BACKUP_ROOT" 0700
  chmod 0700 "$BACKUP_ROOT" # (root-only parent: nobody else can swap it)
  _name="$(date +%Y%m%d-%H%M%S)-$OLD_VERSION"
  while [ -e "$BACKUP_ROOT/$_name" ] || [ -e "$BACKUP_ROOT/.partial-$_name" ]; do # two updates within one second
    sleep 1
    _name="$(date +%Y%m%d-%H%M%S)-$OLD_VERSION"
  done
  BACKUP_PARTIAL="$BACKUP_ROOT/.partial-$_name"
  mkdir -m 0700 "$BACKUP_PARTIAL"
  # From the data folder: -P copies a link swapped in after the check as a link (never its
  # target); a copy that is not a plain file is refused.
  for _f in "${DB_FILES[@]}"; do
    if safe_file "$DB_DIR/$_f"; then
      cp -P -p "$DB_DIR/$_f" "$BACKUP_PARTIAL/$_f"
      safe_file "$BACKUP_PARTIAL/$_f" || die ERR_UPDATE_UNSAFE_PATH "$DB_DIR/$_f" "$DB_DIR/$_f"
    fi
  done
  [ -f "$BACKUP_PARTIAL/craftrcon.db" ] || die ERR_UPDATE_NO_DB "$DB_DIR/craftrcon.db"
  if [ -f "$CONFIG_FILE" ]; then cp -p "$CONFIG_FILE" "$BACKUP_PARTIAL/config.json"; fi
  cp -p "$INSTALLED_FILE" "$BACKUP_PARTIAL/installed.json"
  if [ "$OPT_NO_SERVICE" != 1 ]; then
    for _n in "$SVC" "$PROXY_SVC"; do
      if [ -f "$(_svc_path "$_n")" ]; then cp -p "$(_svc_path "$_n")" "$BACKUP_PARTIAL/$_n.unit"; fi
    done
  fi
  BACKUP_DIR="$BACKUP_ROOT/$_name"
  mv -T "$BACKUP_PARTIAL" "$BACKUP_DIR"
  BACKUP_PARTIAL=''
  BACKUP_DONE=1
  ok BACKUP_SAVED "$BACKUP_DIR"
}

# prune_backups: keeps the BACKUPS_KEPT newest backups (by name: the date comes first),
# always including the one just made. Folders that do not look like one of ours are never
# touched.
prune_backups() {
  local _d _all=() _i _drop
  for _d in "$BACKUP_ROOT"/*; do
    [ -d "$_d" ] || continue
    [ "$_d" != "$BACKUP_DIR" ] || continue
    [[ "${_d##*/}" =~ ^[0-9]{8}-[0-9]{6}-[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    _all+=("$_d")
  done
  _drop=$((${#_all[@]} - (BACKUPS_KEPT - 1)))
  [ "$_drop" -gt 0 ] || return 0
  mapfile -t _all < <(printf '%s\n' "${_all[@]}" | LC_ALL=C sort)
  for ((_i = 0; _i < _drop; _i++)); do
    rm -rf "${_all[_i]}"
    info BACKUP_PRUNED "${_all[_i]}" "$BACKUPS_KEPT"
  done
}

# restore_db: puts the backed-up database files back (the panel is stopped). Returns 2 when
# the backup has no database, 3 when the database folder is on another filesystem (a
# rename could not be used). Copies are staged inside the root-only backup folder and
# renamed into place: a rename replaces whatever was planted at that name, it never
# follows a link. A -wal or -shm the new version left is removed (SQLite would apply it to
# the old database).
restore_db() {
  local _f
  [ -f "$BACKUP_DIR/craftrcon.db" ] || return 2
  [ "$(stat -c %d -- "$BACKUP_DIR")" = "$(stat -c %d -- "$DB_DIR")" ] || return 3
  rm -f "$DB_DIR/craftrcon.db-wal" "$DB_DIR/craftrcon.db-shm" || return 1
  for _f in "${DB_FILES[@]}"; do
    [ -f "$BACKUP_DIR/$_f" ] || continue
    cp -p "$BACKUP_DIR/$_f" "$BACKUP_DIR/.restore-$_f" || return 1
    rm -f "$DB_DIR/$_f" || return 1 # (a link, if planted, goes; its target is untouched)
    mv -fT "$BACKUP_DIR/.restore-$_f" "$DB_DIR/$_f" || return 1
    chown -h "$SVC_USER:$SVC_USER" "$DB_DIR/$_f" || return 1
  done
}

# restore_units: the service files saved in the backup go back in place.
restore_units() {
  local _n
  for _n in "$SVC" "$PROXY_SVC"; do
    [ -f "$BACKUP_DIR/$_n.unit" ] || continue
    cp -p "$BACKUP_DIR/$_n.unit" "$(_svc_path "$_n")" || return 1
  done
  if [ "$INIT" = systemd ] && [ -z "$SERVICE_ROOT" ]; then systemctl daemon-reload || return 1; fi
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
  case "$NODE_ACTION" in
    keep | system) ;;
    *) ok NODE_READY "$NODE_VERSION" ;;
  esac
}

step_deps() {
  begin_step 5 STEP_DEPS
  install_app_deps
}

# refresh_units: re-renders the service files from the new version's templates (e.g. new
# ExecStart flags). The previous ones are in the backup.
refresh_units() {
  [ "$OPT_NO_SERVICE" != 1 ] || return 0
  UNITS_WRITTEN=1
  write_service
  if [ -f "$BACKUP_DIR/$PROXY_SVC.unit" ] && proxy_installed; then
    write_proxy_service
    if [ "$(cat "$BACKUP_DIR/$PROXY_SVC.unit")" != "$(cat "$(_svc_path "$PROXY_SVC")")" ]; then PROXY_CHANGED=1; fi
  fi
}

step_start() {
  local _v
  begin_step 6 STEP_UPD_START
  refresh_units
  NEW_STARTED=1
  start_panel
  wait_health "$(health_url)" "$HEALTH_TIMEOUT" || die ERR_HEALTH "$PANEL_PORT" "$HEALTH_TIMEOUT" "$LOGS_HINT"
  _v="$(health_version "$(health_url)")"
  [ "$_v" = "$NEW_VERSION" ] || die ERR_UPDATE_VERSION_MISMATCH "${_v:-?}" "$NEW_VERSION"
  if [ "$PROXY_CHANGED" = 1 ]; then service_start "$PROXY_SVC"; fi
  ok PANEL_HEALTHY "$PANEL_PORT"
}

# step_record: installed.json gets the new version, commit and updatedAt (port, domain,
# firewall rules and installedAt stay); then the previous copies are deleted.
step_record() {
  local _d _now
  CURRENT_STEP="$(msg STEP_UPD_RECORD)"
  RECORDING=1
  _now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  installed_json "$NEW_VERSION" "$(source_commit)" "${KEEP_INSTALLED_AT:-$_now}" "$_now" "$KEEP_PORT" "$KEEP_DOMAIN" \
    ${KEEP_FIREWALL[@]+"${KEEP_FIREWALL[@]}"} >"$WORK_DIR/installed.json" # (bash < 4.4: empty array + set -u)
  write_installed_file "$WORK_DIR/installed.json"
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
# The rollback runs from the EXIT trap with errexit off and INT/TERM/HUP/PIPE ignored. The
# terminal may be gone (SSH dropped, closed pipe): every write ignores errors, and the
# report also goes to update.log in the backup folder.

# rb_say LEVEL TEXT: one line of rollback output (LEVEL: error, warn or '').
rb_say() {
  local _color=''
  case "$1" in
    error) _color="$C_RED" ;;
    warn) _color="$C_YELLOW" ;;
  esac
  if [ -n "$1" ]; then
    printf '%s%s%s %s\n' "$_color" "$1" "$C_RESET" "$2" 3>&2 2>/dev/null 1>&3 || true
  else
    printf '%s\n' "$2" 3>&2 2>/dev/null 1>&3 || true
  fi
  if [ -n "$UPDATE_LOG" ]; then printf '%s\n' "${1:+$1 }$2" >>"$UPDATE_LOG" 2>/dev/null || true; fi
}

# rb_run CMD [ARGS...]: runs a step in a subshell (a `die` in it cannot end the rollback),
# its output to the log only.
rb_run() { ("$@") >>"${UPDATE_LOG:-/dev/null}" 2>&1; }

MANUAL_N=0
manual_step() { # manual_step KEY ARGS...: one numbered recovery step
  MANUAL_N=$((MANUAL_N + 1))
  rb_say '' "  $MANUAL_N. $(msg "$@")"
}

# manual_recovery PROBLEMS: the rollback did not finish; prints exactly what is left to do.
manual_recovery() {
  local _stop _start _units='' _n
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
  rb_say error "$(msg ROLLBACK_FAILED "$NEW_VERSION" "${CURRENT_STEP:-?}" "$1" "$OLD_VERSION")"
  MANUAL_N=0
  manual_step MANUAL_STOP "$_stop"
  if [ -d "$APP_PREV" ]; then manual_step MANUAL_APP "rm -rf $APP_DIR && mv $APP_PREV $APP_DIR"; fi
  if [ -d "$NODE_PREV" ]; then manual_step MANUAL_NODE "rm -rf $NODE_DIR && mv $NODE_PREV $NODE_DIR"; fi
  if [ "$UNITS_WRITTEN" = 1 ] && [ "$UNITS_RESTORED" != 1 ]; then
    for _n in "$SVC" "$PROXY_SVC"; do
      if [ -f "$BACKUP_DIR/$_n.unit" ]; then _units+="${_units:+ && }cp $BACKUP_DIR/$_n.unit $(_svc_path "$_n" 2>/dev/null)"; fi
    done
    if [ "$INIT" = systemd ]; then _units+=" && systemctl daemon-reload"; fi
    manual_step MANUAL_UNITS "$_units"
  fi
  if [ "$BACKUP_DONE" = 1 ] && [ "$NEW_STARTED" = 1 ] && [ "$DB_RESTORED" != 1 ]; then
    manual_step MANUAL_DB "rm -f $DB_DIR/craftrcon.db-wal $DB_DIR/craftrcon.db-shm && cp -p $BACKUP_DIR/craftrcon.db* $DB_DIR/ && chown $SVC_USER:$SVC_USER $DB_DIR/craftrcon.db*"
  fi
  if [ "$RECORDING" = 1 ] && [ "$INSTALLED_RESTORED" != 1 ]; then
    manual_step MANUAL_INSTALLED "cp -p $BACKUP_DIR/installed.json $INSTALLED_FILE"
  fi
  manual_step MANUAL_START "$_start"
  manual_step MANUAL_CHECK "$OLD_VERSION" "curl -s $(health_url)"
}

# rollback: every step is checked; a failing one is recorded and the others still run.
rollback() {
  local _problems=() _joined _backup _stopped=0 _rc
  ARMED=0
  if [ "$BACKUP_DONE" = 1 ]; then
    UPDATE_LOG="$BACKUP_DIR/update.log"
    printf '== %s ./update.sh %s -> %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$OLD_VERSION" "$NEW_VERSION" >>"$UPDATE_LOG" 2>/dev/null || true
  fi
  rb_say '' ''
  rb_say warn "$(msg ROLLBACK_START "${CURRENT_STEP:-?}")"
  if rb_run stop_panel; then _stopped=1; else _problems+=("$(msg RB_STOP)"); fi
  if [ -d "$APP_PREV" ]; then
    { rm -rf "$APP_DIR" && mv "$APP_PREV" "$APP_DIR"; } >/dev/null 2>&1 || _problems+=("$(msg RB_APP)")
  fi
  if [ -d "$NODE_PREV" ]; then
    { rm -rf "$NODE_DIR" && mv "$NODE_PREV" "$NODE_DIR"; } >/dev/null 2>&1 || _problems+=("$(msg RB_NODE)")
    NODE_BIN="$NODE_DIR/bin/node"
  fi
  if [ "$UNITS_WRITTEN" = 1 ]; then
    if rb_run restore_units; then UNITS_RESTORED=1; else _problems+=("$(msg RB_UNITS)"); fi
  fi
  if [ "$BACKUP_DONE" = 1 ] && [ "$NEW_STARTED" = 1 ]; then
    if [ "$_stopped" != 1 ]; then
      _problems+=("$(msg RB_DB_SKIPPED)") # never under a running panel
    else
      _rc=0
      restore_db >>"$UPDATE_LOG" 2>&1 || _rc=$?
      case "$_rc" in
        0) DB_RESTORED=1 ;;
        2) _problems+=("$(msg RB_DB_MISSING)") ;;
        3) _problems+=("$(msg RB_DB_OTHER_FS)") ;;
        *) _problems+=("$(msg RB_DB)") ;;
      esac
    fi
  fi
  if [ "$RECORDING" = 1 ]; then
    if { cp -p "$BACKUP_DIR/installed.json" "$INSTALLED_FILE.tmp" && mv -f "$INSTALLED_FILE.tmp" "$INSTALLED_FILE"; } >/dev/null 2>&1; then
      INSTALLED_RESTORED=1
    else
      _problems+=("$(msg RB_INSTALLED)")
    fi
  fi
  if [ -n "$BACKUP_PARTIAL" ]; then rm -rf "$BACKUP_PARTIAL" >/dev/null 2>&1; fi # an unfinished backup is worth nothing
  if rb_run start_panel; then
    if ! wait_health "$(health_url)" "$HEALTH_TIMEOUT" ||
      [ "$(health_version "$(health_url)")" != "$OLD_VERSION" ]; then
      _problems+=("$(msg RB_HEALTH "$OLD_VERSION")")
    fi
    if [ "$PROXY_CHANGED" = 1 ] && [ "$UNITS_RESTORED" = 1 ]; then
      rb_run service_start "$PROXY_SVC" || _problems+=("$(msg RB_START)")
    fi
  else
    _problems+=("$(msg RB_START)")
  fi

  if [ "${#_problems[@]}" -eq 0 ]; then
    _backup="$BACKUP_DIR"
    if [ "$BACKUP_DONE" != 1 ]; then _backup="$(msg BACKUP_NONE)"; fi
    rb_say error "$(msg UPDATE_ROLLED_BACK "$NEW_VERSION" "${CURRENT_STEP:-?}" "$OLD_VERSION" "$_backup")"
  else
    _joined="$(printf '%s; ' "${_problems[@]}")"
    manual_recovery "${_joined%; }"
  fi
  if [ -n "$UPDATE_LOG" ]; then rb_say '' "$(msg ROLLBACK_LOG "$UPDATE_LOG")"; fi
}

on_exit() {
  local _rc=$?
  trap '' INT TERM HUP PIPE # nothing may interrupt the rollback halfway
  trap - ERR
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
  check_update_system
  confirm_update
  read_kept_settings

  WORK_DIR="$(mktemp -d)"
  trap on_exit EXIT
  # Ctrl-C, kill, a dropped SSH session (HUP) or a closed output pipe all end in on_exit,
  # which rolls back once the update has started.
  trap 'exit 130' INT TERM HUP PIPE
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
