#!/usr/bin/env bash
# Unit tests for the existing-install part of scripts/install-flow.sh: the menu, the
# --reset-password / --uninstall / --purge shortcuts, repair and uninstall bookkeeping.
# Everything runs against a sandbox in a temp dir with stubbed systemctl/ufw/id/userdel;
# the real thing (a container with the panel running) is install-in-container.sh.
# shellcheck disable=SC2016 # the snippets are deliberately single-quoted (they expand in the child bash)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIX="$HERE/fixtures"

# shellcheck source=assert.sh
. "$HERE/assert.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A copy of scripts/ with its own VERSION, so the "copy vs installed" cases and a fake
# update-flow.sh can be controlled without touching the repository.
COPY="$TMP/copy"
mkdir -p "$COPY"
cp -r "$ROOT/scripts" "$COPY/scripts"
FLOWC="$COPY/scripts/install-flow.sh"
set_copy_version() { printf '%s\n' "$1" >"$COPY/VERSION"; }

# fl SNIPPET [ENV...]: runs SNIPPET in a fresh strict bash with the (copied) flow sourced.
fl() { env "${@:2}" bash -c "set -Eeuo pipefail; . '$FLOWC'; $1"; }
# fl_in STDIN SNIPPET [ENV...]: the same with answers on stdin.
fl_in() { env "${@:3}" bash -c "set -Eeuo pipefail; . '$FLOWC'; $2" <<<"$1" 2>&1; }

echo "options"
assert_eq "1|0|0" "$(fl 'parse_args --reset-password; echo "$OPT_RESET_PASSWORD|$OPT_UNINSTALL|$OPT_PURGE"')" "--reset-password"
assert_eq "0|1|1" "$(fl 'parse_args --uninstall --purge; echo "$OPT_RESET_PASSWORD|$OPT_UNINSTALL|$OPT_PURGE"')" "--uninstall --purge"
out="$(env INSTALLED_FILE="$TMP/none.json" bash "$FLOWC" --reset-password --uninstall 2>&1)"
assert_eq "2" "$?" "--reset-password with --uninstall exits 2"
assert_contains "cannot be used together" "$out" "the conflict is explained"
out="$(env INSTALLED_FILE="$TMP/none.json" bash "$FLOWC" --purge 2>&1)"
assert_eq "2" "$?" "--purge alone exits 2"
assert_contains "--uninstall" "$out" "--purge alone points to --uninstall"
out="$(env INSTALLED_FILE="$TMP/none.json" bash "$FLOWC" --help 2>&1)"
for f in --reset-password --uninstall --purge; do assert_contains "$f" "$out" "usage lists $f"; done
out="$(env INSTALLED_FILE="$TMP/none.json" bash "$FLOWC" --lang es --help 2>&1)"
for f in --reset-password --uninstall --purge; do assert_contains "$f" "$out" "usage (es) lists $f"; done

echo "not installed"
out="$(env INSTALLED_FILE="$TMP/none.json" bash "$FLOWC" --uninstall --non-interactive 2>&1)"
assert_eq "0" "$?" "--uninstall when not installed exits 0"
assert_contains "not installed" "$out" "--uninstall when not installed says so"
out="$(env INSTALLED_FILE="$TMP/none.json" bash "$FLOWC" --reset-password --non-interactive 2>&1)"
assert_eq "1" "$?" "--reset-password when not installed exits 1"
assert_contains "sudo ./install.sh" "$out" "--reset-password when not installed points to the installer"

echo "versions (non-interactive, installed 1.4.2)"
set_copy_version 1.4.2
out="$(env INSTALLED_FILE="$FIX/installed.json" bash "$FLOWC" --non-interactive 2>&1)"
assert_eq "0" "$?" "equal versions: exits 0"
assert_contains "Installed version: 1.4.2. This copy: 1.4.2." "$out" "equal versions are shown"
assert_contains "--reset-password" "$out" "the hint mentions --reset-password"
case "$out" in *"is newer"*) r=newer ;; *) r=quiet ;; esac
assert_eq "quiet" "$r" "equal versions: no 'newer' notice"
set_copy_version 1.5.0
out="$(env INSTALLED_FILE="$FIX/installed.json" bash "$FLOWC" --non-interactive 2>&1)"
assert_eq "0" "$?" "newer copy: exits 0"
assert_contains "Installed version: 1.4.2. This copy: 1.5.0." "$out" "newer copy: both versions shown"
assert_contains "is newer than the installed version" "$out" "newer copy: says so"
assert_contains "sudo ./update.sh" "$out" "newer copy: points to sudo ./update.sh"
set_copy_version 1.0.0
out="$(env INSTALLED_FILE="$FIX/installed.json" bash "$FLOWC" --non-interactive 2>&1)"
case "$out" in *"is newer"*) r=newer ;; *) r=quiet ;; esac
assert_eq "quiet" "$r" "older copy: no 'newer' notice"
out="$(env INSTALLED_FILE="$FIX/installed.json" bash "$FLOWC" --non-interactive --lang es 2>&1)"
assert_contains "Versión instalada: 1.4.2. Esta copia: 1.0.0." "$out" "versions in Spanish"

