#!/usr/bin/env bash
# CraftRCON installer: service user, init scripts, firewall, Caddy (HTTPS) and URLs.
# Sourced after common.sh. INIT (systemd|openrc) comes from detect_os.
#
# Environment knobs (tests): SERVICE_ROOT prefixes the paths write_service writes to,
# CADDY_RELEASES_API / CADDY_DOWNLOAD_BASE override the GitHub URLs, IPIFY_URL the
# public-IP service.

TEMPLATE_DIR="$LIB_DIR/../templates"
SVC_USER=craftrcon
CONFIG_FILE="$CONF_DIR/config.json"
CADDYFILE="$CONF_DIR/Caddyfile"
CADDY_BIN="$OPT_DIR/caddy"
CADDY_DATA="$DATA_DIR/caddy"
PROXY_SVC=craftrcon-proxy
LOG_FILE=/var/log/craftrcon.log
PROXY_LOG_FILE=/var/log/craftrcon-proxy.log
SERVICE_ROOT="${SERVICE_ROOT:-}"
CADDY_RELEASES_API="${CADDY_RELEASES_API:-https://api.github.com/repos/caddyserver/caddy/releases/latest}"
CADDY_DOWNLOAD_BASE="${CADDY_DOWNLOAD_BASE:-https://github.com/caddyserver/caddy/releases}"
IPIFY_URL="${IPIFY_URL:-https://api.ipify.org}"
RUN_AS=()
FIREWALL_OPENED=()

# ---------------------------------------------------------------- templates --

# render_template SRC DEST KEY=VALUE...: copies SRC to DEST replacing every @KEY@ by
# VALUE. Values must not contain | & \ or newlines (they are installer-controlled paths,
# ports and validated domain names; anything else is a bug, so it dies).
render_template() {
  local _src="$1" _dest="$2" _pair _key _val _script=''
  shift 2
  for _pair in "$@"; do
    _key="${_pair%%=*}"
    _val="${_pair#*=}"
    [[ "$_key" =~ ^[A-Z_]+$ ]] || die ERR_TEMPLATE_VALUE "$_pair"
    case "$_val" in
      *'|'* | *'&'* | *\\* | *$'\n'*) die ERR_TEMPLATE_VALUE "$_pair" ;;
    esac
    _script+="s|@${_key}@|${_val}|g;"
  done
  [ -r "$_src" ] || die ERR_TEMPLATE_MISSING "$_src"
  sed "$_script" "$_src" >"$_dest.tmp"
  mv -f "$_dest.tmp" "$_dest"
}

# --------------------------------------------------------------- run as user --

# Sets RUN_AS, the command prefix that runs a program as the service user (stdin and
# environment pass through; arguments are never re-parsed by a shell).
init_run_as() {
  if command -v runuser >/dev/null 2>&1; then
    RUN_AS=(runuser -u "$SVC_USER" --)
  else
    # util-linux and busybox su both pass the extra arguments to `sh -c` as $0 $@. The
    # final "--" matters: busybox su permutes options and would otherwise take program
    # flags such as --disable-warning=... (after the user name) as its own.
    # shellcheck disable=SC2016 # expanded by the target shell, not here
    RUN_AS=(su -s /bin/sh -c 'exec "$0" "$@"' "$SVC_USER" --)
  fi
}

# as_craftrcon CMD [ARGS...]: runs a command as the service user.
as_craftrcon() {
  [ "${#RUN_AS[@]}" -gt 0 ] || init_run_as
  "${RUN_AS[@]}" "$@"
}

# ------------------------------------------------------------------ service --

# _svc_path NAME: where the init script for NAME lives.
_svc_path() {
  case "$INIT" in
    systemd) echo "$SERVICE_ROOT/etc/systemd/system/$1.service" ;;
    openrc) echo "$SERVICE_ROOT/etc/init.d/$1" ;;
    *) die ERR_NO_INIT_SERVICE ;;
  esac
}

# _write_unit NAME KEY=VALUE...: renders templates/NAME.{service,openrc} for INIT.
_write_unit() {
  local _name="$1" _dest _src
  shift
  _dest="$(_svc_path "$_name")"
  case "$INIT" in
    systemd) _src="$TEMPLATE_DIR/$_name.service" ;;
    *) _src="$TEMPLATE_DIR/$_name.openrc" ;;
  esac
  mkdir -p "$(dirname "$_dest")"
  render_template "$_src" "$_dest" "$@"
  if [ "$INIT" = systemd ]; then
    chmod 0644 "$_dest"
    if [ -z "$SERVICE_ROOT" ]; then systemctl daemon-reload; fi
  else
    chmod 0755 "$_dest"
  fi
}

