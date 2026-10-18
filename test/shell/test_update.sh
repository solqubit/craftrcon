#!/usr/bin/env bash
# Unit tests for scripts/update-flow.sh: options, the version decision (equal / older /
# newer), confirmation, backups and their rotation, the data-folder hardening (symbolic
# links), and the whole update with automatic rollback (also under SIGHUP/SIGPIPE) against
# a sandbox (temp dirs, stubbed service manager, npm and health check).
# The real thing (a container with the panel running) is update-in-container.sh.
# shellcheck disable=SC2016 # the snippets are deliberately single-quoted (they expand in the child bash)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIX="$HERE/fixtures"

# shellcheck source=assert.sh
. "$HERE/assert.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Symbolic links: Git Bash on Windows (without developer mode) copies instead.
CAN_SYMLINK=0
if ln -s "$TMP" "$TMP/.probe" 2>/dev/null && [ -L "$TMP/.probe" ]; then CAN_SYMLINK=1; fi
rm -rf "$TMP/.probe"

# A minimal copy of the project with its own VERSION (the "downloaded new version").
COPY="$TMP/copy"
mkdir -p "$COPY/src" "$COPY/public/js/data" "$COPY/locales" "$COPY/data" "$COPY/test"
cp -r "$ROOT/scripts" "$COPY/scripts"
printf '{\n  "name": "craftrcon",\n  "engines": {\n    "node": ">=22.13.0"\n  }\n}\n' >"$COPY/package.json"
echo '{}' >"$COPY/package-lock.json"
echo 'server' >"$COPY/src/server.js"
echo 'cli' >"$COPY/src/cli.js"
echo 'items' >"$COPY/public/js/data/items.js"
echo 'local' >"$COPY/data/local.db"
FLOWC="$COPY/scripts/update-flow.sh"
set_copy_version() { printf '%s\n' "$1" >"$COPY/VERSION"; }

# fl SNIPPET [ENV...]: runs SNIPPET in a fresh strict bash with the (copied) flow sourced.
fl() { env "${@:2}" bash -c "set -Eeuo pipefail; . '$FLOWC'; $1"; }
# run_flow ARGS...: runs the flow as ./update.sh would; prints stdout+stderr, then "rc=N".
run_flow() {
  local out rc=0
  out="$(env INSTALLED_FILE="${INSTALLED_FILE_T:-$TMP/none.json}" bash "$FLOWC" "$@" 2>&1)" || rc=$?
  printf '%s\nrc=%s' "$out" "$rc"
}

echo "options"
set_copy_version 1.4.2
out="$(run_flow --bogus)"
assert_contains "rc=2" "$out" "unknown option exits 2"
assert_contains "Unknown option: --bogus" "$out" "unknown option is named"
assert_contains "Usage: sudo ./update.sh" "$out" "unknown option prints the usage"
out="$(run_flow --help)"
assert_contains "rc=0" "$out" "--help exits 0"
for f in --yes --non-interactive --no-service --lang update.log; do assert_contains "$f" "$out" "usage mentions $f"; done
assert_contains "Uso: sudo ./update.sh" "$(run_flow --lang es --help)" "usage in Spanish"
assert_contains "rc=2" "$(run_flow --lang fr)" "--lang fr exits 2"
assert_contains "rc=2" "$(run_flow --lang)" "--lang without value exits 2"
assert_eq "1|1|1" "$(fl 'parse_args --yes --non-interactive --no-service; echo "$OPT_YES|$NONINTERACTIVE|$OPT_NO_SERVICE"')" "flags are parsed"
if [ "$(id -u)" -ne 0 ]; then
  out="$(INSTALLED_FILE_T="$FIX/installed.json" run_flow --yes)"
  assert_contains "rc=1" "$out" "non-root exits 1"
  assert_contains "sudo ./update.sh" "$out" "non-root message suggests sudo ./update.sh"
fi