echo "menu"
menu_snippet='action_reset_password() { echo "ACTION:reset"; }; action_repair() { echo "ACTION:repair"; }; action_uninstall() { echo "ACTION:uninstall"; }; existing_menu'
assert_contains "ACTION:reset" "$(fl_in $'1' "$menu_snippet")" "1 -> change the password"
assert_contains "ACTION:repair" "$(fl_in $'2' "$menu_snippet")" "2 -> repair"
assert_contains "ACTION:uninstall" "$(fl_in $'3' "$menu_snippet")" "3 -> uninstall"
out="$(fl_in $'4' "$menu_snippet")"
case "$out" in *ACTION:*) r=acted ;; *) r=none ;; esac
assert_eq "none" "$r" "4 -> exit without acting"
out="$(fl_in '' "$menu_snippet")"
case "$out" in *ACTION:*) r=acted ;; *) r=none ;; esac
assert_eq "none" "$r" "empty answer -> exit"
out="$(fl_in $'7\nx\n2' "$menu_snippet")"
assert_contains "Invalid choice: 7" "$out" "an invalid number is reported"
assert_contains "Invalid choice: x" "$out" "an invalid word is reported"
assert_contains "ACTION:repair" "$out" "an invalid choice asks again"
for k in "1) Change the panel password" "2) Repair the service" "3) Uninstall CraftRCON" "4) Exit"; do
  assert_contains "$k" "$(fl_in 4 "$menu_snippet")" "menu shows: $k"
done
assert_contains "1) Cambiar la clave del panel" "$(fl_in 4 "$menu_snippet" CRAFTRCON_LANG=es)" "menu in Spanish"
assert_eq "1" "$(fl_in $'a\nb\nc\nd\ne\nf' "$menu_snippet" >/dev/null 2>&1 && echo 0 || echo 1)" "the menu gives up after repeated invalid answers"

echo "menu through the flow (interactive)"
set_copy_version 1.4.2
flow_stubs='require_root() { :; }; action_reset_password() { echo "ACTION:reset"; }; action_repair() { echo "ACTION:repair"; }; action_uninstall() { echo "ACTION:uninstall"; }'
run_main() { # run_main STDIN ARGS...  (installed 1.4.2; stubs for the actions)
  local in="$1"
  shift
  fl_in "$in" "$flow_stubs; main $*" INSTALLED_FILE="$FIX/installed.json"
}
set_copy_version 1.4.2
out="$(run_main $'2')"
assert_contains "Installed version: 1.4.2. This copy: 1.4.2." "$out" "interactive: versions are shown"
assert_contains "What do you want to do?" "$out" "interactive: the menu is shown"
assert_contains "ACTION:repair" "$out" "interactive: choice 2 runs the repair"
case "$out" in *"Run ./update.sh now?"*) r=offered ;; *) r=quiet ;; esac
assert_eq "quiet" "$r" "equal versions: ./update.sh is not offered"
set_copy_version 1.0.0
out="$(run_main $'4')"
case "$out" in *"Run ./update.sh now?"*) r=offered ;; *) r=quiet ;; esac
assert_eq "quiet" "$r" "older copy: ./update.sh is not offered"

echo "menu: a newer copy offers ./update.sh"
set_copy_version 1.5.0
out="$(run_main $'n\n4')"
assert_contains "Run ./update.sh now? (y/n) [y]" "$out" "newer copy: the offer defaults to yes"
assert_contains "What do you want to do?" "$out" "declining the update goes on to the menu"
# No update-flow.sh yet: says so and continues with the menu.
rm -f "$COPY/scripts/update-flow.sh"
out="$(run_main $'y\n3')"
assert_contains "not available in this copy yet" "$out" "no update-flow.sh: says it is not available"
assert_contains "ACTION:uninstall" "$out" "no update-flow.sh: continues with the menu"
# With update-flow.sh, yes replaces the process with it and keeps the language.
printf '#!/usr/bin/env bash\necho "UPDATE-FLOW ARGS: $*"\n' >"$COPY/scripts/update-flow.sh"
out="$(run_main $'\n')"
assert_contains "UPDATE-FLOW ARGS: --lang en" "$out" "default answer runs update-flow.sh --lang en"
case "$out" in *"What do you want to do?"*) r=menu ;; *) r=none ;; esac
assert_eq "none" "$r" "after exec-ing the update the menu is not shown"
out="$(fl_in $'y' "$flow_stubs; main --lang es" INSTALLED_FILE="$FIX/installed.json")"
assert_contains "UPDATE-FLOW ARGS: --lang es" "$out" "the language is passed on"
rm -f "$COPY/scripts/update-flow.sh"
assert_contains "UPDATE-FLOW" "$(printf '#!/usr/bin/env bash\necho UPDATE-FLOW\n' >"$COPY/scripts/update-flow.sh"; fl_in $'y' "$flow_stubs; main" INSTALLED_FILE="$FIX/installed.json")" "update via plain 'y'"
rm -f "$COPY/scripts/update-flow.sh"

