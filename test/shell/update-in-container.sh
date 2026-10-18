#!/usr/bin/env bash
# End-to-end test of ./update.sh inside a container (no init system, so --no-service).
# Installs 0.1.0 from the working tree, creates a server through the API, then runs
# ./update.sh from copies of the project with other versions:
#   same version (0.1.0) -> "already up to date", nothing touched;
#   0.2.0                -> updated, data kept, backup made;
#   0.1.5                -> refused (downgrade);
#   0.3.0, broken        -> automatic rollback to 0.2.0, data intact.
#
# Usage: bash test/shell/update-in-container.sh <debian12|ubuntu24|rocky9|fedora>
# Env:   KEEP=1 keeps the container and image for debugging.
# shellcheck disable=SC2016 # in_ct snippets are single-quoted on purpose (they expand in the container)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=assert.sh
. "$HERE/assert.sh"

distro="${1:-}"
if [ -z "$distro" ] || [ ! -f "$HERE/Dockerfile.$distro" ]; then
  echo "usage: bash test/shell/update-in-container.sh <debian12|ubuntu24|rocky9|fedora>" >&2
  exit 2
fi

PASSWORD=testpass123
PORT=8080
tag="craftrcon-update-test:$distro"
name="craftrcon-update-test-$distro-$$"
logfile="${TMPDIR:-/tmp}/craftrcon-update-$distro.log"

# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  if [ -n "${KEEP:-}" ]; then
    echo "kept container $name and image $tag"
    return
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker rmi -f "$tag" >/dev/null 2>&1 || true
}
trap cleanup EXIT