echo "helpers"
mkdir -p "$TMP/bin-curl"
printf '#!/bin/sh\necho "{\\"ok\\":true,\\"version\\":\\"2.3.4\\"}"\n' >"$TMP/bin-curl/curl"
chmod +x "$TMP/bin-curl/curl"
assert_eq "2.3.4" "$(fl 'health_version http://x/api/health' PATH="$TMP/bin-curl:$PATH")" "health_version reads the version from /api/health"
printf '#!/bin/sh\nexit 7\n' >"$TMP/bin-curl/curl"
assert_eq "" "$(fl 'health_version http://x/api/health' PATH="$TMP/bin-curl:$PATH")" "health_version: nothing when the panel does not answer"
assert_eq "22.13.0" "$(fl 'engines_node_min')" "engines_node_min reads package.json engines.node"
mkdir -p "$TMP/pkg"
engines() { printf '{"name":"x","engines":{"node":"%s"},"version":"1.0.0"}' "$1" >"$TMP/pkg/package.json"; fl "SRC_DIR='$TMP/pkg'; engines_node_min"; }
assert_eq "24.1.2" "$(engines '>= 24.1.2')" "engines_node_min: >=X.Y.Z (compact JSON, spaces)"
assert_eq "24.1.0" "$(engines '>=24.1')" "engines_node_min: >=X.Y"
assert_eq "24.3.1" "$(engines '^24.3.1')" "engines_node_min: ^X.Y.Z"
assert_eq "22.13.0" "$(engines '>=22.13.0 <25')" "engines_node_min: a range keeps its minimum"
assert_eq "" "$(engines '*')" "engines_node_min: other forms -> nothing"
inst="$(fl 'installed_json 1.5.0 "" 2026-10-16T00:00:00Z 2026-10-17T10:00:00Z 8080 "" ufw:8080')"
assert_contains '"updatedAt": "2026-10-17T10:00:00Z",' "$inst" "installed_json writes updatedAt when given"
assert_contains '"installedAt": "2026-10-16T00:00:00Z",' "$inst" "installed_json keeps installedAt"
assert_contains '"firewall": [{ "tool": "ufw", "port": 8080 }]' "$inst" "installed_json firewall entries"
case "$(fl 'installed_json 1.5.0 "" T "" 8080 ""')" in *updatedAt*) r=present ;; *) r=absent ;; esac
assert_eq "absent" "$r" "installed_json with an empty updatedAt has none (install format unchanged)"
case "$(fl 'UPDATED_AT=x; export UPDATED_AT; installed_json 1.5.0 "" T "" 8080 ""')" in *updatedAt*) r=present ;; *) r=absent ;; esac
assert_eq "absent" "$r" "installed_json never reads UPDATED_AT from the environment"
assert_eq "2026-10-16T10:00:00Z" "$(fl 'installed_string installedAt' INSTALLED_FILE="$FIX/installed.json")" "installed_string reads a top-level string"
printf '{"version":"1.0.0","domain":null,"x":{"domain":"nested.io"}}' >"$TMP/inst-null.json"
assert_eq "" "$(fl 'installed_string domain' INSTALLED_FILE="$TMP/inst-null.json")" "installed_string: null -> empty, nested keys ignored"
printf '{\n  "port": 8080,\n  "dataDir": "/srv/craft/"\n}\n' >"$TMP/cfg-dd.json"
assert_eq "/srv/craft" "$(fl "CONFIG_FILE='$TMP/cfg-dd.json'; config_data_dir")" "config_data_dir reads dataDir"
assert_eq "/var/lib/craftrcon" "$(fl "CONFIG_FILE='$TMP/none.json'; config_data_dir")" "config_data_dir falls back to DATA_DIR"
mkdir -p "$TMP/bk-nodb"
assert_eq "2" "$(fl "BACKUP_DIR='$TMP/bk-nodb'; DB_DIR='$TMP/bk-nodb'; rc=0; restore_db || rc=\$?; echo \$rc")" "restore_db fails (2) when the backup has no database"

echo "backup rotation"
BR="$TMP/backups"
mkdir -p "$BR/keep-me" "$BR/20260101-000000-x"
for d in 20260101-000000-0.1.0 20260102-000000-0.1.1 20260103-000000-0.1.2 20260104-000000-0.1.3 20260105-000000-0.1.4 20260106-000000-0.1.5 20260107-000000-0.1.6; do mkdir -p "$BR/$d"; done
out="$(fl "BACKUP_ROOT='$BR'; BACKUP_DIR='$BR/20260107-000000-0.1.6'; prune_backups")"
assert_eq "20260101-000000-x 20260103-000000-0.1.2 20260104-000000-0.1.3 20260105-000000-0.1.4 20260106-000000-0.1.5 20260107-000000-0.1.6 keep-me" \
  "$(find "$BR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | paste -sd' ' -)" \
  "keeps the 5 newest backups, never touches other folders"