echo "shortcuts reach the actions"
assert_contains "ACTION:reset" "$(fl_in '' "$flow_stubs; main --reset-password --non-interactive" INSTALLED_FILE="$FIX/installed.json")" "--reset-password runs the password action (no menu)"
out="$(fl_in '' "$flow_stubs; main --uninstall --non-interactive" INSTALLED_FILE="$FIX/installed.json")"
assert_contains "ACTION:uninstall" "$out" "--uninstall runs the uninstall action (no menu)"
case "$out" in *"What do you want to do?"*) r=menu ;; *) r=none ;; esac
assert_eq "none" "$r" "--uninstall does not show the menu"

echo "installed.json readers"
cat >"$TMP/installed.fw.json" <<'JSON'
{
  "version": "0.1.0",
  "commit": null,
  "installedAt": "2026-10-17T00:00:00Z",
  "port": 8123,
  "domain": null,
  "firewall": [{ "tool": "ufw", "port": 80 }, { "tool": "firewalld", "port": 443 }]
}
JSON
printf '{"port":9000,"firewall":[{"tool":"ufw","port":8080}],"version":"1.0.0"}' >"$TMP/installed.fw-compact.json"
printf '{"version":"1.0.0","port":8080,"firewall":[]}' >"$TMP/installed.fw-empty.json"
printf '{"version":"1.0.0","port":8080,"firewall":[{"tool":"iptables","port":22},{"tool":"ufw","port":"x"},{"tool":"ufw","port":81}]}' >"$TMP/installed.fw-odd.json"
assert_eq "ufw:80,firewalld:443" "$(fl 'installed_firewall | paste -sd, -' INSTALLED_FILE="$TMP/installed.fw.json")" "firewall entries (pretty JSON)"
assert_eq "ufw:8080" "$(fl 'installed_firewall' INSTALLED_FILE="$TMP/installed.fw-compact.json")" "firewall entries (compact JSON)"
assert_eq "" "$(fl 'installed_firewall' INSTALLED_FILE="$TMP/installed.fw-empty.json")" "no firewall entries"
assert_eq "" "$(fl 'installed_firewall' INSTALLED_FILE="$TMP/none.json")" "no firewall entries when not installed"
assert_eq "" "$(fl 'installed_firewall' INSTALLED_FILE="$FIX/installed.noversion.json")" "no firewall key content"
assert_eq "iptables:22,ufw:81" "$(fl 'installed_firewall | paste -sd, -' INSTALLED_FILE="$TMP/installed.fw-odd.json")" "entries without a numeric port are skipped"
assert_eq "8123" "$(fl 'installed_port' INSTALLED_FILE="$TMP/installed.fw.json")" "installed_port is the top-level port, not a firewall one"
assert_eq "9000" "$(fl 'installed_port' INSTALLED_FILE="$TMP/installed.fw-compact.json")" "installed_port (compact JSON)"
assert_eq "" "$(fl 'installed_port' INSTALLED_FILE="$TMP/none.json")" "installed_port empty when not installed"
printf '{\n  "host": "0.0.0.0",\n  "port": 8099,\n  "dataDir": "/var/lib/craftrcon"\n}\n' >"$TMP/config.json"
assert_eq "8099" "$(fl "CONFIG_FILE='$TMP/config.json'; panel_port" INSTALLED_FILE="$TMP/installed.fw.json")" "panel_port reads config.json first"
assert_eq "8123" "$(fl "CONFIG_FILE='$TMP/nope.json'; panel_port" INSTALLED_FILE="$TMP/installed.fw.json")" "panel_port falls back to installed.json"
assert_eq "8080" "$(fl "CONFIG_FILE='$TMP/nope.json'; panel_port" INSTALLED_FILE="$TMP/none.json")" "panel_port falls back to the default"

