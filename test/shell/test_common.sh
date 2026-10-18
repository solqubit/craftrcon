#!/usr/bin/env bash
# Unit tests for scripts/lib/common.sh and the message catalogs.
# shellcheck disable=SC2016 # the strict() snippets are deliberately single-quoted (they expand in the child bash)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIX="$HERE/fixtures"
COMMON="$ROOT/scripts/lib/common.sh"

# shellcheck source=assert.sh
. "$HERE/assert.sh"
# shellcheck source=../../scripts/lib/common.sh
. "$COMMON"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Runs a snippet in a fresh bash that has common.sh loaded (extra env via `env`).
# shellcheck disable=SC2329 # invoked indirectly through assert_fail
in_common() { bash -c ". '$COMMON'; $1"; }
# Runs a snippet the way the flows run: strict mode on, library sourced, snippet in a
# fresh bash. Prints the snippet's output; its exit status is the snippet's.
strict() { env "${@:2}" bash -c "set -Eeuo pipefail; . '$COMMON'; $1"; }

echo "version_cmp"
assert_eq "0" "$(version_cmp 1.4.2 1.4.2)" "equal versions"
assert_eq "1" "$(version_cmp 0.10.0 0.9.9)" "numeric, not lexical (0.10.0 > 0.9.9)"
assert_eq "-1" "$(version_cmp 1.0.0 1.0.1)" "patch lower"
assert_eq "-1" "$(version_cmp 0.9.9 0.10.0)" "numeric minor lower"
assert_eq "1" "$(version_cmp 2.0.0 1.99.99)" "major higher"
assert_eq "1" "$(version_cmp 1.08.0 1.7.0)" "leading zeros are not octal"
version_cmp 1.0 1.0.0 >/dev/null 2>&1
assert_eq "2" "$?" "too few components -> rc 2"
version_cmp 1.0.0 abc >/dev/null 2>&1
assert_eq "2" "$?" "garbage -> rc 2"
version_cmp "" 1.0.0 >/dev/null 2>&1
assert_eq "2" "$?" "empty -> rc 2"
version_cmp 1.0.0-beta 1.0.0 >/dev/null 2>&1
assert_eq "2" "$?" "prerelease not supported -> rc 2"
assert_contains "abc" "$(version_cmp 1.0.0 abc 2>&1 >/dev/null)" "invalid version message names the value"
assert_eq "" "$(version_cmp 1.0.0 abc 2>/dev/null)" "invalid version prints nothing on stdout"

echo "detect_os"
pkg_for() { # pkg_for FIXTURE -> prints "PKG|OS_ID|OS_VERSION|OS_LIKE"
  (
    # shellcheck disable=SC2034 # read by detect_os
    OS_RELEASE_FILE="$FIX/os-release.$1"
    detect_os
    echo "$PKG|$OS_ID|$OS_VERSION|$OS_LIKE"
  )
}
assert_eq "apt|debian|12|" "$(pkg_for debian12)" "debian 12"
assert_eq "apt|ubuntu|22.04|debian" "$(pkg_for ubuntu2204)" "ubuntu (ID_LIKE debian)"
assert_eq "dnf|rocky|9.3|rhel centos fedora" "$(pkg_for rocky9)" "rocky 9 -> dnf"
assert_eq "yum|centos|7|rhel fedora" "$(pkg_for centos7)" "centos 7 -> yum"
assert_eq "apk|alpine|3.19.1|" "$(pkg_for alpine)" "alpine"
assert_eq "zypper|opensuse-leap|15.5|suse opensuse" "$(pkg_for opensuse)" "opensuse"
assert_eq "pacman|arch||" "$(pkg_for arch)" "arch"
assert_fail "unknown distro dies" env OS_RELEASE_FILE="$FIX/os-release.unknown" bash -c ". '$COMMON'; detect_os"
assert_fail "missing os-release dies" env OS_RELEASE_FILE="$TMP/nope" bash -c ". '$COMMON'; detect_os"

init_of() { (OS_RELEASE_FILE="$FIX/os-release.debian12" INIT_OVERRIDE="$1" detect_os && echo "$INIT"); }
assert_eq "openrc" "$(init_of openrc)" "INIT_OVERRIDE=openrc"
assert_eq "systemd" "$(init_of systemd)" "INIT_OVERRIDE=systemd"
# shellcheck disable=SC2153 # LIBC is set by detect_os
libc="$( (OS_RELEASE_FILE="$FIX/os-release.debian12" detect_os && echo "$LIBC") )"
case "$libc" in glibc | musl) libc=valid ;; esac
assert_eq "valid" "$libc" "LIBC is glibc or musl"
assert_eq "musl" "$( (OS_RELEASE_FILE="$FIX/os-release.alpine" LIBC_OVERRIDE=musl detect_os && echo "$LIBC") )" "LIBC_OVERRIDE=musl"