assert_contains "20260101-000000-0.1.0" "$out" "the deleted backups are reported"
# The backup just made is kept even when its name sorts first (a clock set back).
mkdir -p "$BR/20250101-000000-0.0.9"
fl "BACKUP_ROOT='$BR'; BACKUP_DIR='$BR/20250101-000000-0.0.9'; prune_backups" >/dev/null
assert_eq "20250101-000000-0.0.9 20260104-000000-0.1.3 20260105-000000-0.1.4 20260106-000000-0.1.5 20260107-000000-0.1.6" \
  "$(find "$BR" -mindepth 1 -maxdepth 1 -name '2*-*.*.*' -printf '%f\n' | LC_ALL=C sort | paste -sd' ' -)" \
  "prune never deletes the backup just made"

echo "sandbox: decisions before any change"
SB="$TMP/sb"
# mk_sandbox: an installed 1.4.2 panel under $SB (unit file under $SB/root).
mk_sandbox() {
  rm -rf "$SB" "$SB.calls" "$SB.running" "$SB.notroot" "$TMP/victim"
  mkdir -p "$SB/opt/app/src" "$SB/opt/node/bin" "$SB/etc" "$SB/data" "$SB/log" "$SB/root/etc/systemd/system"
  echo 1.4.2 >"$SB/opt/app/VERSION"
  echo 'old server' >"$SB/opt/app/src/server.js"
  echo 'old cli' >"$SB/opt/app/src/cli.js"
  printf '#!/bin/sh\necho v24.0.0\n' >"$SB/opt/node/bin/node"
  chmod +x "$SB/opt/node/bin/node"
  printf '{\n  "version": "1.4.2",\n  "commit": null,\n  "installedAt": "2026-10-01T00:00:00Z",\n  "port": 8080,\n  "domain": null,\n  "firewall": [{ "tool": "ufw", "port": 8080 }]\n}\n' >"$SB/opt/installed.json"
  printf '{\n  "host": "0.0.0.0",\n  "port": 8123\n}\n' >"$SB/etc/config.json"
  echo 'old-db' >"$SB/data/craftrcon.db"
  echo 'old-wal' >"$SB/data/craftrcon.db-wal"
  echo 'the-key' >"$SB/data/secret.key"
  echo 'unit-1.4.2' >"$SB/root/etc/systemd/system/craftrcon.service"
  echo 1.4.2 >"$SB.running" # the panel is running
  : >"$SB.calls"
}
# with_proxy: the sandbox was installed with a domain (Caddy + proxy service).
with_proxy() {
  printf '#!/bin/sh\n' >"$SB/opt/caddy"
  chmod +x "$SB/opt/caddy"
  echo 'example.com' >"$SB/etc/Caddyfile"
  echo 'proxy-old' >"$SB/root/etc/systemd/system/craftrcon-proxy.service"
}
# The stubs: the "panel" runs the VERSION of APP_DIR; a src/server.js containing BROKEN
# never answers (but migrates the database first, like a version that crashes late).
# SIG_IN_ROLLBACK sends HUP and PIPE to the flow when the rollback stops the panel;
# STOP_FAIL_IN_ROLLBACK makes that stop fail.
SB_STUBS='require_root() { :; }; detect_os() { INIT=systemd; LIBC=glibc; }; init_run_as() { :; }
owned_by_root() { ! grep -qxF "$1" "$SB.notroot" 2>/dev/null; }
service_stop() { if grep -q "^stop" "$SB.calls"; then
    if [ -n "${SIG_IN_ROLLBACK:-}" ]; then kill -HUP $$; kill -PIPE $$; fi
    [ -z "${STOP_FAIL_IN_ROLLBACK:-}" ] || return 1
  fi; echo stop >>"$SB.calls"; rm -f "$SB.running"; }