echo "reset password"
reset_stubs='require_root() { :; }; locate_node() { :; }; init_run_as() { :; }; run_cli() { echo "CLI:$*"; IFS= read -r line; printf "STDIN:%s\n" "$line"; return "${CLI_RC:-0}"; }'
out="$(fl_in '' "$reset_stubs; main --reset-password --non-interactive" INSTALLED_FILE="$FIX/installed.json" CRAFTRCON_PASSWORD=newpass456)"
assert_contains "CLI:set-password" "$out" "runs cli.js set-password"
assert_contains "STDIN:newpass456" "$out" "the password goes to the CLI on stdin"
assert_contains "password was changed" "$out" "success message"
case "$out" in *"CLI:set-password newpass456"*) r=argv ;; *) r=stdin ;; esac
assert_eq "stdin" "$r" "the password is never an argument"
out="$(fl_in '' "$reset_stubs; main --reset-password --non-interactive" INSTALLED_FILE="$FIX/installed.json" CRAFTRCON_PASSWORD=short)"
assert_contains "at least 8 characters" "$out" "a short password is rejected"
case "$out" in *CLI:*) r=ran ;; *) r=untouched ;; esac
assert_eq "untouched" "$r" "a short password never reaches the CLI"
out="$(fl_in '' "$reset_stubs; main --reset-password --non-interactive" INSTALLED_FILE="$FIX/installed.json" CRAFTRCON_PASSWORD=$'goodpass1\nx')"
assert_contains "line breaks" "$out" "a password with a line break is rejected"
out="$(fl_in '' "$reset_stubs; main --reset-password --non-interactive" INSTALLED_FILE="$FIX/installed.json")"
assert_contains "No password provided" "$out" "a missing CRAFTRCON_PASSWORD is reported"
out="$(fl_in '' "$reset_stubs; main --reset-password --non-interactive" INSTALLED_FILE="$FIX/installed.json" CRAFTRCON_PASSWORD=newpass456 CLI_RC=2)"
assert_contains "rejected the password" "$out" "cli exit 2 -> password rejected message"
fl_in '' "$reset_stubs; main --reset-password --non-interactive" INSTALLED_FILE="$FIX/installed.json" CRAFTRCON_PASSWORD=newpass456 CLI_RC=1 >/dev/null
assert_eq "1" "$?" "cli failure -> exit 1"
out="$(fl_in $'badone\nnewpass456\nother\nnewpass456\nnewpass456' "$reset_stubs; main --reset-password" INSTALLED_FILE="$FIX/installed.json")"
assert_contains "STDIN:newpass456" "$out" "interactive: too short / mismatch are asked again, then accepted"
case "$out" in *"STDIN:other"*) r=wrong ;; *) r=ok ;; esac
assert_eq "ok" "$r" "interactive: the mismatching answer is not used"
# The menu path (option 1) uses the same action.
set_copy_version 1.4.2
out="$(fl_in $'1\nmenupass789\nmenupass789' "$reset_stubs; main" INSTALLED_FILE="$FIX/installed.json")"
assert_contains "STDIN:menupass789" "$out" "menu option 1 changes the password"
out="$(env INSTALLED_FILE="$FIX/installed.json" bash "$FLOWC" --reset-password --non-interactive 2>&1)"
if [ "$(id -u)" -ne 0 ]; then
  assert_contains "sudo ./install.sh" "$out" "--reset-password as non-root suggests sudo ./install.sh"
fi

echo "uninstall (sandbox)"
SB="$TMP/sb"
mkdir -p "$TMP/bin"
cat >"$TMP/bin/systemctl" <<SH
#!/bin/sh
echo "systemctl \$*" >>"$SB.calls"
SH
cat >"$TMP/bin/ufw" <<SH
#!/bin/sh
echo "ufw \$*" >>"$SB.calls"
echo "Rule deleted"
SH
cat >"$TMP/bin/id" <<SH
#!/bin/sh
[ -e "$SB.user" ] && { echo 999; exit 0; }
exit 1
SH
cat >"$TMP/bin/userdel" <<SH
#!/bin/sh
echo "userdel \$*" >>"$SB.calls"
rm -f "$SB.user"
exit 12
SH
cat >"$TMP/bin/getent" <<'SH'
#!/bin/sh
exit 2
SH
chmod +x "$TMP/bin/"*