echo "detect_arch"
arch_of() { (CRAFTRCON_UNAME_M="$1" detect_arch); }
assert_eq "x64" "$(arch_of x86_64)" "x86_64 -> x64"
assert_eq "x64" "$(arch_of amd64)" "amd64 -> x64"
assert_eq "arm64" "$(arch_of aarch64)" "aarch64 -> arm64"
assert_eq "arm64" "$(arch_of arm64)" "arm64 -> arm64"
assert_fail "armv7l unsupported" env CRAFTRCON_UNAME_M=armv7l bash -c ". '$COMMON'; detect_arch"

echo "msg / language"
en_text="$(msg ERR_ARCH foo)"
assert_eq "Unsupported CPU architecture: foo" "$en_text" "msg formats args (en default)"
assert_eq "NO_SUCH_KEY" "$(msg NO_SUCH_KEY)" "missing key prints the key"
assert_eq "NO_SUCH_KEY" "$(msg NO_SUCH_KEY a b)" "missing key with args prints the key"
es_text="$( (set_lang es; msg ERR_ARCH foo) )"
assert_contains "foo" "$es_text" "es message still formats args"
[ "$es_text" != "$en_text" ] && r=different || r=same
assert_eq "different" "$r" "set_lang es changes the text"
es_env="$(CRAFTRCON_LANG=es bash -c ". '$COMMON'; msg ERR_ARCH foo")"
assert_eq "$es_text" "$es_env" "CRAFTRCON_LANG=es is honoured"
fallback="$( (set_lang xx; msg ERR_ARCH foo) )"
assert_eq "$en_text" "$fallback" "unknown language falls back to en"
# shellcheck disable=SC2034 # read indirectly by msg
assert_eq "x y" "$(msg 'x y')" "malformed key (space) printed literally"
assert_eq 'a;b$(id)' "$(msg 'a;b$(id)')" "malformed key (shell metachars) printed literally"
assert_eq "" "$(msg '')" "empty key prints nothing"
# shellcheck disable=SC2034 # read indirectly by msg
assert_eq "-5 left" "$( (MSG_TEST_DASH='-%s left'; msg TEST_DASH 5) )" "format starting with a dash is safe"
# shellcheck disable=SC2034 # read indirectly by msg
assert_eq "100% sure" "$( (MSG_TEST_PCT='%s%% sure'; msg TEST_PCT 100) )" "printf escapes work"

echo "message catalogs"
keys_of() { grep -o '^MSG_[A-Z0-9_]*' "$ROOT/scripts/lib/messages.$1.sh" | sort; }
assert_eq "$(keys_of en)" "$(keys_of es)" "MSG_ keys identical in en and es"
n="$(keys_of en | wc -l | tr -d ' ')"
[ "$n" -gt 0 ] && r=nonempty || r=empty
assert_eq "nonempty" "$r" "catalogs define keys ($n)"
assert_eq "" "$(keys_of en | uniq -d)" "no duplicate keys in en"
assert_eq "" "$(keys_of es | uniq -d)" "no duplicate keys in es"

echo "colors"
out="$(info ERR_ARCH x 2>&1)"
case "$out" in *$'\033'*) r=colored ;; *) r=plain ;; esac
assert_eq "plain" "$r" "no escape codes when stdout is not a TTY"
assert_eq "[]" "$( (NO_COLOR=1 init_colors; echo "[$C_RED]") )" "NO_COLOR keeps colors empty"
assert_eq "[]" "[${C_RED}]" "C_RED empty in non-TTY"

echo "output helpers"
assert_contains "Unsupported CPU architecture: x" "$(info ERR_ARCH x)" "info prints message"
assert_contains "Unsupported CPU architecture: x" "$(ok ERR_ARCH x)" "ok prints message"
assert_contains "Unsupported CPU architecture: x" "$(warn ERR_ARCH x 2>&1)" "warn prints message on stderr"
assert_contains "Unsupported CPU architecture: q" "$( (die ERR_ARCH q) 2>&1)" "die prints the message on stderr"
(die ERR_ARCH q) >/dev/null 2>&1
assert_eq "1" "$?" "die exits 1"
assert_contains "[2/5]" "$(step 2 5 ERR_ARCH x)" "step prefix"
assert_contains "Unsupported CPU architecture: x" "$(step 2 5 ERR_ARCH x)" "step message"