service_start() { if [ "${1:-}" = craftrcon-proxy ]; then echo "start proxy" >>"$SB.calls"; return 0; fi
  echo "start $(cat "$APP_DIR/VERSION")" >>"$SB.calls"; [ -z "${START_FAIL:-}" ] || return 1
  if grep -q BROKEN "$APP_DIR/src/server.js"; then echo migrated >>"$DATA_DIR/craftrcon.db"; echo shm >"$DATA_DIR/craftrcon.db-shm"; return 0; fi
  cp "$APP_DIR/VERSION" "$SB.running"; }
wait_health() { [ -f "$SB.running" ]; }
health_version() { tr -d "[:space:]" <"$SB.running"; }
node_resolve() { NODE_ACTION=keep; }
ensure_node() { NODE_BIN="$NODE_DIR/bin/node"; NPM_BIN=true; NODE_VERSION=24.0.0; }
install_app_deps() { echo deps >>"$SB.calls"; if [ -n "${SIG_IN_DEPS:-}" ]; then kill -HUP $$; fi; [ -z "${DEPS_FAIL:-}" ]; }
install() { local a=(); while [ "$#" -gt 0 ]; do case "$1" in -o | -g | -m) shift 2 ;; *) a+=("$1"); shift ;; esac; done; command install "${a[@]}"; }
mkdir() { if [ "$1" = -m ]; then shift 2; fi; command mkdir "$@"; } # (modes: Windows ACLs reject them)
chown() { :; }; public_ip() { :; }; local_ips() { :; }; HEALTH_TIMEOUT=0'
# The flow checks that curl exists (the stubs never call it): a fake one, so the sandbox
# does not depend on the host.
mkdir -p "$TMP/bin-fake"
printf '#!/bin/sh\nexit 7\n' >"$TMP/bin-fake/curl"
chmod +x "$TMP/bin-fake/curl"
# sb_run STDIN ARGS...: main ARGS against the sandbox; prints stdout+stderr and rc=N.
sb_run() {
  local in="$1" out rc=0
  shift
  out="$(env SB="$SB" SERVICE_ROOT="$SB/root" PATH="$TMP/bin-fake:$PATH" bash -c "set -Eeuo pipefail; . '$FLOWC'; OPT_DIR='$SB/opt'; APP_DIR='$SB/opt/app'; NODE_DIR='$SB/opt/node'; DATA_DIR='$SB/data'; CONF_DIR='$SB/etc'; CONFIG_FILE='$SB/etc/config.json'; LOG_FILE='$SB/log/craftrcon.log'; INSTALLED_FILE='$SB/opt/installed.json'; CADDY_BIN='$SB/opt/caddy'; CADDYFILE='$SB/etc/Caddyfile'; CADDY_DATA='$SB/data/caddy'; PROXY_LOG_FILE='$SB/log/proxy.log'; $SB_STUBS; main $*" <<<"$in" 2>&1)" || rc=$?
  printf '%s\nrc=%s' "$out" "$rc"
}
exists() { [ -e "$1" ] || [ -L "$1" ] && echo yes || echo no; }
calls() { paste -sd'|' - <"$SB.calls"; }
unit() { cat "$SB/root/etc/systemd/system/$1"; }

mk_sandbox
set_copy_version 1.4.2
touch -d '2026-01-01 00:00:00' "$SB/opt/app"
out="$(sb_run '' --yes)"
assert_contains "rc=0" "$out" "same version: exits 0"
assert_contains "CraftRCON 1.4.2 is already up to date" "$out" "same version: says it is up to date"
assert_eq "" "$(calls)" "same version: the service is not touched"
assert_eq "no" "$(exists "$SB/data/backups")" "same version: no backup"
assert_eq "2026-01-01" "$(date -r "$SB/opt/app" +%Y-%m-%d)" "same version: the application folder is not touched"
assert_contains "CraftRCON 1.4.2 ya está actualizado" "$(sb_run '' --lang es)" "same version (es)"

set_copy_version 1.0.0
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "older copy: exits 1"
assert_contains "The installed version (1.4.2) is newer than this copy (1.0.0)" "$out" "older copy: refused"
assert_eq "" "$(calls)" "older copy: the service is not touched"

