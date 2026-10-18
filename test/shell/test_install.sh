#!/usr/bin/env bash
# Unit tests for the fresh-install flow helpers (scripts/install-flow.sh, lib/node.sh,
# lib/service.sh). The end-to-end test is install-in-container.sh (needs Docker).
# shellcheck disable=SC2016 # the flow() snippets are deliberately single-quoted
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIX="$HERE/fixtures"
FLOW="$ROOT/scripts/install-flow.sh"
TPL="$ROOT/scripts/templates"

# shellcheck source=assert.sh
. "$HERE/assert.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# flow SNIPPET [ENV...]: runs SNIPPET in a fresh bash with the flow sourced (main does
# not run when sourced), in strict mode like the real run.
flow() { env "${@:2}" bash -c "set -Eeuo pipefail; . '$FLOW'; $1"; }
# run_flow ARGS...: runs the flow as ./install.sh would; prints stdout+stderr, then "rc=N".
run_flow() {
  local out rc=0
  out="$(env INSTALLED_FILE="${INSTALLED_FILE_T:-$TMP/none.json}" bash "$FLOW" "$@" 2>&1)" || rc=$?
  printf '%s\nrc=%s' "$out" "$rc"
}

echo "options"
out="$(run_flow --bogus)"
assert_contains "rc=2" "$out" "unknown option exits 2"
assert_contains "Unknown option: --bogus" "$out" "unknown option is named"
assert_contains "Usage: sudo ./install.sh" "$out" "unknown option prints the usage"
out="$(run_flow --help)"
assert_contains "rc=0" "$out" "--help exits 0"
assert_contains "--non-interactive" "$out" "--help lists --non-interactive"
assert_contains "rc=2" "$(run_flow --lang)" "--lang without value exits 2"
assert_contains "rc=2" "$(run_flow --lang fr)" "--lang fr exits 2"
out="$(run_flow --bogus --lang es)"
assert_contains "Opción desconocida: --bogus" "$out" "--lang es applies even when given after the bad option"
assert_contains "Uso: sudo ./install.sh" "$(run_flow --lang=es --help)" "--lang=es form"
assert_eq "1|1|1|1" "$(flow 'parse_args --non-interactive --no-service --yes; echo "$OPT_NONINTERACTIVE|$OPT_NO_SERVICE|$OPT_YES|$NONINTERACTIVE"')" "flags are parsed"
assert_eq "0|0" "$(flow 'parse_args; echo "$OPT_NONINTERACTIVE|$NONINTERACTIVE"' NONINTERACTIVE=1)" "NONINTERACTIVE follows the flag, not the environment"

echo "already installed / root"
out="$(INSTALLED_FILE_T="$FIX/installed.json" run_flow --non-interactive)"
assert_contains "rc=0" "$out" "already installed exits 0"
assert_contains "1.4.2" "$out" "already installed shows the installed version"
assert_contains "sudo ./update.sh" "$out" "already installed points to sudo ./update.sh"
assert_contains "sudo ./install.sh --uninstall" "$out" "already installed points to --uninstall"
if [ "$(id -u)" -ne 0 ]; then
  out="$(run_flow --non-interactive)"
  assert_contains "rc=1" "$out" "non-root exits 1"
  assert_contains "sudo ./install.sh" "$out" "non-root suggests sudo ./install.sh"
fi

echo "validation"
for p in 1024 8080 65535 08080; do assert_ok "valid port $p" flow "valid_port $p"; done
for p in 80 1023 65536 abc '' 8080x 123456; do assert_fail "invalid port '$p'" flow "valid_port '$p'"; done
for d in panel.example.com a.io xn--80ak6aa92e.com mc-1.my-server.net; do assert_ok "valid domain $d" flow "valid_domain $d"; done
for d in localhost 1.2.3.4 -bad.com bad-.com a_b.com 'panel.example.com:443' 'a..com' 'pa nel.com' 'x.com/path'; do
  assert_fail "invalid domain '$d'" flow "valid_domain '$d'"