# mk_sandbox [FIREWALL_JSON]: a fake installation under $SB (units under $SB/root).
DEFAULT_FW='[{ "tool": "ufw", "port": 80 }, { "tool": "ufw", "port": 443 }]'
mk_sandbox() {
  local fw="${1:-$DEFAULT_FW}"
  rm -rf "$SB" "$SB.calls" "$SB.user"
  mkdir -p "$SB/opt/app/src" "$SB/opt/node/bin" "$SB/etc" "$SB/data/caddy" "$SB/log" "$SB/root/etc/systemd/system"
  printf '{\n  "version": "1.4.2",\n  "port": 8080,\n  "firewall": %s\n}\n' "$fw" >"$SB/opt/installed.json"
  echo '{"port": 8080}' >"$SB/etc/config.json"
  echo db >"$SB/data/craftrcon.db"
  echo x >"$SB/log/craftrcon.log"
  echo x >"$SB/log/proxy.log"
  echo x >"$SB/root/etc/systemd/system/craftrcon.service"
  echo x >"$SB/root/etc/systemd/system/craftrcon-proxy.service"
  : >"$SB.calls"
  : >"$SB.user"
}
sandbox_env=(PATH="$TMP/bin:$PATH" INIT_OVERRIDE=systemd LIBC_OVERRIDE=glibc OS_RELEASE_FILE="$FIX/os-release.debian12" SERVICE_ROOT="$SB/root")
# sb_run STDIN ARGS...: main ARGS against the sandbox; prints stdout+stderr and rc=N.
sb_run() {
  local in="$1" out rc=0
  shift
  out="$(fl_in "$in" "OPT_DIR='$SB/opt'; APP_DIR='$SB/opt/app'; NODE_DIR='$SB/opt/node'; DATA_DIR='$SB/data'; CONF_DIR='$SB/etc'; CONFIG_FILE='$SB/etc/config.json'; LOG_FILE='$SB/log/craftrcon.log'; PROXY_LOG_FILE='$SB/log/proxy.log'; INSTALLED_FILE='$SB/opt/installed.json'; require_root() { :; }; main $*" "${sandbox_env[@]}" PATH="${SB_PATH_PREFIX:-}$TMP/bin:$PATH" INIT_OVERRIDE="${SB_INIT:-systemd}")" || rc=$?
  printf '%s\nrc=%s' "$out" "$rc"
}
exists() { [ -e "$1" ] && echo yes || echo no; }

mk_sandbox
out="$(sb_run '' --uninstall --non-interactive)"
assert_contains "rc=0" "$out" "non-interactive uninstall exits 0"
assert_eq "no|no|no" "$(exists "$SB/opt")|$(exists "$SB/etc")|$(exists "$SB/log/craftrcon.log")" "app, configuration and logs are removed"
assert_eq "no|no" "$(exists "$SB/root/etc/systemd/system/craftrcon.service")|$(exists "$SB/root/etc/systemd/system/craftrcon-proxy.service")" "both unit files are removed"
assert_eq "yes|yes" "$(exists "$SB/data/craftrcon.db")|$(exists "$SB.user")" "data and the user are kept by default (non-interactive)"
calls="$(cat "$SB.calls")"
assert_contains "systemctl stop craftrcon-proxy" "$calls" "the proxy service is stopped"
assert_contains "systemctl disable --quiet craftrcon-proxy" "$calls" "the proxy service is disabled"
assert_contains "systemctl stop craftrcon" "$calls" "the panel service is stopped"
assert_contains "systemctl disable --quiet craftrcon" "$calls" "the panel service is disabled"
assert_contains "ufw delete allow 80/tcp" "$calls" "firewall rule 80 closed"
assert_contains "ufw delete allow 443/tcp" "$calls" "firewall rule 443 closed"
assert_eq "0" "$(grep -c userdel "$SB.calls")" "the user is not deleted without data deletion"
assert_contains "CraftRCON was uninstalled." "$out" "summary header"
assert_contains "Removed:" "$out" "summary lists what was removed"
assert_contains "- The craftrcon service" "$out" "summary: panel service"
assert_contains "- The craftrcon-proxy service" "$out" "summary: proxy service"
assert_contains "Firewall rule: TCP port 443 in ufw" "$out" "summary: firewall rule"
assert_contains "Kept:" "$out" "summary lists what was kept"
assert_contains "$SB/data (your data)" "$out" "summary: data kept"
assert_contains "The system user craftrcon" "$out" "summary: user kept"
# Idempotent: nothing left, so a second run is a no-op.
out="$(sb_run '' --uninstall --non-interactive)"
assert_contains "rc=0" "$out" "uninstalling twice exits 0"
assert_contains "not installed" "$out" "the second uninstall says there is nothing to remove"