# write_service: the panel's systemd unit or OpenRC script (needs NODE_BIN).
write_service() {
  _write_unit "$SVC" \
    "NODE_BIN=$NODE_BIN" "APP_DIR=$APP_DIR" "CONFIG_FILE=$CONFIG_FILE" \
    "DATA_DIR=$DATA_DIR" "SVC_USER=$SVC_USER" "LOG_FILE=$LOG_FILE"
}

# write_proxy_service: the Caddy proxy's systemd unit or OpenRC script (needs the Caddy
# files from setup_caddy; also used by the repair option).
write_proxy_service() {
  _write_unit "$PROXY_SVC" \
    "CADDY_BIN=$CADDY_BIN" "CADDYFILE=$CADDYFILE" "CADDY_DATA=$CADDY_DATA" \
    "SVC_USER=$SVC_USER" "LOG_FILE=$PROXY_LOG_FILE"
}

# service_start/stop/enable/disable [NAME]: NAME defaults to the panel service.
# service_start restarts a running service, so it always ends up with the new files.
service_start() {
  case "$INIT" in
    systemd) systemctl restart "${1:-$SVC}" ;;
    openrc) rc-service "${1:-$SVC}" restart ;;
    *) die ERR_NO_INIT_SERVICE ;;
  esac
}
service_stop() {
  case "$INIT" in
    systemd) systemctl stop "${1:-$SVC}" ;;
    openrc) rc-service "${1:-$SVC}" stop ;;
    *) die ERR_NO_INIT_SERVICE ;;
  esac
}
service_enable() {
  case "$INIT" in
    systemd) systemctl enable --quiet "${1:-$SVC}" ;;
    openrc) rc-update add "${1:-$SVC}" default ;;
    *) die ERR_NO_INIT_SERVICE ;;
  esac
}
service_disable() {
  case "$INIT" in
    systemd) systemctl disable --quiet "${1:-$SVC}" ;;
    openrc) rc-update del "${1:-$SVC}" default ;;
    *) die ERR_NO_INIT_SERVICE ;;
  esac
}

# service_logs_hint [NAME]: prints the command that shows the service's logs.
service_logs_hint() {
  case "$INIT" in
    systemd) echo "journalctl -u ${1:-$SVC} -n 50 --no-pager" ;;
    *) echo "tail -n 50 $LOG_FILE" ;;
  esac
}

# ----------------------------------------------------------------- firewall --

# firewall_detect: sets FW_TOOL to firewalld or ufw when one of them is active, else ''.
firewall_detect() {
  local _out
  FW_TOOL=''
  if command -v firewall-cmd >/dev/null 2>&1; then
    _out="$(firewall-cmd --state 2>/dev/null || true)"
    if [ "$_out" = running ]; then
      FW_TOOL=firewalld
      return 0
    fi
  fi
  if command -v ufw >/dev/null 2>&1; then
    _out="$(LC_ALL=C ufw status 2>/dev/null || true)"
    case "$_out" in
      *"Status: active"*) FW_TOOL=ufw ;;
    esac
  fi
}

# firewall_cmds PORTS...: prints, on one line, the commands that open the ports with FW_TOOL.
firewall_cmds() {
  local _p _out=''
  case "${FW_TOOL:-}" in
    ufw) for _p in "$@"; do _out+="ufw allow $_p/tcp; "; done ;;
    firewalld)
      for _p in "$@"; do _out+="firewall-cmd --permanent --add-port=$_p/tcp; "; done
      _out+="firewall-cmd --reload; "
      ;;
  esac
  echo "${_out%; }"
}

# _firewall_add PORT: adds the rule; returns 0 if it was added, 3 if it already existed.
_firewall_add() {
  local _out
  case "$FW_TOOL" in
    ufw)
      _out="$(LC_ALL=C ufw allow "$1/tcp")" || return 1 # (called under ||: no errexit here)
      case "$_out" in
        *"Rule added"* | *"Rule updated"*) return 0 ;;
        *) return 3 ;; # "Skipping adding existing rule"
      esac
      ;;
    firewalld)
      if firewall-cmd --permanent --query-port="$1/tcp" >/dev/null 2>&1; then return 3; fi
      firewall-cmd --permanent --add-port="$1/tcp" >/dev/null
      ;;
  esac
}