set_copy_version 1.5.0
out="$(sb_run '' --non-interactive)"
assert_contains "rc=1" "$out" "--non-interactive without --yes: exits 1"
assert_contains "add --yes" "$out" "--non-interactive without --yes: says how"
assert_contains "1.4.2 → 1.5.0" "$out" "the planned update is shown"
assert_eq "" "$(calls)" "--non-interactive without --yes: nothing changes"
out="$(sb_run 'n')"
assert_contains "rc=0" "$out" "answering no: exits 0"
assert_contains "Update now? (y/n) [y]" "$out" "interactive: asks for confirmation"
assert_contains "Update cancelled" "$out" "answering no: cancelled"
assert_eq "|no" "$(calls)|$(exists "$SB/data/backups")" "answering no: nothing changes"
rm -f "$SB/root/etc/systemd/system/craftrcon.service"
out="$(sb_run 'y')"
case "$out" in *"Update now?"*) r=asked ;; *) r=not-asked ;; esac
assert_eq "not-asked" "$r" "the system is checked before asking for confirmation"
assert_contains "craftrcon service was not found" "$out" "no service unit: points to the repair"
assert_eq "" "$(calls)" "no service unit: nothing changes"
mk_sandbox
printf '{"version":"garbage"}' >"$SB/opt/installed.json"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "unreadable installed version: exits 1"
assert_contains "Cannot read the installed version" "$out" "unreadable installed version: explained"
mk_sandbox
mkdir -p "$SB/opt/app.prev"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "leftover app.prev: exits 1"
assert_contains "earlier update that did not finish" "$out" "leftover app.prev: explained"
assert_contains "may be the working previous version" "$out" "leftover app.prev: it may be the good copy"
assert_contains "sudo rm -rf $SB/opt/app && sudo mv $SB/opt/app.prev $SB/opt/app" "$out" "leftover app.prev: how to put it back"
assert_eq "" "$(calls)" "leftover app.prev: nothing changes"
mk_sandbox
rm -f "$SB/data/craftrcon.db"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "no database: exits 1"
assert_contains "The database $SB/data/craftrcon.db was not found" "$out" "no database: explained"
assert_eq "|no" "$(calls)|$(exists "$SB/data/backups")" "no database: refused before any change"

echo "sandbox: data folder hardening (symbolic links)"
mk_sandbox
mkdir -p "$SB/data/backups"
echo "$SB/data/backups" >"$SB.notroot"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "a backups folder not owned by root: exits 1"
assert_contains "is not owned by root" "$out" "a backups folder not owned by root: explained"
assert_eq "" "$(calls)" "a backups folder not owned by root: refused before any change"
mk_sandbox
echo 'not a folder' >"$SB/data/backups"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "a backups file instead of a folder: exits 1"
assert_eq "" "$(calls)" "a backups file instead of a folder: refused before any change"
if [ "$CAN_SYMLINK" = 1 ]; then
  mk_sandbox
  mkdir -p "$TMP/victim"
  echo 'victim' >"$TMP/victim/file"
  ln -s "$TMP/victim" "$SB/data/backups"
  out="$(sb_run '' --yes)"
  assert_contains "rc=1" "$out" "a backups symlink: exits 1"
  assert_contains "$SB/data/backups is a symbolic link" "$out" "a backups symlink: explained"
  assert_eq "|victim|1" "$(calls)|$(cat "$TMP/victim/file")|$(find "$TMP/victim" -mindepth 1 | wc -l | tr -d ' ')" "a backups symlink: refused with no change (nothing written through it)"
  mk_sandbox
  echo 'victim-db' >"$TMP/victim"
  rm -f "$SB/data/craftrcon.db"
  ln -s "$TMP/victim" "$SB/data/craftrcon.db"
  out="$(sb_run '' --yes)"
  assert_contains "rc=1" "$out" "a database symlink: exits 1"
  assert_eq "|no" "$(calls)|$(exists "$SB/data/backups")" "a database symlink: refused before any change"
  mk_sandbox
  rm -f "$SB/data/craftrcon.db-wal"
  echo 'victim-wal' >"$TMP/victim"
  ln -s "$TMP/victim" "$SB/data/craftrcon.db-wal"
  out="$(sb_run '' --yes)"
  assert_contains "rc=1" "$out" "a WAL symlink: exits 1"
  assert_eq "" "$(calls)" "a WAL symlink: refused before any change"
  # A link planted where an older version staged restores: a rollback must not write through it.
  mk_sandbox
  set_copy_version 1.5.0
  echo 'BROKEN' >"$COPY/src/server.js"
  echo 'shadow' >"$TMP/victim"
  ln -s "$TMP/victim" "$SB/data/.craftrcon.db.restore"
  out="$(sb_run '' --yes)"
  echo 'server' >"$COPY/src/server.js"
  assert_contains "CraftRCON 1.4.2 was restored" "$out" "planted .restore link: the rollback completes"
  assert_eq "shadow|yes" "$(cat "$TMP/victim")|$([ -L "$SB/data/.craftrcon.db.restore" ] && echo yes)" "planted .restore link: its target is untouched"
  assert_eq "old-db|no" "$(cat "$SB/data/craftrcon.db")|$([ -L "$SB/data/craftrcon.db" ] && echo yes || echo no)" "planted .restore link: the database is restored as a plain file"