echo "uninstall: --purge"
mk_sandbox
out="$(sb_run '' --uninstall --purge --non-interactive)"
assert_contains "rc=0" "$out" "--purge exits 0"
assert_eq "no|no|no" "$(exists "$SB/opt")|$(exists "$SB/data")|$(exists "$SB.user")" "--purge removes the app, the data and the user"
assert_contains "userdel craftrcon" "$(cat "$SB.calls")" "--purge runs userdel (its exit 12 is tolerated)"
assert_contains "$SB/data (database" "$out" "summary: data removed"
assert_contains "The system user craftrcon" "$out" "summary: user removed"
case "$out" in *"(your data)"*) r=kept ;; *) r=gone ;; esac
assert_eq "gone" "$r" "--purge does not list the data as kept"

echo "uninstall: interactive answers"
mk_sandbox
out="$(sb_run $'n' --uninstall)"
assert_contains "Remove CraftRCON from this server? (y/n) [n]" "$out" "interactive: confirms first, default No"
assert_contains "Nothing was removed." "$out" "interactive: No leaves everything"
assert_eq "yes|yes|yes" "$(exists "$SB/opt")|$(exists "$SB/etc")|$(exists "$SB/data")" "interactive: declining removes nothing"
assert_eq "yes" "$(exists "$SB/root/etc/systemd/system/craftrcon.service")" "interactive: declining keeps the service"
out="$(sb_run $'' --uninstall)"
assert_contains "Nothing was removed." "$out" "interactive: an empty answer means No"
out="$(sb_run $'y\n' --uninstall)"
assert_contains "Delete data too?" "$out" "interactive: asks whether to delete the data"
assert_contains "[n]" "$out" "interactive: the data question defaults to No"
assert_eq "no|yes|yes" "$(exists "$SB/opt")|$(exists "$SB/data")|$(exists "$SB.user")" "interactive: y then default keeps the data"
mk_sandbox
out="$(sb_run $'y\ny' --uninstall)"
assert_eq "no|no|no" "$(exists "$SB/opt")|$(exists "$SB/data")|$(exists "$SB.user")" "interactive: y then y deletes the data and the user"
mk_sandbox
out="$(sb_run $'y\nn' --uninstall)"
assert_eq "no|yes|yes" "$(exists "$SB/opt")|$(exists "$SB/data")|$(exists "$SB.user")" "interactive: y then n keeps the data"
mk_sandbox
out="$(sb_run $'n' --uninstall --yes)"
assert_eq "no|yes" "$(exists "$SB/opt")|$(exists "$SB/data")" "--yes skips the confirmation (the data question is still asked: n)"
mk_sandbox
out="$(sb_run '' --uninstall --purge)"
assert_eq "yes|yes" "$(exists "$SB/opt")|$(exists "$SB/data")" "interactive --purge: the confirmation comes first (EOF -> No: nothing removed)"
case "$out" in *"Nothing was removed."*) r=aborted ;; *) r=ran ;; esac
assert_eq "aborted" "$r" "interactive --purge still asks the first confirmation"

echo "uninstall: firewall and services"
mk_sandbox '[]'
out="$(sb_run '' --uninstall --non-interactive)"
assert_eq "0" "$(grep -c '^ufw' "$SB.calls")" "no firewall rules recorded -> the firewall is not touched"
mk_sandbox '[{ "tool": "firewalld", "port": 8080 }]'
out="$(sb_run '' --uninstall --non-interactive)"
assert_contains "rc=0" "$out" "an unclosable rule does not abort the uninstall"
assert_contains "Could not close TCP port 8080 in firewalld" "$out" "the failure is reported"
assert_contains "firewall-cmd --permanent --remove-port=8080/tcp" "$out" "the manual command is given"
assert_eq "no" "$(exists "$SB/opt")" "the uninstall still finishes"
mk_sandbox
rm -f "$SB/root/etc/systemd/system/craftrcon-proxy.service" "$SB/log/proxy.log"
out="$(sb_run '' --uninstall --non-interactive)"
assert_contains "rc=0" "$out" "no proxy service (no domain): fine"
case "$out" in *"craftrcon-proxy service"*) r=listed ;; *) r=absent ;; esac
assert_eq "absent" "$r" "no proxy service: not listed as removed"
assert_eq "0" "$(grep -c 'craftrcon-proxy' "$SB.calls")" "no proxy service: systemctl is not asked about it"
# Without a service manager (containers) there are no units to remove.
mk_sandbox
out="$(SB_INIT=none sb_run '' --uninstall --non-interactive)"
assert_contains "rc=0" "$out" "INIT none: uninstall works"
assert_eq "0" "$(grep -c systemctl "$SB.calls")" "INIT none: no service manager calls"
assert_eq "no" "$(exists "$SB/opt")" "INIT none: files removed"