echo "require_root"
if [ "$(id -u)" -eq 0 ]; then
  assert_ok "root passes" require_root
else
  assert_fail "non-root dies" in_common require_root
fi

echo "constants"
assert_eq "/opt/craftrcon/app" "$APP_DIR" "APP_DIR"
assert_eq "/opt/craftrcon/node" "$NODE_DIR" "NODE_DIR"
assert_eq "/var/lib/craftrcon" "$DATA_DIR" "DATA_DIR"
assert_eq "/etc/craftrcon" "$CONF_DIR" "CONF_DIR"
assert_eq "craftrcon" "$SVC" "SVC"
assert_eq "$ROOT" "$SRC_DIR" "SRC_DIR is the repo root"
assert_ok "SRC_DIR contains VERSION" test -f "$SRC_DIR/VERSION"

echo "is_installed / installed_version"
assert_fail "not installed when file missing" env INSTALLED_FILE="$TMP/none.json" bash -c ". '$COMMON'; is_installed"
assert_ok "installed when file exists" env INSTALLED_FILE="$FIX/installed.json" bash -c ". '$COMMON'; is_installed"
assert_eq "1.4.2" "$(INSTALLED_FILE="$FIX/installed.json" installed_version)" "version from pretty JSON"
assert_eq "0.10.3" "$(INSTALLED_FILE="$FIX/installed.compact.json" installed_version)" "version from compact JSON"
assert_eq "" "$(INSTALLED_FILE="$TMP/none.json" installed_version)" "no version when not installed"
assert_eq "2.0.1" "$(INSTALLED_FILE="$FIX/installed.nested.json" installed_version)" "top-level version wins over nested/quoted ones"
assert_eq "" "$(INSTALLED_FILE="$FIX/installed.noversion.json" installed_version)" "nested-only version is ignored"
INSTALLED_FILE="$TMP/none.json" installed_version >/dev/null
assert_eq "0" "$?" "installed_version returns 0 when not installed"

echo "ask / read_secret"
assert_eq "dflt" "$( (NONINTERACTIVE=1 ask ERR_ARCH dflt V </dev/null; echo "$V") )" "ask uses default when NONINTERACTIVE=1"
assert_eq "typed" "$( (ask ERR_ARCH dflt V <<<"typed" 2>/dev/null; echo "$V") )" "ask reads the answer"
assert_eq "dflt" "$( (ask ERR_ARCH dflt V <<<"" 2>/dev/null; echo "$V") )" "ask empty answer -> default"
assert_eq "dflt" "$( (ask ERR_ARCH dflt V </dev/null 2>/dev/null; echo "$V") )" "ask EOF -> default"
assert_eq "last" "$( (ask ERR_ARCH dflt V 2>/dev/null < <(printf 'last'); echo "$V") )" "ask keeps a final line without newline"
assert_eq "pw-nonl" "$( (read_secret ERR_ARCH P 2>/dev/null < <(printf 'pw-nonl'); echo "$P") )" "read_secret keeps a final line without newline"
for name in key var answer secret default; do
  assert_eq "v-$name" "$( (ask ERR_ARCH d "$name" 2>/dev/null < <(printf 'v-%s
' "$name"); echo "${!name}") )" "ask can fill a variable called $name"
  assert_eq "s-$name" "$( (read_secret ERR_ARCH "$name" 2>/dev/null < <(printf 's-%s
' "$name"); echo "${!name}") )" "read_secret can fill a variable called $name"
done
assert_eq "unset" "$( (NONINTERACTIVE=1 CRAFTRCON_PASSWORD=x read_secret ERR_ARCH P; echo "${CRAFTRCON_PASSWORD-unset}") )" "read_secret unsets CRAFTRCON_PASSWORD"
assert_eq "s3cret-pass" "$( (NONINTERACTIVE=1 CRAFTRCON_PASSWORD=s3cret-pass read_secret ERR_ARCH P </dev/null; echo "$P") )" "read_secret from CRAFTRCON_PASSWORD"
assert_fail "read_secret NONINTERACTIVE without password dies" env NONINTERACTIVE=1 bash -c ". '$COMMON'; read_secret ERR_ARCH P </dev/null"
assert_eq "piped-pass" "$( (read_secret ERR_ARCH P <<<"piped-pass" 2>/dev/null; echo "$P") )" "read_secret reads stdin when not a TTY"
assert_fail "ask rejects invalid variable names" bash -c ". '$COMMON'; ask ERR_ARCH d 'a;b' <<<x"