else
  echo "  (skipped: this system cannot create symbolic links)"
fi

echo "sandbox: successful update"
mk_sandbox
with_proxy
mkdir -p "$SB/data/backups/keep-me"
for d in 20260101-000000-0.1.0 20260102-000000-0.1.1 20260103-000000-0.1.2 20260104-000000-0.1.3 20260105-000000-0.1.4 20260106-000000-0.1.5; do mkdir -p "$SB/data/backups/$d"; done
key_before="$(cksum <"$SB/data/secret.key")"
cfg_before="$(cksum <"$SB/etc/config.json")"
out="$(sb_run '' --yes)"
assert_contains "rc=0" "$out" "update exits 0"
if ! [[ "$out" == *rc=0 ]]; then printf '%s\n' "$out" | tail -n 20; fi
assert_eq "stop|deps|start 1.5.0|start proxy" "$(calls)" "stop, dependencies, start the new version, restart the changed proxy"
assert_eq "1.5.0" "$(cat "$SB/opt/app/VERSION")" "the new application is in place"
assert_eq "items" "$(cat "$SB/opt/app/public/js/data/items.js" 2>/dev/null)" "nested data folders are copied"
assert_eq "no|no" "$(exists "$SB/opt/app/data")|$(exists "$SB/opt/app/test")" "the copy's data/ and test/ are not copied"
assert_eq "no" "$(exists "$SB/opt/app.prev")" "the previous application is removed after success"
assert_contains "ExecStart=$SB/opt/node/bin/node --disable-warning=ExperimentalWarning $SB/opt/app/src/server.js" "$(unit craftrcon.service)" "the service file is re-rendered from the new templates"
assert_contains "ExecStart=$SB/opt/caddy" "$(unit craftrcon-proxy.service)" "the proxy service file is re-rendered too"
inst="$(cat "$SB/opt/installed.json")"
assert_contains '"version": "1.5.0"' "$inst" "installed.json: new version"
assert_contains '"installedAt": "2026-10-01T00:00:00Z"' "$inst" "installed.json: installedAt kept"
assert_contains '"updatedAt": "20' "$inst" "installed.json: updatedAt"
assert_contains '"port": 8080' "$inst" "installed.json: port kept"
assert_contains '"domain": null' "$inst" "installed.json: domain kept"
assert_contains '"firewall": [{ "tool": "ufw", "port": 8080 }]' "$inst" "installed.json: firewall rules kept"
assert_eq "no" "$(exists "$SB/opt/installed.json.tmp")" "installed.json is written through a temp file + rename (none left)"
assert_eq "$key_before|$cfg_before" "$(cksum <"$SB/data/secret.key")|$(cksum <"$SB/etc/config.json")" "secret.key and config.json untouched"
assert_eq "old-db" "$(cat "$SB/data/craftrcon.db")" "the database is kept"
bk="$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '*-1.4.2' | head -n 1)"
assert_eq "yes" "$([ -n "$bk" ] && echo yes || echo no)" "a backup folder <date>-1.4.2 exists"
assert_eq "craftrcon.db craftrcon.db-wal config.json installed.json craftrcon.unit craftrcon-proxy.unit " "$(for f in craftrcon.db craftrcon.db-wal config.json installed.json craftrcon.unit craftrcon-proxy.unit; do [ -f "$bk/$f" ] && printf '%s ' "$f"; done)" "the backup has the database (+ WAL), config.json, installed.json and the service files"
assert_eq "unit-1.4.2|proxy-old" "$(cat "$bk/craftrcon.unit")|$(cat "$bk/craftrcon-proxy.unit")" "the backup has the previous service files"
assert_eq "no" "$(exists "$bk/secret.key")" "secret.key is not copied into the backup"
assert_contains '"version": "1.4.2"' "$(cat "$bk/installed.json")" "the backup has the previous installed.json"
assert_eq "" "$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '.partial-*')" "no unfinished (.partial) backup is left"
assert_eq "5|yes" "$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '2*' | wc -l | tr -d ' ')|$(exists "$SB/data/backups/keep-me")" "only the 5 newest backups are kept"
assert_eq "no" "$(exists "$SB/data/backups/20260101-000000-0.1.0")" "the oldest backup is deleted"
assert_contains "1.4.2 → 1.5.0" "$out" "the result shows old → new"
assert_contains "CraftRCON updated" "$out" "the result says it was updated"
assert_contains ":8123" "$out" "the URL uses the configured port"

