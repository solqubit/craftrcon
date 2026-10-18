#!/usr/bin/env bash
# CraftRCON installer: helpers shared by scripts/install-flow.sh and scripts/update-flow.sh
# (options, installed.json, the application copy, its dependencies and the panel process).
# Sourced after common.sh, node.sh and service.sh. Each flow defines usage() and
# TOTAL_STEPS, which usage_error and begin_step use.

DEFAULT_PORT=8080

# ------------------------------------------------------------------ options --

usage_error() { # usage_error KEY [ARGS...]: prints the error and the usage; exits 2
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

# apply_lang_args ARGS...: applies --lang X / --lang=X first, so every later message
# (including usage errors about other options) is in that language.
apply_lang_args() {
  local _a
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
}

is_yes() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    y | yes | s | si | sí) return 0 ;;
    *) return 1 ;;
  esac
}

# ------------------------------------------------------------- bookkeeping --

begin_step() { # begin_step N KEY [ARGS...]: prints step N of TOTAL_STEPS, sets CURRENT_STEP
  local _n="$1"
  shift
  # shellcheck disable=SC2034 # read by the flows (failure messages)
  CURRENT_STEP="$(msg "$@")"
  step "$_n" "$TOTAL_STEPS" "$@"
}

on_error() { # on_error LINE COMMAND (ERR trap; only the main shell reports)
  if [ "${BASH_SUBSHELL:-0}" -eq 0 ]; then
    printf '%serror%s %s\n' "$C_RED" "$C_RESET" "$(msg ERR_COMMAND "$1" "$2")" >&2
  fi
}

# --------------------------------------------------------------------- json --

# installed_json VERSION COMMIT INSTALLED_AT PORT DOMAIN [TOOL:PORT...]: the
# /opt/craftrcon/installed.json document. When UPDATED_AT is set (the update flow) it
# also gets an "updatedAt".
installed_json() {
  local _commit=null _domain=null _fw='' _e _updated=''
  if [ -n "$2" ]; then _commit="\"$2\""; fi
  if [ -n "$5" ]; then _domain="\"$5\""; fi
  if [ -n "${UPDATED_AT:-}" ]; then _updated="\n  \"updatedAt\": \"$UPDATED_AT\","; fi
  for _e in "${@:6}"; do
    _fw+="${_fw:+, }{ \"tool\": \"${_e%%:*}\", \"port\": ${_e#*:} }"
  done
  printf '{\n  "version": "%s",\n  "commit": %s,\n  "installedAt": "%s",'"$_updated"'\n  "port": %s,\n  "domain": %s,\n  "firewall": [%s]\n}\n' \
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

# ------------------------------------------------------------- source copy --

# read_source_version: SOURCE_VERSION of this copy, or '' when VERSION is missing/invalid.
read_source_version() {
  local _v=''
  SOURCE_VERSION=''
  if [ -r "$SRC_DIR/VERSION" ]; then _v="$(tr -d '[:space:]' <"$SRC_DIR/VERSION")"; fi
  if [[ "$_v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then SOURCE_VERSION="$_v"; fi
}

# check_source ENTRY: dies unless this copy is complete and outside OPT_DIR; sets
# SOURCE_VERSION. ENTRY (./install.sh or ./update.sh) is the command the messages suggest.
check_source() {
  local _entry="$1" _f _real_src _real_opt
  for _f in VERSION package.json package-lock.json src/server.js src/cli.js public locales \
    scripts/templates/craftrcon.service scripts/templates/craftrcon.openrc; do
    [ -e "$SRC_DIR/$_f" ] || die ERR_SOURCE_INCOMPLETE "$_f" "$_entry"
  done
  read_source_version
  [ -n "$SOURCE_VERSION" ] || die ERR_SOURCE_INCOMPLETE VERSION "$_entry"
  # Running from inside /opt/craftrcon would delete the source while copying it.
  _real_src="$(cd "$SRC_DIR" && pwd -P)"
  _real_opt="$OPT_DIR"
  if [ -d "$OPT_DIR" ]; then _real_opt="$(cd "$OPT_DIR" && pwd -P)"; fi
  case "$_real_src/" in
    "$_real_opt"/*) die ERR_SOURCE_IN_TARGET "$OPT_DIR" ;;
  esac
}

# ------------------------------------------------------------- application --

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

# copy_app: copies the application files of the source copy into APP_DIR (created 0755).
copy_app() {
  local _items=()
  mapfile -t _items < <(app_items)
  mkdir -p "$APP_DIR"
  chmod 0755 "$APP_DIR"
  tar -C "$SRC_DIR" -cf - "${_items[@]}" | tar -C "$APP_DIR" -xf - --no-same-owner
}

# install_app_deps: production dependencies of APP_DIR with the private npm (no
# install scripts), then root owns the code and the service user can only read it.
install_app_deps() {
  (
    cd "$APP_DIR" || exit 1
    PATH="$(dirname "$NODE_BIN"):$PATH" NPM_CONFIG_UPDATE_NOTIFIER=false \
      "$NPM_BIN" ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  )
  chown -R root:root "$APP_DIR"
  chmod -R u+rwX,go+rX,go-w "$APP_DIR"
  if command -v restorecon >/dev/null 2>&1; then restorecon -R "$OPT_DIR" >/dev/null 2>&1 || true; fi
}

# locate_node: NODE_BIN of the installed panel (the private Node, else the system one on
# Alpine) and a check that the application is there.
# shellcheck disable=SC2153 # NODE_DIR is defined by common.sh
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

# ------------------------------------------------- panel without a service --

# start_background: --no-service (containers without init): nohup as the service user.
start_background() {
  touch "$LOG_FILE"
  chown "$SVC_USER:$SVC_USER" "$LOG_FILE"
  chmod 0640 "$LOG_FILE"
  (
    cd "$APP_DIR" || exit 1
    nohup "${RUN_AS[@]}" env CRAFTRCON_CONFIG="$CONFIG_FILE" NODE_ENV=production "$NODE_BIN" \
      --disable-warning=ExperimentalWarning "$APP_DIR/src/server.js" >>"$LOG_FILE" 2>&1 </dev/null &
  )
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
