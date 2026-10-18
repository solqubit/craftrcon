#!/usr/bin/env bash
# End-to-end test of the fresh-install flow inside a container (no init system, so it
# uses --no-service). Builds test/shell/Dockerfile.<distro> with the working tree as
# context, runs ./install.sh --non-interactive --no-service and checks the panel.
#
# Usage: bash test/shell/install-in-container.sh <debian12|ubuntu24|rocky9|fedora>
# Env:   KEEP=1 keeps the container and image for debugging.
#        INSTALL_LANG=es runs the installer with --lang es.
# shellcheck disable=SC2016 # in_ct snippets are single-quoted on purpose (they expand in the container)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=assert.sh
. "$HERE/assert.sh"

distro="${1:-}"
if [ -z "$distro" ] || [ ! -f "$HERE/Dockerfile.$distro" ]; then
  echo "usage: bash test/shell/install-in-container.sh <debian12|ubuntu24|rocky9|fedora>" >&2
  exit 2
fi

PASSWORD=testpass123
PORT=8080
tag="craftrcon-test:$distro"
name="craftrcon-test-$distro-$$"
logfile="${TMPDIR:-/tmp}/craftrcon-install-$distro.log"
version="$(tr -d '[:space:]' <"$ROOT/VERSION")"

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

# Runs a shell snippet inside the container (as root unless extra docker exec args say so).
in_ct() { docker exec "$name" sh -c "$1"; }

echo "== $distro: building $tag"
# The build context is the working tree streamed as a tar, without the heavy or
# host-specific directories (node_modules here may come from another OS).
if ! tar -C "$ROOT" --exclude=./node_modules --exclude=./data --exclude=./.git -cf - . |
  docker build -q -t "$tag" -f "test/shell/Dockerfile.$distro" - >/dev/null; then
  echo "FAIL: image build failed" >&2
  exit 1
fi
docker run -d --name "$name" "$tag" sleep infinity >/dev/null || exit 1

echo "== $distro: pre-install checks"
out="$(docker exec "$name" ./install.sh --bogus 2>&1)"
assert_eq "2" "$?" "unknown flag exits 2"
assert_contains "--non-interactive" "$out" "unknown flag prints the usage"
out="$(docker exec -u 65534:65534 "$name" ./install.sh --non-interactive 2>&1)"
assert_eq "1" "$?" "non-root exits 1"
assert_contains "sudo ./install.sh" "$out" "non-root message suggests sudo ./install.sh"
out="$(docker exec "$name" ./install.sh --non-interactive 2>&1)"
assert_eq "1" "$?" "no init system without --no-service exits 1"
assert_contains "--no-service" "$out" "no init system message mentions --no-service"
assert_eq "absent" "$(in_ct 'test -e /opt/craftrcon || test -e /etc/craftrcon && echo present || echo absent')" "failed checks changed nothing"

echo "== $distro: install"
lang_args=()
if [ -n "${INSTALL_LANG:-}" ]; then lang_args=(--lang "$INSTALL_LANG"); fi
start=$SECONDS
docker exec -e CRAFTRCON_PASSWORD="$PASSWORD" "$name" ./install.sh "${lang_args[@]}" --non-interactive --no-service >"$logfile" 2>&1
rc=$?
echo "   (install took $((SECONDS - start)) s, log: $logfile)"
assert_eq "0" "$rc" "install exits 0"
if [ "$rc" -ne 0 ]; then tail -n 40 "$logfile"; fi
log="$(cat "$logfile")"
assert_contains "http://" "$log" "install prints the panel URL"
assert_contains ":$PORT" "$log" "URL uses the panel port"
case "$log" in *testpass123*) r=leaked ;; *) r=hidden ;; esac
assert_eq "hidden" "$r" "the password never appears in the output"

echo "== $distro: panel"
health="$(in_ct "curl -fsS http://127.0.0.1:$PORT/api/health")"
assert_contains '"ok":true' "$health" "health ok"
assert_contains "\"version\":\"$version\"" "$health" "health reports VERSION"
login() {
  in_ct "curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
    -H 'Origin: http://127.0.0.1:$PORT' -d '{\"password\":\"$1\"}' http://127.0.0.1:$PORT/api/login"
}
assert_eq "401" "$(login wrongpass1)" "login with a wrong password -> 401"
assert_eq "204" "$(login "$PASSWORD")" "login with testpass123 -> 204"

echo "== $distro: files and permissions"
assert_eq "640 root:craftrcon" "$(in_ct 'stat -c "%a %U:%G" /etc/craftrcon/config.json')" "config.json 0640 root:craftrcon"
cfg="$(in_ct 'cat /etc/craftrcon/config.json')"
assert_contains "\"port\": $PORT" "$cfg" "config port"
assert_contains '"host": "0.0.0.0"' "$cfg" "config host without domain"
assert_contains '"dataDir": "/var/lib/craftrcon"' "$cfg" "config dataDir"
assert_contains '"trustProxy": false' "$cfg" "config trustProxy"
assert_eq "750 craftrcon:craftrcon" "$(in_ct 'stat -c "%a %U:%G" /var/lib/craftrcon')" "data dir 0750 craftrcon"
assert_eq "craftrcon" "$(in_ct 'stat -c %U /var/lib/craftrcon/craftrcon.db')" "database owned by craftrcon"
assert_eq "craftrcon" "$(in_ct 'stat -c %U /var/lib/craftrcon/secret.key')" "secret key owned by craftrcon"
assert_eq "root:root" "$(in_ct 'stat -c %U:%G /opt/craftrcon/app/src/server.js')" "app owned by root"
assert_eq "ok" "$(in_ct 'test -f /opt/craftrcon/app/node_modules/fastify/package.json && echo ok')" "production dependencies installed"
assert_eq "ok" "$(in_ct 'test -f /opt/craftrcon/app/public/js/data/commands.js && echo ok')" "nested data folders are copied"
assert_eq "none" "$(in_ct 'ls -d /opt/craftrcon/app/test /opt/craftrcon/app/.superpowers /opt/craftrcon/app/data 2>/dev/null || echo none')" "test/.superpowers/data not copied"
assert_eq "ok" "$(in_ct 'test -x /opt/craftrcon/node/bin/node && echo ok')" "private Node installed"
inst="$(in_ct 'cat /opt/craftrcon/installed.json')"
assert_contains "\"version\": \"$version\"" "$inst" "installed.json version"
assert_contains '"commit": null' "$inst" "installed.json commit null without .git"
assert_contains '"firewall": []' "$inst" "installed.json firewall empty"
assert_contains '"installedAt": "20' "$inst" "installed.json installedAt"
# argv[0] from /proc/PID/cmdline (/proc/PID/exe of another user needs CAP_SYS_PTRACE).
owner="$(in_ct 'for p in /proc/[0-9]*; do a0="$(tr "\0" "\n" <"$p/cmdline" 2>/dev/null | head -n 1)"; if [ "$a0" = /opt/craftrcon/node/bin/node ]; then stat -c %U "$p"; fi; done')"
assert_eq "craftrcon" "$owner" "the panel's node process runs as craftrcon"

echo "== $distro: second run"
out="$(docker exec "$name" ./install.sh --non-interactive 2>&1)"
assert_eq "0" "$?" "second run exits 0"
assert_contains "./update.sh" "$out" "second run points to ./update.sh"
assert_contains "--uninstall" "$out" "second run points to --uninstall"

finish
