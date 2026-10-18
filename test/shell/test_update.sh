#!/usr/bin/env bash
# Unit tests for scripts/update-flow.sh: options, the version decision (equal / older /
# newer), confirmation, backups and their rotation, and the whole update with automatic
# rollback against a sandbox (temp dirs, stubbed service manager, npm and health check).
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
for f in --yes --non-interactive --no-service --lang; do assert_contains "$f" "$out" "usage lists $f"; done
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
printf '{"name":"x","engines":{"node":">= 24.1.2"},"version":"1.0.0"}' >"$TMP/pkg.json"
assert_eq "24.1.2" "$(fl "SRC_DIR='$TMP'; mv '$TMP/pkg.json' '$TMP/package.json'; engines_node_min")" "engines_node_min (compact JSON)"
inst="$(fl 'UPDATED_AT=2026-10-17T10:00:00Z; installed_json 1.5.0 "" 2026-10-16T00:00:00Z 8080 "" ufw:8080')"
assert_contains '"updatedAt": "2026-10-17T10:00:00Z",' "$inst" "installed_json adds updatedAt when UPDATED_AT is set"
assert_contains '"installedAt": "2026-10-16T00:00:00Z",' "$inst" "installed_json keeps installedAt"
case "$(fl 'installed_json 1.5.0 "" T 8080 ""')" in *updatedAt*) r=present ;; *) r=absent ;; esac
assert_eq "absent" "$r" "installed_json without UPDATED_AT has no updatedAt (install format unchanged)"
assert_eq "2026-10-16T10:00:00Z" "$(fl 'installed_string installedAt' INSTALLED_FILE="$FIX/installed.json")" "installed_string reads a top-level string"
printf '{"version":"1.0.0","domain":null,"x":{"domain":"nested.io"}}' >"$TMP/inst-null.json"
assert_eq "" "$(fl 'installed_string domain' INSTALLED_FILE="$TMP/inst-null.json")" "installed_string: null -> empty, nested keys ignored"

echo "backup rotation"
BR="$TMP/backups"
mkdir -p "$BR/keep-me" "$BR/20260101-000000-x"
for d in 20260101-000000-0.1.0 20260102-000000-0.1.1 20260103-000000-0.1.2 20260104-000000-0.1.3 20260105-000000-0.1.4 20260106-000000-0.1.5 20260107-000000-0.1.6; do mkdir -p "$BR/$d"; done
out="$(fl "BACKUP_ROOT='$BR'; prune_backups")"
assert_eq "20260101-000000-x 20260103-000000-0.1.2 20260104-000000-0.1.3 20260105-000000-0.1.4 20260106-000000-0.1.5 20260107-000000-0.1.6 keep-me" \
  "$(find "$BR" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort | paste -sd' ' -)" \
  "keeps the 5 newest backups, never touches other folders"
assert_contains "20260101-000000-0.1.0" "$out" "the deleted backups are reported"

echo "sandbox: decisions before any change"
SB="$TMP/sb"
mkdir -p "$TMP/bin"
# mk_sandbox: an installed 1.4.2 panel under $SB (unit file under $SB/root).
mk_sandbox() {
  rm -rf "$SB" "$SB.calls" "$SB.running"
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
  echo x >"$SB/root/etc/systemd/system/craftrcon.service"
  echo 1.4.2 >"$SB.running" # the panel is running
  : >"$SB.calls"
}
# The stubs: the "panel" runs the VERSION of APP_DIR; a src/server.js containing BROKEN
# never answers (but migrates the database first, like a version that crashes late).
SB_STUBS='require_root() { :; }; detect_os() { INIT=systemd; LIBC=glibc; }; init_run_as() { :; }
service_stop() { echo stop >>"$SB.calls"; rm -f "$SB.running"; }
service_start() { echo "start $(cat "$APP_DIR/VERSION")" >>"$SB.calls"; [ -z "${START_FAIL:-}" ] || return 1
  if grep -q BROKEN "$APP_DIR/src/server.js"; then echo migrated >>"$DATA_DIR/craftrcon.db"; echo shm >"$DATA_DIR/craftrcon.db-shm"; return 0; fi
  cp "$APP_DIR/VERSION" "$SB.running"; }