echo "uninstall: a failure can be repeated"
mk_sandbox
mkdir -p "$TMP/bin-fail"
printf '#!/bin/sh\nexit 1\n' >"$TMP/bin-fail/systemctl"
chmod +x "$TMP/bin-fail/systemctl"
out="$(SB_PATH_PREFIX="$TMP/bin-fail:" sb_run '' --uninstall --non-interactive)"
# (systemctl stop/disable failing only warns; the unit file is still removed)
assert_contains "rc=0" "$out" "a failing 'systemctl stop' only warns"
assert_contains "Could not stop the service" "$out" "the stop failure is reported"
mk_sandbox
out="$(fl_in '' "OPT_DIR='$SB/opt'; APP_DIR='$SB/opt/app'; DATA_DIR='$SB/data'; CONF_DIR='$SB/etc'; LOG_FILE='$SB/log/craftrcon.log'; PROXY_LOG_FILE='$SB/log/proxy.log'; INSTALLED_FILE='$SB/opt/installed.json'; require_root() { :; }; rm() { [ \"\${1:-}\" = -rf ] && [ \"\${2:-}\" = '$SB/etc' ] && return 1; command rm \"\$@\"; }; main --uninstall --non-interactive; echo reached-the-end" "${sandbox_env[@]}")" && rc=0 || rc=$?
assert_eq "1" "$rc" "a failing step aborts the uninstall (errexit)"
assert_contains "safe to run sudo ./install.sh --uninstall again" "$out" "the failure says it can be repeated"
assert_eq "yes" "$(exists "$SB/opt/installed.json")" "installed.json stays until the very end (so a re-run is possible)"
case "$out" in *reached-the-end*) r=continued ;; *) r=stopped ;; esac
assert_eq "stopped" "$r" "nothing runs after the failure"

echo "uninstall: user deletion"
mk_sandbox
assert_eq "yes" "$(fl 'delete_service_user && echo yes || echo no' "${sandbox_env[@]}")" "delete_service_user: removed (userdel exit 12 tolerated)"
assert_eq "no" "$(exists "$SB.user")" "delete_service_user: the user is gone"
assert_eq "no" "$(fl 'delete_service_user && echo yes || echo no' "${sandbox_env[@]}")" "delete_service_user: no user -> nothing done"

echo "firewall rule closing (stubs)"
mkdir -p "$TMP/bin-fw"
cat >"$TMP/bin-fw/firewall-cmd" <<SH
#!/bin/sh
echo "firewall-cmd \$*" >>"$TMP/fw.log"
case "\$*" in
  --state) echo "\${FW_STATE:-running}"; [ "\${FW_STATE:-running}" = running ] ;;
  *) echo success ;;
esac
SH
cat >"$TMP/bin-fw/ufw" <<SH
#!/bin/sh
echo "ufw \$*" >>"$TMP/fw.log"
SH
chmod +x "$TMP/bin-fw/"*
rm -f "$TMP/fw.log"
fl 'firewall_close_rule ufw 8080' PATH="$TMP/bin-fw:$PATH"
assert_eq "ufw delete allow 8080/tcp" "$(cat "$TMP/fw.log")" "ufw: deletes the allow rule"
rm -f "$TMP/fw.log"
fl 'firewall_close_rule firewalld 443' PATH="$TMP/bin-fw:$PATH"
assert_contains "firewall-cmd --permanent --remove-port=443/tcp" "$(cat "$TMP/fw.log")" "firewalld: removes the permanent rule"
assert_contains "firewall-cmd --remove-port=443/tcp" "$(cat "$TMP/fw.log")" "firewalld: removes the running rule too"
assert_fail "firewalld not running and no offline tool -> 1" fl 'firewall_close_rule firewalld 443' PATH="$TMP/bin-fw:$PATH" FW_STATE=not-running
assert_fail "unknown tool -> 1" fl 'firewall_close_rule iptables 22'
assert_fail "ufw missing -> 1" fl 'PATH=/nonexistent; firewall_close_rule ufw 80'
assert_eq "ufw delete allow 80/tcp" "$(fl 'firewall_close_cmds ufw 80')" "manual command (ufw)"
assert_eq "firewall-cmd --permanent --remove-port=80/tcp; firewall-cmd --reload" "$(fl 'firewall_close_cmds firewalld 80')" "manual command (firewalld)"