# open_firewall PORTS...: opens the ports when a firewall is active (FW_TOOL) and the
# user accepted (FW_ACCEPT=1). Only rules this call really added are appended to
# FIREWALL_OPENED ("tool:port"; uninstall removes exactly those, R3); after each one
# the caller's on_firewall_opened hook (if defined) runs, so they are recorded at once.
open_firewall() {
  local _p _rc _added=()
  [ -n "${FW_TOOL:-}" ] || return 0
  if [ "${FW_ACCEPT:-0}" != 1 ]; then
    warn FW_SKIPPED "$FW_TOOL" "$(firewall_cmds "$@")"
    return 0
  fi
  for _p in "$@"; do
    _rc=0
    _firewall_add "$_p" || _rc=$?
    case "$_rc" in
      0)
        FIREWALL_OPENED+=("$FW_TOOL:$_p")
        _added+=("$_p")
        if declare -F on_firewall_opened >/dev/null; then on_firewall_opened; fi
        ;;
      3) info FW_ALREADY_OPEN "$_p" "$FW_TOOL" ;;
      *) return "$_rc" ;;
    esac
  done
  if [ "$FW_TOOL" = firewalld ] && [ "${#_added[@]}" -gt 0 ]; then firewall-cmd --reload >/dev/null; fi
  if [ "${#_added[@]}" -gt 0 ]; then ok FW_OPENED "${_added[*]}" "$FW_TOOL"; fi
}

# firewall_close_cmds TOOL PORT: prints, on one line, the commands that close PORT in TOOL.
firewall_close_cmds() {
  case "$1" in
    ufw) echo "ufw delete allow $2/tcp" ;;
    firewalld) echo "firewall-cmd --permanent --remove-port=$2/tcp; firewall-cmd --reload" ;;
  esac
}

# firewall_close_rule TOOL PORT: removes a rule open_firewall added (uninstall, R3). Closing
# a rule that no longer exists succeeds. Returns 1 when the tool cannot do it right now.
firewall_close_rule() {
  local _tool="$1" _port="$2"
  case "$_tool" in
    ufw)
      command -v ufw >/dev/null 2>&1 || return 1
      LC_ALL=C ufw delete allow "$_port/tcp" >/dev/null
      ;;
    firewalld)
      if command -v firewall-cmd >/dev/null 2>&1 && [ "$(firewall-cmd --state 2>/dev/null || true)" = running ]; then
        firewall-cmd --remove-port="$_port/tcp" >/dev/null 2>&1 || true # the running config
        firewall-cmd --permanent --remove-port="$_port/tcp" >/dev/null # (its status is the result)
      elif command -v firewall-offline-cmd >/dev/null 2>&1; then
        firewall-offline-cmd --remove-port="$_port/tcp" >/dev/null
      else
        return 1
      fi
      ;;
    *) return 1 ;;
  esac
}

# -------------------------------------------------------------------- caddy --

# caddy_arch: Caddy's name for the CPU architecture.
caddy_arch() {
  case "$(detect_arch)" in
    x64) echo amd64 ;;
    arm64) echo arm64 ;;
  esac
}

# caddy_parse_tag: reads a GitHub release JSON (or a .../releases/tag/vX.Y.Z URL) on stdin
# and prints X.Y.Z.
caddy_parse_tag() {
  sed -n -e 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' \
    -e 's|.*/releases/tag/v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' | sed -n '1p'
}

# caddy_resolve: no system changes. Finds the latest Caddy release (GitHub API, falling
# back to the /releases/latest redirect) and sets CADDY_VERSION; dies if unreachable.
caddy_resolve() {
  local _json _url
  CADDY_VERSION=''
  _json="$(curl -fsSL "${CURL_SECURE[@]}" --retry 2 --connect-timeout 10 -H 'Accept: application/vnd.github+json' "$CADDY_RELEASES_API" 2>/dev/null || true)"
  CADDY_VERSION="$(printf '%s\n' "$_json" | caddy_parse_tag)"
  if [ -z "$CADDY_VERSION" ]; then
    _url="$(curl -fsSI "${CURL_SECURE[@]}" -o /dev/null -w '%{redirect_url}' --connect-timeout 10 "$CADDY_DOWNLOAD_BASE/latest" 2>/dev/null || true)"
    CADDY_VERSION="$(printf '%s\n' "$_url" | caddy_parse_tag)"
  fi
  [ -n "$CADDY_VERSION" ] || die ERR_CADDY_RELEASE
}

# caddy_data_check: dies when CADDY_DATA is a symbolic link or exists as something other
# than a folder. It lives in the service user's data folder, so a process of that user
# could have planted a link there to make root hand the target over (review C2a). Runs in
# phase 1 (ask_domain) and again in setup_caddy before anything is downloaded.
caddy_data_check() {
  if [ -L "$CADDY_DATA" ] || { [ -e "$CADDY_DATA" ] && [ ! -d "$CADDY_DATA" ]; }; then
    die ERR_CADDY_DATA_UNSAFE "$CADDY_DATA" "$CADDY_DATA"
  fi
}