wait_health() { [ -f "$SB.running" ]; }
health_version() { tr -d "[:space:]" <"$SB.running"; }
node_resolve() { NODE_ACTION=keep; }
ensure_node() { NODE_BIN="$NODE_DIR/bin/node"; NPM_BIN=true; NODE_VERSION=24.0.0; }
install_app_deps() { echo deps >>"$SB.calls"; [ -z "${DEPS_FAIL:-}" ]; }
install() { local a=(); while [ "$#" -gt 0 ]; do case "$1" in -o | -g | -m) shift 2 ;; *) a+=("$1"); shift ;; esac; done; command install "${a[@]}"; }
chown() { :; }; public_ip() { :; }; local_ips() { :; }; HEALTH_TIMEOUT=0'
# sb_run STDIN ARGS...: main ARGS against the sandbox; prints stdout+stderr and rc=N.
sb_run() {
  local in="$1" out rc=0
  shift
  out="$(env SB="$SB" SERVICE_ROOT="$SB/root" bash -c "set -Eeuo pipefail; . '$FLOWC'; OPT_DIR='$SB/opt'; APP_DIR='$SB/opt/app'; NODE_DIR='$SB/opt/node'; DATA_DIR='$SB/data'; CONF_DIR='$SB/etc'; CONFIG_FILE='$SB/etc/config.json'; LOG_FILE='$SB/log/craftrcon.log'; INSTALLED_FILE='$SB/opt/installed.json'; $SB_STUBS; main $*" <<<"$in" 2>&1)" || rc=$?
  printf '%s\nrc=%s' "$out" "$rc"
}
exists() { [ -e "$1" ] && echo yes || echo no; }
calls() { paste -sd'|' - <"$SB.calls"; }

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
printf '{"version":"garbage"}' >"$SB/opt/installed.json"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "unreadable installed version: exits 1"
assert_contains "Cannot read the installed version" "$out" "unreadable installed version: explained"
mk_sandbox
mkdir -p "$SB/opt/app.prev"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "leftover app.prev: exits 1"
assert_contains "earlier update that did not finish" "$out" "leftover app.prev: explained"
assert_eq "" "$(calls)" "leftover app.prev: nothing changes"
mk_sandbox
rm -f "$SB/root/etc/systemd/system/craftrcon.service"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "no service unit: exits 1"
assert_contains "craftrcon service was not found" "$out" "no service unit: points to the repair"
assert_eq "" "$(calls)" "no service unit: nothing changes"