echo "repair (stubs)"
repair_stubs='require_root() { :; }; detect_os() { INIT=${INIT_T:-systemd}; }; locate_node() { NODE_BIN=/opt/craftrcon/node/bin/node; }; init_run_as() { :; }; write_service() { echo "CALL:write_service"; }; write_proxy_service() { echo "CALL:write_proxy_service"; }; service_enable() { echo "CALL:enable ${1:-panel}"; }; service_start() { echo "CALL:restart ${1:-panel}"; }; start_background() { echo "CALL:start_background"; }; stop_background_panel() { echo "CALL:stop_background"; }; wait_health() { echo "CALL:health $1"; return "${HEALTH_RC:-0}"; }'
mk_sandbox
rp="OPT_DIR='$SB/opt'; INSTALLED_FILE='$SB/opt/installed.json'; CONFIG_FILE='$SB/etc/config.json'; CADDY_BIN='$SB/opt/caddy'; CADDYFILE='$SB/etc/Caddyfile'"
out="$(fl_in '' "$repair_stubs; $rp; action_repair")"
assert_eq "CALL:write_service|CALL:enable panel|CALL:restart panel|CALL:health http://127.0.0.1:8080/api/health" "$(grep '^CALL' <<<"$out" | paste -sd'|' -)" "repair: write_service, enable, restart, health check (no proxy without a domain)"
assert_contains "Service repaired" "$out" "repair: success message"
printf '#!/bin/sh\n' >"$SB/opt/caddy"
chmod +x "$SB/opt/caddy"
echo 'x' >"$SB/etc/Caddyfile"
out="$(fl_in '' "$repair_stubs; $rp; action_repair")"
assert_eq "CALL:write_service|CALL:enable panel|CALL:restart panel|CALL:write_proxy_service|CALL:enable craftrcon-proxy|CALL:restart craftrcon-proxy|CALL:health http://127.0.0.1:8080/api/health" "$(grep '^CALL' <<<"$out" | paste -sd'|' -)" "repair: also recreates the proxy service when installed with a domain"
echo '{"port": 9123}' >"$SB/etc/config.json"
assert_contains "http://127.0.0.1:9123/api/health" "$(fl_in '' "$repair_stubs; $rp; action_repair")" "repair: health check on the configured port"
out="$(fl_in '' "$repair_stubs; $rp; OPT_NO_SERVICE=1; action_repair")"
assert_eq "CALL:stop_background|CALL:start_background|CALL:health http://127.0.0.1:9123/api/health" "$(grep '^CALL' <<<"$out" | paste -sd'|' -)" "repair --no-service: restarts the background process"
out="$(fl_in '' "$repair_stubs; $rp; action_repair" HEALTH_RC=1)" && rc=0 || rc=$?
assert_eq "1" "$rc" "repair: exits 1 when the panel does not answer"
assert_contains "did not answer on port 9123" "$out" "repair: health failure message"
assert_contains "journalctl -u craftrcon" "$out" "repair: failure points to the logs"
out="$(fl_in '' "$repair_stubs; $rp; INIT=none; detect_os() { INIT=none; }; action_repair")" && rc=0 || rc=$?
assert_eq "1" "$rc" "repair without a service manager (and without --no-service) exits 1"
assert_contains "--no-service" "$out" "repair without a service manager mentions --no-service"
set_copy_version 1.4.2
out="$(fl_in $'2' "$repair_stubs; $rp; main" INSTALLED_FILE="$FIX/installed.json")"
assert_contains "CALL:write_service" "$out" "menu option 2 runs the repair"

echo "background panel detection"
# A fake panel: argv[0] is a node path and the script path is among the arguments.
fake_app="$TMP/fake/app"
mkdir -p "$fake_app/src"
bash -c "exec -a /fake/node/bin/node sh -c 'sleep 30' x '$fake_app/src/server.js' </dev/null >/dev/null 2>&1 &" 2>/dev/null
bash -c "exec -a /usr/bin/runuser sh -c 'sleep 30' x /fake/node/bin/node '$fake_app/src/server.js' </dev/null >/dev/null 2>&1 &" 2>/dev/null
sleep 0.5
pids="$(fl "APP_DIR='$fake_app'; panel_pids")"
if [ -n "$pids" ]; then
  assert_eq "1" "$(wc -w <<<"$pids" | tr -d ' ')" "panel_pids finds the node process, not its runuser wrapper"
  assert_ok "stop_background_panel stops it" fl "APP_DIR='$fake_app'; stop_background_panel"
  assert_eq "" "$(fl "APP_DIR='$fake_app'; panel_pids")" "no panel process is left"
  assert_fail "stop_background_panel returns 1 when there is none" fl "APP_DIR='$fake_app'; stop_background_panel"
else
  echo "  (skipped: this system does not expose argv[0] in /proc)"
fi
pkill -f "$fake_app/src/server.js" 2>/dev/null || true

finish