# setup_caddy DOMAIN PORT WORKDIR: downloads the official Caddy binary (sha512 checked
# against caddy_<v>_checksums.txt), installs it in CADDY_BIN, writes the Caddyfile and
# the craftrcon-proxy service (run as craftrcon, allowed to bind 80/443).
setup_caddy() {
  local _domain="$1" _port="$2" _work="$3" _file _base _want _got
  caddy_data_check
  [ -n "${CADDY_VERSION:-}" ] || caddy_resolve
  _file="caddy_${CADDY_VERSION}_linux_$(caddy_arch).tar.gz"
  _base="$CADDY_DOWNLOAD_BASE/download/v$CADDY_VERSION"
  info CADDY_DOWNLOADING "$CADDY_VERSION"
  curl -fsSL "${CURL_SECURE[@]}" --retry 3 --connect-timeout 10 -o "$_work/caddy_checksums.txt" "$_base/caddy_${CADDY_VERSION}_checksums.txt" ||
    die ERR_DOWNLOAD "$_base/caddy_${CADDY_VERSION}_checksums.txt"
  curl -fL "${CURL_SECURE[@]}" --retry 3 --connect-timeout 10 "$(curl_progress)" -o "$_work/$_file" "$_base/$_file" ||
    die ERR_DOWNLOAD "$_base/$_file"
  _want="$(awk -v f="$_file" '$2 == f { print $1; exit }' "$_work/caddy_checksums.txt")"
  _got="$(sha512sum "$_work/$_file")"
  _got="${_got%% *}"
  if [ -z "$_want" ] || [ "$_got" != "$_want" ]; then die ERR_CHECKSUM "$_file"; fi
  mkdir -p "$_work/caddy"
  tar -xzf "$_work/$_file" -C "$_work/caddy" caddy
  install -m 0755 -o root -g root "$_work/caddy/caddy" "$CADDY_BIN"

  # Explicit owners and modes (never the umask), also for a folder left by a previous run.
  # Root never follows a link here: the folder is created by the service user (mkdir
  # fails on any name that appeared since the check), chown -h changes a link itself,
  # and chmod (which would follow one) runs as the service user, who gains nothing
  # from a link swapped in meanwhile.
  caddy_data_check
  if [ ! -e "$CADDY_DATA" ]; then (cd / && as_craftrcon mkdir -m 0750 "$CADDY_DATA"); fi
  if [ "$(stat -c %U -- "$CADDY_DATA")" != "$SVC_USER" ]; then chown -h "$SVC_USER:$SVC_USER" "$CADDY_DATA"; fi
  (cd / && as_craftrcon chmod 0750 "$CADDY_DATA")
  render_template "$TEMPLATE_DIR/Caddyfile.tmpl" "$CADDYFILE" "DOMAIN=$_domain" "PORT=$_port"
  chown root:"$SVC_USER" "$CADDYFILE"
  chmod 0640 "$CADDYFILE"
  write_proxy_service
}

# --------------------------------------------------------------------- urls --

# local_ips: the machine's global IPv4 addresses, one per line.
local_ips() {
  local _out=''
  if command -v hostname >/dev/null 2>&1; then _out="$(hostname -I 2>/dev/null || true)"; fi
  if [ -z "${_out// /}" ] && command -v ip >/dev/null 2>&1; then
    _out="$(ip -4 -o addr show scope global 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }' || true)"
  fi
  # shellcheck disable=SC2086 # split the whitespace-separated address list
  printf '%s\n' $_out | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true
}

# public_ip: the public IPv4 address as seen by api.ipify.org (3 s timeout), or nothing.
public_ip() {
  local _ip
  _ip="$(curl -s "${CURL_SECURE[@]}" --max-time 3 "$IPIFY_URL" 2>/dev/null || true)"
  if [[ "$_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$_ip"; fi
}

# show_urls PORT DOMAIN [TITLE]: prints TITLE (default "CraftRCON installed!") and where to
# open the panel (https://DOMAIN when set).
show_urls() {
  local _port="$1" _domain="${2:-}" _title="${3:-$(msg URL_INSTALLED)}" _pub _ip _first=1 _label
  _label="$(msg URL_OPEN)"
  printf '\n%s✔ %s%s\n' "$C_GREEN" "$_title" "$C_RESET"
  if [ -n "$_domain" ]; then
    printf '  %s  https://%s\n' "$_label" "$_domain"
    return 0
  fi
  _pub="$(public_ip)"
  if [ -n "$_pub" ]; then
    printf '  %s  http://%s:%s\n' "$_label" "$_pub" "$_port"
    _first=0
  fi
  while IFS= read -r _ip; do
    [ -n "$_ip" ] && [ "$_ip" != "$_pub" ] || continue
    if [ "$_first" = 1 ]; then
      printf '  %s  http://%s:%s %s\n' "$_label" "$_ip" "$_port" "$(msg URL_LOCAL)"
      _first=0
    else
      printf '  %*s  http://%s:%s %s\n' "${#_label}" '' "$_ip" "$_port" "$(msg URL_LOCAL)"
    fi
  done < <(local_ips)
  if [ "$_first" = 1 ]; then
    printf '  %s  http://%s:%s\n' "$_label" "$(msg URL_SERVER_IP)" "$_port"
  fi
}