echo "port_in_use"
export CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$FIX/proc-net-tcp"
assert_ok "listening port found via /proc/net/tcp" port_in_use 8080
assert_fail "established-only port is not in use" port_in_use 9090
assert_fail "unknown port is free" port_in_use 8081
assert_fail "port match is not a prefix match" port_in_use 80
# A missing second file (no /proc/net/tcp6) must not hide a listener from the first.
PROC_NET_TCP_FILES="$FIX/proc-net-tcp $TMP/nonexistent-tcp6"
assert_ok "listener found even when the second file is missing" port_in_use 8080
assert_fail "free port with a missing file" port_in_use 8081
PROC_NET_TCP_FILES="$TMP/nonexistent-a $TMP/nonexistent-b"
assert_fail "no readable proc files -> not in use" port_in_use 8080
unset CRAFTRCON_NO_SS PROC_NET_TCP_FILES
mkdir -p "$TMP/bin-ss"
cat >"$TMP/bin-ss/ss" <<SH
#!/bin/sh
cat "$FIX/ss-output"
SH
chmod +x "$TMP/bin-ss/ss"
assert_ok "ss: listening port found" env PATH="$TMP/bin-ss:$PATH" bash -c ". '$COMMON'; port_in_use 8080"
assert_ok "ss: ipv6 listener found" env PATH="$TMP/bin-ss:$PATH" bash -c ". '$COMMON'; port_in_use 22"
assert_fail "ss: free port" env PATH="$TMP/bin-ss:$PATH" bash -c ". '$COMMON'; port_in_use 80"

echo "wait_health"
mkdir -p "$TMP/bin-curl"
cat >"$TMP/bin-curl/curl" <<SH
#!/bin/sh
# Fails twice, then answers healthy (counter kept in a file).
f="$TMP/curl.count"
n=\$(cat "\$f" 2>/dev/null || echo 0)
n=\$((n + 1))
echo "\$n" >"\$f"
[ "\$n" -ge 3 ] || exit 7
echo '{"ok": true,"version":"1.0.0"}'
SH
chmod +x "$TMP/bin-curl/curl"
rm -f "$TMP/curl.count"
assert_ok "wait_health succeeds once the panel answers" env HEALTH_INTERVAL=0.1 PATH="$TMP/bin-curl:$PATH" bash -c ". '$COMMON'; wait_health http://127.0.0.1:1/api/health 10"
assert_eq "3" "$(cat "$TMP/curl.count")" "polled until healthy (3 calls)"
cat >"$TMP/bin-curl/curl" <<'SH'
#!/bin/sh
echo '{"ok":false}'
SH
assert_fail "wait_health times out when never healthy" env HEALTH_INTERVAL=0.2 PATH="$TMP/bin-curl:$PATH" bash -c ". '$COMMON'; wait_health http://127.0.0.1:1/api/health 1"