done
assert_eq "panel.example.com" "$(flow 'normalize_domain "  HTTPS://Panel.Example.COM/ "')" "normalize_domain strips scheme, path, spaces, case"
assert_eq "panel.example.com" "$(flow 'normalize_domain panel.example.com.')" "normalize_domain strips the trailing dot"
assert_eq "" "$(flow 'normalize_domain ""')" "normalize_domain empty"
assert_eq "8081" "$(flow 'next_free_port 8080' CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$FIX/proc-net-tcp")" "next_free_port skips a listening port"
assert_eq "9090" "$(flow 'next_free_port 9090' CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$FIX/proc-net-tcp")" "next_free_port keeps a free port"
for a in y Y yes s SI sí; do assert_ok "is_yes $a" flow "is_yes '$a'"; done
for a in n no '' x; do assert_fail "not is_yes '$a'" flow "is_yes '$a'"; done

echo "questions (interactive answers on stdin)"
free_ports=(CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$TMP/no-listeners")
busy_8080=(CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$FIX/proc-net-tcp")
ask_q() { # ask_q SNIPPET STDIN [ENV...]: runs a question with answers on stdin (prompts dropped)
  local out rc=0
  out="$(flow "$1" NONINTERACTIVE=0 "${@:3}" 2>/dev/null <<<"$2")" || rc=$?
  printf '%s\n' "${out##*$'\n'}" # last line only: info messages also go to stdout
  return "$rc"
}
assert_eq "goodpass1" "$(ask_q 'ask_password; echo "$PASSWORD"' $'short\ngoodpass1\ndifferent\ngoodpass1\ngoodpass1')" "password: too short, mismatch, then accepted"
assert_eq "my pass word" "$(ask_q 'ask_password; echo "$PASSWORD"' $'my pass word\nmy pass word')" "password keeps spaces"
assert_fail "password: gives up after repeated bad answers" ask_q 'ask_password' $'a\nb\nc\nd\ne\nf'
assert_eq "8080" "$(ask_q 'ask_port; echo "$PORT"' '' "${free_ports[@]}")" "port: empty answer -> 8080"
assert_eq "9000" "$(ask_q 'ask_port; echo "$PORT"' $'80\nabc\n9000' "${free_ports[@]}")" "port: invalid answers are asked again"
assert_eq "8081" "$(ask_q 'ask_port; echo "$PORT"' '' "${busy_8080[@]}")" "port: busy 8080 -> suggested 8081 accepted"
assert_eq "8081" "$(ask_q 'ask_port; echo "$PORT"' $'8080\n' "${busy_8080[@]}")" "port: typing a busy port asks again"
assert_eq "[]" "$(ask_q 'ask_domain; echo "[$DOMAIN]"' '' "${free_ports[@]}")" "domain: empty -> none"
assert_eq "[panel.example.com]" "$(ask_q 'ask_domain; echo "[$DOMAIN]"' $'https://bad_domain\nPanel.Example.com' "${free_ports[@]}")" "domain: invalid asked again, then normalized"
assert_eq "[]" "$(ask_q 'ask_domain; echo "[$DOMAIN]"' 'panel.example.com' CRAFTRCON_NO_SS=1 PROC_NET_TCP_FILES="$FIX/proc-net-tcp-web")" "domain: 80/443 busy -> asked again (EOF -> none)"
assert_eq "1" "$(ask_q 'FW_TOOL=ufw; DOMAIN=""; PORT=8080; ask_firewall; echo "$FW_ACCEPT"' 's')" "firewall: s (si) accepts"
assert_eq "0" "$(ask_q 'FW_TOOL=ufw; DOMAIN=""; PORT=8080; ask_firewall; echo "$FW_ACCEPT"' 'n')" "firewall: n declines"
assert_eq "1" "$(ask_q 'FW_TOOL=ufw; DOMAIN=""; PORT=8080; ask_firewall; echo "$FW_ACCEPT"' '')" "firewall: empty answer -> yes"
assert_eq "1" "$(flow 'OPT_YES=1; FW_TOOL=ufw; ask_firewall; echo "$FW_ACCEPT"')" "firewall: --yes accepts without asking"
assert_eq "0" "$(flow 'NONINTERACTIVE=1; FW_TOOL=ufw; ask_firewall; echo "$FW_ACCEPT"')" "firewall: non-interactive without --yes declines"

echo "questions (non-interactive)"
assert_eq "secretpw1|8080|" "$(flow 'NONINTERACTIVE=1; ask_password; ask_port; ask_domain; echo "$PASSWORD|$PORT|$DOMAIN"' CRAFTRCON_PASSWORD=secretpw1 "${free_ports[@]}")" "defaults"
assert_fail "short CRAFTRCON_PASSWORD dies" flow 'NONINTERACTIVE=1; ask_password' CRAFTRCON_PASSWORD=short
assert_eq "8081" "$(flow 'NONINTERACTIVE=1; ask_port 2>/dev/null; echo "$PORT"' "${busy_8080[@]}")" "default port busy -> next free port"
assert_fail "explicit busy CRAFTRCON_PORT dies" flow 'NONINTERACTIVE=1; ask_port' CRAFTRCON_PORT=8080 "${busy_8080[@]}"
assert_fail "invalid CRAFTRCON_PORT dies" flow 'NONINTERACTIVE=1; ask_port' CRAFTRCON_PORT=80 "${free_ports[@]}"
assert_eq "a.example.org" "$(flow 'NONINTERACTIVE=1; ask_domain 2>/dev/null; echo "$DOMAIN"' CRAFTRCON_DOMAIN=A.Example.org "${free_ports[@]}")" "CRAFTRCON_DOMAIN normalized"
assert_fail "invalid CRAFTRCON_DOMAIN dies" flow 'NONINTERACTIVE=1; ask_domain' CRAFTRCON_DOMAIN=bad_domain "${free_ports[@]}"
assert_fail "domain with --no-service dies" flow 'NONINTERACTIVE=1; OPT_NO_SERVICE=1; ask_domain' CRAFTRCON_DOMAIN=a.example.org "${free_ports[@]}"

echo "json"
if command -v node >/dev/null 2>&1; then
  json_get() { node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(eval("j"+process.argv[1])))' "$1"; }
  cfg="$(flow 'config_json 8080 ""')"
  assert_eq '"0.0.0.0"' "$(json_get .host <<<"$cfg")" "config host without domain"
  assert_eq '8080' "$(json_get .port <<<"$cfg")" "config port is a number"
  assert_eq '"/var/lib/craftrcon"' "$(json_get .dataDir <<<"$cfg")" "config dataDir"
  assert_eq 'null' "$(json_get .domain <<<"$cfg")" "config domain null"
  assert_eq 'false' "$(json_get .trustProxy <<<"$cfg")" "config trustProxy false"
  cfg="$(flow 'config_json 9000 panel.example.com')"
  assert_eq '"127.0.0.1"' "$(json_get .host <<<"$cfg")" "config host with domain"
  assert_eq '"panel.example.com"' "$(json_get .domain <<<"$cfg")" "config domain"
  assert_eq 'true' "$(json_get .trustProxy <<<"$cfg")" "config trustProxy with domain"
  inst="$(flow 'installed_json 0.1.0 "" 2026-10-17T00:00:00Z 8080 ""')"
  assert_eq '{"version":"0.1.0","commit":null,"installedAt":"2026-10-17T00:00:00Z","port":8080,"domain":null,"firewall":[]}' \
    "$(json_get '' <<<"$inst")" "installed.json without commit/domain/firewall"
  inst="$(flow 'installed_json 1.2.3 0123456789abcdef0123456789abcdef01234567 T 8443 a.io ufw:80 ufw:443')"
  assert_eq '"0123456789abcdef0123456789abcdef01234567"' "$(json_get .commit <<<"$inst")" "installed.json commit"
  assert_eq '"a.io"' "$(json_get .domain <<<"$inst")" "installed.json domain"
  assert_eq '[{"tool":"ufw","port":80},{"tool":"ufw","port":443}]' "$(json_get .firewall <<<"$inst")" "installed.json firewall entries"
else
  echo "  (skipped: node is needed to parse the JSON)"
fi
mkdir -p "$TMP/nogit"
assert_eq "" "$(flow "SRC_DIR='$TMP/nogit'; source_commit")" "source_commit empty for a copy without .git"
if [ -e "$ROOT/.git" ] && command -v git >/dev/null 2>&1; then
  assert_eq "$(git -c safe.directory="$ROOT" -C "$ROOT" rev-parse HEAD)" "$(flow 'source_commit')" "source_commit is the git HEAD of the source copy"
fi

echo "app copy selection"
src="$TMP/src"
mkdir -p "$src/src" "$src/public/js/data" "$src/data" "$src/test" "$src/docs" "$src/node_modules/x" "$src/.git" "$src/.superpowers" "$src/scripts"
touch "$src/package.json" "$src/VERSION" "$src/.gitignore" "$src/public/js/data/items.js"
items="$(flow "SRC_DIR='$src'; app_items" | sort | tr '\n' ' ')"
assert_eq ".gitignore VERSION package.json public scripts src " "$items" "top-level exclusions only (public/js/data kept)"

echo "templates"
printf 'a=@A@ b=@B@ a=@A@\n' >"$TMP/t.tmpl"
flow "render_template '$TMP/t.tmpl' '$TMP/t.out' A=/opt/x B=8080"
assert_eq "a=/opt/x b=8080 a=/opt/x" "$(cat "$TMP/t.out")" "render_template replaces every placeholder"
assert_fail "render_template rejects |" flow "render_template '$TMP/t.tmpl' '$TMP/t2.out' 'A=a|b' B=1"
assert_fail "render_template rejects &" flow "render_template '$TMP/t.tmpl' '$TMP/t2.out' 'A=a&b' B=1"
assert_fail "render_template rejects backslash" flow "render_template '$TMP/t.tmpl' '$TMP/t2.out' 'A=a\\b' B=1"
assert_fail "render_template rejects bad keys" flow "render_template '$TMP/t.tmpl' '$TMP/t2.out' 'a-b=1'"

unit="$(flow 'INIT=systemd NODE_BIN=/opt/craftrcon/node/bin/node; write_service; cat "$SERVICE_ROOT/etc/systemd/system/craftrcon.service"' SERVICE_ROOT="$TMP/root")"
for line in 'User=craftrcon' 'Environment=CRAFTRCON_CONFIG=/etc/craftrcon/config.json' \
  'ExecStart=/opt/craftrcon/node/bin/node --disable-warning=ExperimentalWarning /opt/craftrcon/app/src/server.js' \
  'Restart=on-failure' 'NoNewPrivileges=yes' 'ProtectSystem=strict' 'ReadWritePaths=/var/lib/craftrcon' \
  'ProtectHome=yes' 'PrivateTmp=yes' 'WantedBy=multi-user.target'; do
  assert_contains "$line" "$unit" "systemd unit: $line"
done
assert_eq "" "$(grep -o '@[A-Z_]*@' <<<"$unit")" "systemd unit has no placeholders left"
rc="$(flow 'INIT=openrc NODE_BIN=/usr/bin/node; write_service; cat "$SERVICE_ROOT/etc/init.d/craftrcon"' SERVICE_ROOT="$TMP/root")"
assert_contains 'command="/usr/bin/node"' "$rc" "openrc: command"
assert_contains 'command_args="--disable-warning=ExperimentalWarning /opt/craftrcon/app/src/server.js"' "$rc" "openrc: args"
assert_contains 'command_user="craftrcon:craftrcon"' "$rc" "openrc: user"
assert_contains 'export CRAFTRCON_CONFIG="/etc/craftrcon/config.json"' "$rc" "openrc: config"
assert_eq "" "$(grep -o '@[A-Z_]*@' <<<"$rc")" "openrc script has no placeholders left"
for t in craftrcon-proxy.service craftrcon-proxy.openrc; do
  flow "render_template '$TPL/$t' '$TMP/$t' CADDY_BIN=/opt/craftrcon/caddy CADDYFILE=/etc/craftrcon/Caddyfile CADDY_DATA=/var/lib/craftrcon/caddy SVC_USER=craftrcon LOG_FILE=/var/log/craftrcon-proxy.log"
  assert_eq "" "$(grep -o '@[A-Z_]*@' "$TMP/$t")" "$t has no placeholders left"
done
assert_contains "AmbientCapabilities=CAP_NET_BIND_SERVICE" "$(cat "$TMP/craftrcon-proxy.service")" "proxy unit can bind 80/443"
assert_contains "Environment=XDG_DATA_HOME=/var/lib/craftrcon/caddy" "$(cat "$TMP/craftrcon-proxy.service")" "proxy unit XDG_DATA_HOME"
assert_contains "User=craftrcon" "$(cat "$TMP/craftrcon-proxy.service")" "proxy runs as craftrcon"
flow "render_template '$TPL/Caddyfile.tmpl' '$TMP/Caddyfile' DOMAIN=panel.example.com PORT=8080"
assert_contains "panel.example.com {" "$(cat "$TMP/Caddyfile")" "Caddyfile site"
assert_contains "reverse_proxy 127.0.0.1:8080" "$(cat "$TMP/Caddyfile")" "Caddyfile upstream"

echo "run as the service user"
# The prefix must end with "--": busybox su permutes options, so a program flag such as
# --disable-warning=... after the user name would otherwise be parsed by su itself.
assert_eq "--" "$(flow 'init_run_as; echo "${RUN_AS[${#RUN_AS[@]}-1]}"')" "RUN_AS ends with -- ($(command -v runuser >/dev/null 2>&1 && echo runuser || echo su))"
assert_eq "--" "$(flow 'runuser() { :; }; command() { [ "$2" != runuser ] && builtin command "$@"; }; init_run_as; echo "${RUN_AS[${#RUN_AS[@]}-1]}"')" "su fallback ends with --"

echo "node / caddy / firewall helpers"
assert_eq "$(printf 'a%.0s' {1..64}) node-v24.11.0-linux-x64.tar.xz" "$(flow "node_pick_tarball '$FIX/node-SHASUMS256.txt' x64")" "node tarball for x64 (not musl)"
assert_eq "$(printf 'b%.0s' {1..64}) node-v24.11.0-linux-arm64.tar.xz" "$(flow "node_pick_tarball '$FIX/node-SHASUMS256.txt' arm64")" "node tarball for arm64 (.tar.xz)"
assert_eq "" "$(flow "node_pick_tarball '$FIX/node-SHASUMS256.txt' ppc64le")" "no tarball for an unknown arch"
mkdir -p "$TMP/bin-node"
printf '#!/bin/sh\necho v22.12.0\n' >"$TMP/bin-node/old"
printf '#!/bin/sh\necho v22.13.0\n' >"$TMP/bin-node/min"
printf '#!/bin/sh\necho v24.11.0\n' >"$TMP/bin-node/new"
chmod +x "$TMP/bin-node/"*
assert_fail "node 22.12.0 is too old" flow "node_version_ok '$TMP/bin-node/old'"
assert_ok "node 22.13.0 is enough" flow "node_version_ok '$TMP/bin-node/min'"
assert_ok "node 24.11.0 is enough" flow "node_version_ok '$TMP/bin-node/new'"
assert_fail "missing node binary" flow "node_version_ok '$TMP/bin-node/none'"
assert_eq "2.10.2" "$(flow 'caddy_parse_tag' <"$FIX/caddy-release.json")" "caddy tag from the API JSON"
assert_eq "2.10.2" "$(flow 'echo https://github.com/caddyserver/caddy/releases/tag/v2.10.2 | caddy_parse_tag')" "caddy tag from the redirect URL"
assert_eq "" "$(flow 'echo "{\"message\":\"API rate limit exceeded\"}" | caddy_parse_tag')" "no caddy tag from an API error"
assert_eq "ufw allow 80/tcp; ufw allow 443/tcp" "$(flow 'FW_TOOL=ufw; firewall_cmds 80 443')" "ufw commands"
assert_eq "firewall-cmd --permanent --add-port=8080/tcp; firewall-cmd --reload" "$(flow 'FW_TOOL=firewalld; firewall_cmds 8080')" "firewalld commands"
assert_eq "80 443" "$(flow 'DOMAIN=a.io; firewall_ports')" "firewall ports with a domain"
assert_eq "8080" "$(flow 'DOMAIN=""; PORT=8080; firewall_ports')" "firewall ports without a domain"
assert_eq "skip|0" "$(flow 'FW_TOOL=ufw; FW_ACCEPT=0; open_firewall 8080 2>/dev/null; echo "skip|${#FIREWALL_OPENED[@]}"')" "open_firewall does nothing without consent"

finish