in_ct() { docker exec "$name" sh -c "$1"; }
# update_in DIR ARGS...: runs ./update.sh from the copy in DIR; output in $logfile, returns its rc.
update_in() {
  local dir="$1"
  shift
  # (MSYS_NO_PATHCONV: Git Bash on Windows would rewrite the -w path)
  MSYS_NO_PATHCONV=1 docker exec -w "$dir" "$name" ./update.sh "$@" >"$logfile" 2>&1
}
health() { in_ct "curl -fsS http://127.0.0.1:$PORT/api/health" 2>/dev/null; }
health_version() { health | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
login() {
  in_ct "curl -s -o /dev/null -w '%{http_code}' -c /tmp/jar -X POST -H 'Content-Type: application/json' \
    -H 'Origin: http://127.0.0.1:$PORT' -d '{\"password\":\"$1\"}' http://127.0.0.1:$PORT/api/login"
}
servers() { in_ct "curl -s -b /tmp/jar http://127.0.0.1:$PORT/api/servers"; }
panel_count() {
  in_ct 'n=0; for p in /proc/[0-9]*; do a0="$(tr "\0" "\n" <"$p/cmdline" 2>/dev/null | head -n 1)"; [ "$a0" = /opt/craftrcon/node/bin/node ] && n=$((n + 1)); done; echo $n'
}
show_log_on_fail() { # show_log_on_fail EXPECTED_RC RC
  if [ "$1" != "$2" ]; then tail -n 40 "$logfile"; fi
}

echo "== $distro: building $tag"
if ! tar -C "$ROOT" --exclude=./node_modules --exclude=./data --exclude=./.git -cf - . |
  docker build -q -t "$tag" -f "test/shell/Dockerfile.$distro" - >/dev/null; then
  echo "FAIL: image build failed" >&2
  exit 1
fi
docker run -d --name "$name" "$tag" sleep infinity >/dev/null || exit 1

# The copies a user would download: the working tree as 0.1.0, 0.2.0, 0.1.5, and a 0.3.0
# whose server crashes on start.
in_ct 'set -e
  echo 0.1.0 >/tmp/craftrcon/VERSION
  for v in 0.2.0 0.1.5 0.3.0; do cp -a /tmp/craftrcon "/tmp/v$v"; echo "$v" >"/tmp/v$v/VERSION"; done
  echo "throw new Error(\"broken on purpose\");" >/tmp/v0.3.0/src/server.js'

echo "== $distro: before an installation"
out="$(docker exec "$name" ./update.sh --bogus 2>&1)"
assert_eq "2" "$?" "unknown flag exits 2"
assert_contains "Usage: sudo ./update.sh" "$out" "unknown flag prints the usage"
out="$(docker exec "$name" ./update.sh --yes --no-service 2>&1)"
assert_eq "1" "$?" "not installed exits 1"
assert_contains "sudo ./install.sh" "$out" "not installed points to ./install.sh"

echo "== $distro: install 0.1.0 and create a server"
start=$SECONDS
docker exec -e CRAFTRCON_PASSWORD="$PASSWORD" "$name" ./install.sh --non-interactive --no-service >"$logfile" 2>&1
rc=$?
echo "   (install took $((SECONDS - start)) s)"
assert_eq "0" "$rc" "install exits 0"
show_log_on_fail 0 "$rc"
assert_eq "0.1.0" "$(health_version)" "0.1.0 is running"
assert_eq "204" "$(login "$PASSWORD")" "login"
code="$(in_ct "curl -s -o /dev/null -w '%{http_code}' -b /tmp/jar -X POST -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:$PORT' -d '{\"name\":\"Survival\",\"host\":\"127.0.0.1\",\"password\":\"rconpass1\"}' \
  http://127.0.0.1:$PORT/api/servers")"
assert_eq "201" "$code" "a server is created through the API"
assert_contains '"name":"Survival"' "$(servers)" "the server is listed"
out="$(docker exec -u 65534:65534 "$name" ./update.sh --yes 2>&1)"
assert_eq "1" "$?" "non-root exits 1"
assert_contains "sudo ./update.sh" "$out" "non-root message suggests sudo ./update.sh"
key_sum="$(in_ct 'cksum </var/lib/craftrcon/secret.key')"
cfg_sum="$(in_ct 'cksum </etc/craftrcon/config.json')"

echo "== $distro: same version"
mtime="$(in_ct 'stat -c %Y /opt/craftrcon/app')"
update_in /tmp/craftrcon --non-interactive --no-service
rc=$?
assert_eq "0" "$rc" "same version exits 0"
assert_contains "CraftRCON 0.1.0 is already up to date" "$(cat "$logfile")" "same version: already up to date"
assert_eq "$mtime" "$(in_ct 'stat -c %Y /opt/craftrcon/app')" "same version: the application folder is untouched (mtime)"
assert_eq "absent" "$(in_ct 'test -e /var/lib/craftrcon/backups && echo present || echo absent')" "same version: no backup"
assert_eq "0.1.0|1" "$(health_version)|$(panel_count)" "same version: the panel kept running"

echo "== $distro: update to 0.2.0"
update_in /tmp/v0.2.0 --non-interactive --no-service
assert_eq "1" "$?" "--non-interactive without --yes exits 1"
assert_contains "add --yes" "$(cat "$logfile")" "--non-interactive without --yes explains it"
assert_eq "0.1.0" "$(health_version)" "without --yes nothing changed"
start=$SECONDS
update_in /tmp/v0.2.0 --yes --non-interactive --no-service
rc=$?
echo "   (update took $((SECONDS - start)) s, log: $logfile)"
assert_eq "0" "$rc" "update to 0.2.0 exits 0"
show_log_on_fail 0 "$rc"
log="$(cat "$logfile")"
assert_contains "0.1.0 → 0.2.0" "$log" "the update shows old → new"
assert_contains "http://" "$log" "the update shows the panel URL"
assert_eq "0.2.0" "$(health_version)" "/api/health reports 0.2.0"
assert_contains '"name":"Survival"' "$(servers)" "the server created before is still there (session kept too)"
assert_eq "204" "$(login "$PASSWORD")" "the password is unchanged"
assert_eq "1" "$(panel_count)" "exactly one panel process"
inst="$(in_ct 'cat /opt/craftrcon/installed.json')"
assert_contains '"version": "0.2.0"' "$inst" "installed.json: version 0.2.0"
assert_contains '"updatedAt": "20' "$inst" "installed.json: updatedAt"
assert_contains '"port": 8080' "$inst" "installed.json: port kept"
assert_contains '"firewall": []' "$inst" "installed.json: firewall kept"
assert_eq "absent" "$(in_ct 'test -e /opt/craftrcon/app.prev && echo present || echo absent')" "app.prev removed"
assert_eq "$key_sum|$cfg_sum" "$(in_ct 'cksum </var/lib/craftrcon/secret.key')|$(in_ct 'cksum </etc/craftrcon/config.json')" "secret.key and config.json untouched"
bk="$(in_ct 'ls -d /var/lib/craftrcon/backups/*-0.1.0 2>/dev/null')"
assert_contains "/var/lib/craftrcon/backups/20" "$bk" "backup <date>-0.1.0 exists"
assert_eq "700 root:root" "$(in_ct "stat -c '%a %U:%G' '$bk'")" "the backup is 0700 root"
assert_eq "ok" "$(in_ct "test -f '$bk/craftrcon.db' && test -f '$bk/config.json' && test -f '$bk/installed.json' && echo ok")" "the backup has the database, config.json and installed.json"
assert_eq "absent" "$(in_ct "test -e '$bk/secret.key' && echo present || echo absent")" "secret.key is not in the backup"
assert_eq "755 root:root" "$(in_ct "stat -c '%a %U:%G' /opt/craftrcon/app")" "the new application is 0755 root"
assert_eq "ok" "$(in_ct 'test -f /opt/craftrcon/app/node_modules/fastify/package.json && test -f /opt/craftrcon/app/public/js/data/commands.js && echo ok')" "dependencies and nested data folders are in place"
update_in /tmp/v0.2.0 --lang es --non-interactive --no-service
assert_contains "CraftRCON 0.2.0 ya está actualizado" "$(cat "$logfile")" "same version in Spanish"

echo "== $distro: older copy (0.1.5)"
update_in /tmp/v0.1.5 --yes --non-interactive --no-service
assert_eq "1" "$?" "downgrade exits 1"
assert_contains "newer than this copy" "$(cat "$logfile")" "downgrade is refused"
assert_eq "0.2.0|1" "$(health_version)|$(panel_count)" "downgrade: 0.2.0 keeps running"

echo "== $distro: broken 0.3.0 -> rollback"
start=$SECONDS
update_in /tmp/v0.3.0 --yes --non-interactive --no-service
rc=$?
echo "   (failed update took $((SECONDS - start)) s)"
assert_eq "1" "$rc" "broken update exits 1"
log="$(cat "$logfile")"
assert_contains "failed while: Starting the new version" "$log" "the failing step is named"
assert_contains "CraftRCON 0.2.0 was restored" "$log" "says it rolled back"
assert_contains "Backup of the data: /var/lib/craftrcon/backups/" "$log" "the backup path is shown"
assert_eq "0.2.0" "$(health_version)" "/api/health reports 0.2.0 again"
assert_eq "ok" "$(in_ct 'ls -d /var/lib/craftrcon/backups/*-0.2.0 >/dev/null && echo ok')" "the backup <date>-0.2.0 exists"
assert_eq "ok" "$(in_ct 'grep -q "CraftRCON 0.2.0 was restored" /var/lib/craftrcon/backups/*-0.2.0/update.log && echo ok')" "the rollback report is saved in the backup's update.log"
assert_eq "700 root:root|none" "$(in_ct "stat -c '%a %U:%G' /var/lib/craftrcon/backups")|$(in_ct 'ls -d /var/lib/craftrcon/backups/.partial-* 2>/dev/null || echo none')" "the backups folder is root-only and has no unfinished backup"
assert_contains '"name":"Survival"' "$(servers)" "the data is intact after the rollback"
assert_eq "204" "$(login "$PASSWORD")" "the password still works after the rollback"
assert_contains '"version": "0.2.0"' "$(in_ct 'cat /opt/craftrcon/installed.json')" "installed.json still says 0.2.0"
assert_eq "absent" "$(in_ct 'test -e /opt/craftrcon/app.prev && echo present || echo absent')" "no app.prev left"
assert_eq "1" "$(panel_count)" "exactly one panel process after the rollback"
assert_eq "$key_sum|$cfg_sum" "$(in_ct 'cksum </var/lib/craftrcon/secret.key')|$(in_ct 'cksum </etc/craftrcon/config.json')" "secret.key and config.json still untouched"

finish