echo "sandbox: the new version does not start -> rollback"
cp "$SB/data/craftrcon.db" "$TMP/db.before"
echo 'wal-1.5.0' >"$SB/data/craftrcon.db-wal"
echo 'unit-1.5.0' >"$SB/root/etc/systemd/system/craftrcon.service"
echo 'proxy-1.5.0' >"$SB/root/etc/systemd/system/craftrcon-proxy.service"
set_copy_version 1.6.0
echo 'BROKEN' >"$COPY/src/server.js"
: >"$SB.calls"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "a failed update exits 1"
assert_eq "stop|deps|start 1.6.0|stop|start 1.5.0|start proxy" "$(calls)" "rollback: stop, back to the previous version, start (and the proxy with its old file)"
assert_contains "failed while: Starting the new version" "$out" "the failing step is named"
assert_contains "CraftRCON 1.5.0 was restored" "$out" "says the previous version was restored"
assert_contains "changes made while the new version was running were discarded" "$out" "says the new version's changes were discarded"
bk="$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '*-1.5.0' | head -n 1)"
assert_contains "Backup of the data: $bk" "$out" "the backup path is shown"
assert_contains "also saved in $bk/update.log" "$out" "the report location is shown"
assert_contains "CraftRCON 1.5.0 was restored" "$(cat "$bk/update.log" 2>/dev/null)" "the report is saved in update.log"
assert_eq "1.5.0" "$(cat "$SB/opt/app/VERSION")" "the previous application is back"
assert_eq "server" "$(cat "$SB/opt/app/src/server.js")" "the previous server.js is back"
assert_eq "no" "$(exists "$SB/opt/app.prev")" "no app.prev is left"
assert_eq "unit-1.5.0|proxy-1.5.0" "$(unit craftrcon.service)|$(unit craftrcon-proxy.service)" "the previous service files are back"
assert_eq "$(cat "$TMP/db.before")|wal-1.5.0|no" "$(cat "$SB/data/craftrcon.db")|$(cat "$SB/data/craftrcon.db-wal")|$(exists "$SB/data/craftrcon.db-shm")" "the database (and its WAL) is restored from the backup; a new -shm is removed"
assert_eq "" "$(find "$bk" -name '.restore-*')" "no staged restore copies are left"
assert_contains '"version": "1.5.0"' "$(cat "$SB/opt/installed.json")" "installed.json still says 1.5.0"
assert_eq "1.5.0" "$(cat "$SB.running")" "the previous version is running"
echo 'server' >"$COPY/src/server.js"

echo "sandbox: npm fails -> rollback without touching the database"
mk_sandbox
set_copy_version 1.5.0
out="$(DEPS_FAIL=1 sb_run '' --yes)"
assert_contains "rc=1" "$out" "npm failure exits 1"
assert_contains "failed while: Installing the dependencies" "$out" "the failing step is named"
assert_contains "Command failed" "$out" "the failing command is reported"
assert_eq "stop|deps|stop|start 1.4.2" "$(calls)" "rollback after npm: the new version never started"
assert_eq "1.4.2|old-db|no|unit-1.4.2" "$(cat "$SB/opt/app/VERSION")|$(cat "$SB/data/craftrcon.db")|$(exists "$SB/opt/app.prev")|$(unit craftrcon.service)" "application back, database and service file untouched"