echo "sandbox: successful update"
mk_sandbox
mkdir -p "$SB/data/backups/keep-me"
for d in 20260101-000000-0.1.0 20260102-000000-0.1.1 20260103-000000-0.1.2 20260104-000000-0.1.3 20260105-000000-0.1.4 20260106-000000-0.1.5; do mkdir -p "$SB/data/backups/$d"; done
key_before="$(cksum <"$SB/data/secret.key")"
cfg_before="$(cksum <"$SB/etc/config.json")"
out="$(sb_run '' --yes)"
assert_contains "rc=0" "$out" "update exits 0"
if ! [[ "$out" == *rc=0 ]]; then printf '%s\n' "$out" | tail -n 20; fi
assert_eq "stop|deps|start 1.5.0" "$(calls)" "stop, dependencies, start the new version"
assert_eq "1.5.0" "$(cat "$SB/opt/app/VERSION")" "the new application is in place"
assert_eq "items" "$(cat "$SB/opt/app/public/js/data/items.js" 2>/dev/null)" "nested data folders are copied"
assert_eq "no|no" "$(exists "$SB/opt/app/data")|$(exists "$SB/opt/app/test")" "the copy's data/ and test/ are not copied"
assert_eq "no" "$(exists "$SB/opt/app.prev")" "the previous application is removed after success"
inst="$(cat "$SB/opt/installed.json")"
assert_contains '"version": "1.5.0"' "$inst" "installed.json: new version"
assert_contains '"installedAt": "2026-10-01T00:00:00Z"' "$inst" "installed.json: installedAt kept"
assert_contains '"updatedAt": "20' "$inst" "installed.json: updatedAt"
assert_contains '"port": 8080' "$inst" "installed.json: port kept"
assert_contains '"domain": null' "$inst" "installed.json: domain kept"
assert_contains '"firewall": [{ "tool": "ufw", "port": 8080 }]' "$inst" "installed.json: firewall rules kept"
assert_eq "$key_before|$cfg_before" "$(cksum <"$SB/data/secret.key")|$(cksum <"$SB/etc/config.json")" "secret.key and config.json untouched"
assert_eq "old-db" "$(cat "$SB/data/craftrcon.db")" "the database is kept"
bk="$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '*-1.4.2' | head -n 1)"
assert_eq "yes" "$([ -n "$bk" ] && echo yes || echo no)" "a backup folder <date>-1.4.2 exists"
assert_eq "craftrcon.db craftrcon.db-wal config.json installed.json " "$(for f in craftrcon.db craftrcon.db-wal config.json installed.json; do [ -f "$bk/$f" ] && printf '%s ' "$f"; done)" "the backup has the database (+ WAL), config.json and installed.json"
assert_eq "no" "$(exists "$bk/secret.key")" "secret.key is not copied into the backup"
assert_contains '"version": "1.4.2"' "$(cat "$bk/installed.json")" "the backup has the previous installed.json"
assert_eq "5|yes" "$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '2*' | wc -l | tr -d ' ')|$(exists "$SB/data/backups/keep-me")" "only the 5 newest backups are kept"
assert_eq "no" "$(exists "$SB/data/backups/20260101-000000-0.1.0")" "the oldest backup is deleted"
assert_contains "1.4.2 → 1.5.0" "$out" "the result shows old → new"
assert_contains "CraftRCON updated" "$out" "the result says it was updated"
assert_contains ":8123" "$out" "the URL uses the configured port"

echo "sandbox: the new version does not start -> rollback"
cp "$SB/data/craftrcon.db" "$TMP/db.before"
echo 'wal-1.5.0' >"$SB/data/craftrcon.db-wal"
set_copy_version 1.6.0
echo 'BROKEN' >"$COPY/src/server.js"
out="$(sb_run '' --yes)"
assert_contains "rc=1" "$out" "a failed update exits 1"
assert_eq "stop|deps|start 1.6.0|stop|start 1.5.0" "$(calls | sed 's/^stop|deps|start 1.5.0|//')" "rollback: stop, back to the previous version, start"
assert_contains "failed while: Starting the new version" "$out" "the failing step is named"
assert_contains "CraftRCON 1.5.0 was restored" "$out" "says the previous version was restored"
bk="$(find "$SB/data/backups" -mindepth 1 -maxdepth 1 -name '*-1.5.0' | head -n 1)"
assert_contains "Backup of the data: $bk" "$out" "the backup path is shown"
assert_eq "1.5.0" "$(cat "$SB/opt/app/VERSION")" "the previous application is back"
assert_eq "server" "$(cat "$SB/opt/app/src/server.js")" "the previous server.js is back"
assert_eq "no" "$(exists "$SB/opt/app.prev")" "no app.prev is left"
assert_eq "$(cat "$TMP/db.before")|wal-1.5.0|no" "$(cat "$SB/data/craftrcon.db")|$(cat "$SB/data/craftrcon.db-wal")|$(exists "$SB/data/craftrcon.db-shm")" "the database (and its WAL) is restored from the backup; a new -shm is removed"
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
assert_eq "1.4.2|old-db|no" "$(cat "$SB/opt/app/VERSION")|$(cat "$SB/data/craftrcon.db")|$(exists "$SB/opt/app.prev")" "application back, database untouched"

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
case "$out" in *"Put the previous application back"*) r=listed ;; *) r=absent ;; esac
assert_eq "absent" "$r" "the application was restored, so it is not a manual step"
assert_eq "1.4.2" "$(cat "$SB/opt/app/VERSION")" "the application was still restored"

finish