echo "wait_health edge cases"
mkdir -p "$TMP/bin-ok"
printf '#!/bin/sh
echo %s
' "'{\"ok\":true}'" >"$TMP/bin-ok/curl"
chmod +x "$TMP/bin-ok/curl"
assert_ok "timeout 0 still polls once" env PATH="$TMP/bin-ok:$PATH" bash -c ". '$COMMON'; wait_health http://x 0"
no_curl_rc="$(bash -c ". '$COMMON'; PATH='$TMP/empty'; wait_health http://x 1" >/dev/null 2>"$TMP/nocurl.err"; echo $?)"
assert_eq "1" "$no_curl_rc" "wait_health without curl exits 1"
assert_contains "curl" "$(cat "$TMP/nocurl.err")" "wait_health without curl explains why"

echo "pkg_install"
mkdir -p "$TMP/bin-pkg"
for tool in apt-get dnf yum zypper pacman apk; do
  cat >"$TMP/bin-pkg/$tool" <<SH
#!/bin/sh
echo "$tool \$*" >>"$TMP/pkg.log"
SH
  chmod +x "$TMP/bin-pkg/$tool"
done
pkg_log() { # pkg_log PKG pkgs... -> logged calls joined by ';'
  rm -f "$TMP/pkg.log"
  env PATH="$TMP/bin-pkg:$PATH" PKG="$1" bash -c ". '$COMMON'; pkg_install \"\$@\"" _ "${@:2}" >/dev/null 2>&1
  tr '\n' ';' <"$TMP/pkg.log"
}
assert_eq "apt-get update -qq;apt-get install -y --no-install-recommends curl tar;" "$(pkg_log apt curl tar)" "apt"
assert_eq "dnf install -y curl;" "$(pkg_log dnf curl)" "dnf"
assert_eq "yum install -y curl;" "$(pkg_log yum curl)" "yum"
assert_eq "zypper --non-interactive install curl;" "$(pkg_log zypper curl)" "zypper"
assert_eq "pacman -Syu --needed --noconfirm curl;" "$(pkg_log pacman curl)" "pacman"
assert_eq "apk add --no-cache curl;" "$(pkg_log apk curl)" "apk"
assert_fail "pkg_install without PKG dies" env -u PKG bash -c ". '$COMMON'; pkg_install curl"

echo "strict mode (set -Eeuo pipefail, as the flows run)"
assert_eq "free" "$(strict 'if port_in_use 8081; then echo used; else echo free; fi' CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$FIX/proc-net-tcp $TMP/none")" "port_in_use free inside if"
assert_eq "used" "$(strict 'if port_in_use 8080; then echo used; else echo free; fi' CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$FIX/proc-net-tcp $TMP/none")" "port_in_use used inside if (missing 2nd file)"
assert_eq "used" "$(strict 'port_in_use 8080 && echo used || echo free' PATH="$TMP/bin-ss:$PATH")" "port_in_use via ss under strict mode"
assert_eq "rc2" "$(strict 'rc=0; version_cmp 1.0 1.0.0 >/dev/null 2>&1 || rc=$?; echo rc$rc')" "version_cmp rc 2 is catchable"
assert_eq "-1" "$(strict 'v="$(version_cmp 1.0.0 1.0.1)"; echo "$v"')" "version_cmp captured under strict mode"
assert_eq "[]" "$(strict 'v="$(installed_version)"; echo "[$v]"' INSTALLED_FILE="$TMP/none.json")" "installed_version absent does not kill a strict caller"
assert_eq "[1.4.2]" "$(strict 'v="$(installed_version)"; echo "[$v]"' INSTALLED_FILE="$FIX/installed.json")" "installed_version present under strict mode"
assert_eq "[dflt]" "$(strict 'ask ERR_ARCH dflt V </dev/null 2>/dev/null; echo "[$V]"')" "ask at EOF under strict mode"
assert_eq "[typed]" "$(strict 'ask ERR_ARCH dflt V 2>/dev/null < <(printf "typed"); echo "[$V]"')" "ask partial line under strict mode"
assert_eq "[piped]" "$(strict 'read_secret ERR_ARCH P 2>/dev/null < <(printf "piped
"); echo "[$P]"')" "read_secret from a pipe under strict mode"
assert_eq "[pw]" "$(strict 'read_secret ERR_ARCH P; echo "[$P]"' NONINTERACTIVE=1 CRAFTRCON_PASSWORD=pw)" "read_secret non-interactive under strict mode"
assert_eq "none" "$(strict 'detect_os; echo "$INIT"' OS_RELEASE_FILE="$FIX/os-release.debian12" INIT_OVERRIDE=none)" "detect_os under strict mode"
assert_eq "x64" "$(strict 'a="$(detect_arch)"; echo "$a"' CRAFTRCON_UNAME_M=x86_64)" "detect_arch under strict mode"
assert_eq "ok" "$(strict 'wait_health http://x 1 && echo ok' PATH="$TMP/bin-ok:$PATH")" "wait_health under strict mode"
assert_eq "to" "$(strict 'wait_health http://x 0 || echo to' PATH="$TMP/bin-curl:$PATH")" "wait_health timeout catchable under strict mode"
assert_contains "Unsupported" "$(strict 'msg ERR_ARCH x; msg NOPE >/dev/null; echo " done"')" "msg under strict mode"

echo "bootstrap scripts"
for b in install update; do
  assert_eq "#!/bin/sh" "$(head -n1 "$ROOT/$b.sh")" "$b.sh has a POSIX sh shebang"
  assert_ok "$b.sh is valid sh syntax" sh -n "$ROOT/$b.sh"
  d="$TMP/boot-$b"
  mkdir -p "$d/scripts"
  cp "$ROOT/$b.sh" "$d/$b.sh"
  out="$(sh "$d/$b.sh" --x 2>&1)"
  assert_eq "1" "$?" "$b.sh without flow file exits 1"
  assert_contains "$b-flow.sh" "$out" "$b.sh names the missing flow file"
  printf '#!/usr/bin/env bash\necho "flow:$*"\n' >"$d/scripts/$b-flow.sh"
  out="$(sh "$d/$b.sh" --lang es "a b" 2>&1)"
  assert_eq "flow:--lang es a b" "$out" "$b.sh execs the flow with all args"
done

finish