echo "sandbox: SIGHUP (dropped SSH session) during the update -> rollback"
mk_sandbox
set_copy_version 1.5.0
out="$(SIG_IN_DEPS=1 sb_run '' --yes)"
assert_contains "rc=1" "$out" "HUP during the update exits 1"
assert_contains "CraftRCON 1.4.2 was restored" "$out" "HUP during the update rolls back"
assert_eq "1.4.2|1.4.2|no" "$(cat "$SB/opt/app/VERSION")|$(cat "$SB.running")|$(exists "$SB/opt/app.prev")" "HUP: the previous version is back and running"

echo "sandbox: SIGHUP + SIGPIPE during the rollback -> the rollback still completes"
mk_sandbox
set_copy_version 1.5.0
echo 'BROKEN' >"$COPY/src/server.js"
out="$(SIG_IN_ROLLBACK=1 sb_run '' --yes)"
echo 'server' >"$COPY/src/server.js"
assert_contains "rc=1" "$out" "signals during the rollback: exits 1"
assert_eq "1.4.2|1.4.2|old-db|no" "$(cat "$SB/opt/app/VERSION")|$(cat "$SB.running" 2>/dev/null)|$(cat "$SB/data/craftrcon.db")|$(exists "$SB/opt/app.prev")" "signals during the rollback: app and database restored, previous version running"
bk="$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '*-1.4.2' | head -n 1)"
assert_contains "CraftRCON 1.4.2 was restored" "$(cat "$bk/update.log" 2>/dev/null)" "signals during the rollback: the report is in update.log"

echo "sandbox: the new version cannot be stopped -> the database is not restored"
mk_sandbox
set_copy_version 1.5.0
echo 'BROKEN' >"$COPY/src/server.js"
out="$(STOP_FAIL_IN_ROLLBACK=1 sb_run '' --yes)"
echo 'server' >"$COPY/src/server.js"
assert_contains "rc=1" "$out" "stop failure in the rollback: exits 1"
assert_contains "the database was not restored because the new version could not be stopped" "$out" "says the database was left alone"
assert_contains "$(printf 'old-db\nmigrated')" "$(cat "$SB/data/craftrcon.db")" "the database is not replaced under a running panel"
assert_contains "Put the database back from the backup:" "$out" "the database restore is a manual step"
assert_contains "Stop the panel: systemctl stop craftrcon" "$out" "manual step: stop first"

echo "sandbox: the rollback itself fails -> manual steps"
mk_sandbox
set_copy_version 1.5.0
out="$(START_FAIL=1 sb_run '' --yes)"
assert_contains "rc=1" "$out" "failed rollback exits 1"
assert_contains "automatic rollback did not finish (starting the panel" "$out" "says what in the rollback failed"
assert_contains "Restore CraftRCON 1.4.2 by hand" "$out" "manual recovery header"
assert_contains "1. Stop the panel: systemctl stop craftrcon" "$out" "manual step: stop"
assert_contains "Start the panel: systemctl start craftrcon" "$out" "manual step: start"
assert_contains "curl -s http://127.0.0.1:8123/api/health" "$out" "manual step: check"
case "$out" in *"Put the previous application back"* | *"service file back"*) r=listed ;; *) r=absent ;; esac
assert_eq "absent" "$r" "what was restored is not a manual step"
assert_eq "1.4.2|unit-1.4.2" "$(cat "$SB/opt/app/VERSION")|$(unit craftrcon.service)" "the application and the service file were still restored"

echo "sandbox: dataDir from config.json"
mk_sandbox
mkdir -p "$SB/data2"
mv "$SB/data/craftrcon.db" "$SB/data2/craftrcon.db"
rm -f "$SB/data/craftrcon.db-wal"
printf '{\n  "port": 8123,\n  "dataDir": "%s"\n}\n' "$SB/data2" >"$SB/etc/config.json"
out="$(sb_run '' --yes)"
assert_contains "rc=0" "$out" "update with another dataDir exits 0"
bk="$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '*-1.4.2' | head -n 1)"
assert_eq "old-db" "$(cat "$bk/craftrcon.db" 2>/dev/null)" "the database is backed up from config.json's dataDir"

finish
