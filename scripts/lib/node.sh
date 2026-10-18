#!/usr/bin/env bash
# CraftRCON installer: Node.js runtime. Sourced after common.sh (uses msg/info/die,
# version_cmp, detect_arch and the NODE_DIR/OPT_DIR constants).
#
#   node_resolve   decides what ensure_node will do (no system changes): sets NODE_ACTION
#                  (keep|download|apk) and, for downloads, NODE_TARBALL/NODE_SHA256/NODE_URL.
#   ensure_node    installs Node if needed and exports NODE_BIN and NPM_BIN.
#
# Environment knobs (tests): NODE_DIST_URL (default https://nodejs.org/dist/latest-v24.x).

NODE_MIN_VERSION=22.13.0
NODE_DIST_URL="${NODE_DIST_URL:-https://nodejs.org/dist/latest-v24.x}"

# node_version_of BIN: prints the X.Y.Z version of a node binary (nothing if it fails).
node_version_of() {
  local _v
  _v="$("$1" --version 2>/dev/null || true)"
  _v="${_v#v}"
  if [[ "$_v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$_v"; fi
}

# node_version_ok BIN: true when BIN runs and is >= NODE_MIN_VERSION.
node_version_ok() {
  local _v _c
  [ -x "$1" ] || return 1
  _v="$(node_version_of "$1")"
  [ -n "$_v" ] || return 1
  _c="$(version_cmp "$_v" "$NODE_MIN_VERSION")" || return 1
  [ "$_c" != -1 ]
}

# node_pick_tarball SHASUMS_FILE ARCH: prints "<sha256> <file>" for the linux tar.xz of ARCH.
# (No {n} intervals in the regexes: mawk, Debian's default awk, does not support them.)
node_pick_tarball() {
  awk -v arch="$2" '
    $2 ~ ("^node-v[0-9]+\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") && length($1) == 64 && $1 ~ /^[0-9a-f]+$/ {
      print $1, $2
      exit
    }
  ' "$1"
}

# node_resolve WORKDIR: no system changes; may download SHASUMS256.txt into WORKDIR.
node_resolve() {
  local _work="$1" _arch _pick
  NODE_ACTION='' NODE_TARBALL='' NODE_SHA256='' NODE_URL=''
  if [ "${LIBC:-glibc}" = musl ]; then
    NODE_ACTION=apk
    return 0
  fi
  # shellcheck disable=SC2153 # NODE_DIR is defined by common.sh
  if node_version_ok "$NODE_DIR/bin/node"; then
    NODE_ACTION=keep
    return 0
  fi
  _arch="$(detect_arch)"
  if ! curl -fsSL --retry 3 --connect-timeout 10 -o "$_work/SHASUMS256.txt" "$NODE_DIST_URL/SHASUMS256.txt"; then
    die ERR_NODE_INDEX "$NODE_DIST_URL/SHASUMS256.txt"
  fi
  _pick="$(node_pick_tarball "$_work/SHASUMS256.txt" "$_arch")"
  [ -n "$_pick" ] || die ERR_NODE_NO_BUILD "$_arch"
  NODE_SHA256="${_pick%% *}"
  NODE_TARBALL="${_pick#* }"
  NODE_URL="$NODE_DIST_URL/$NODE_TARBALL"
  NODE_ACTION=download
}

# ensure_node WORKDIR: installs Node as decided by node_resolve (called here if it was not
# yet) and exports NODE_BIN / NPM_BIN. The tarball is extracted inside OPT_DIR and then
# renamed into NODE_DIR, so the files get /opt's SELinux label (not the one of /tmp).
ensure_node() {
  local _work="$1" _got _staging="$OPT_DIR/node.new" _v
  [ -n "${NODE_ACTION:-}" ] || node_resolve "$_work"
  case "$NODE_ACTION" in
    keep)
      NODE_BIN="$NODE_DIR/bin/node"
      NPM_BIN="$NODE_DIR/bin/npm"
      info NODE_KEEP "$(node_version_of "$NODE_BIN")" "$NODE_DIR"
      ;;
    apk)
      apk add --no-cache nodejs npm
      NODE_BIN="$(command -v node || true)"
      NPM_BIN="$(command -v npm || true)"
      if [ -z "$NODE_BIN" ] || ! node_version_ok "$NODE_BIN"; then
        die NODE_TOO_OLD_ALPINE "$(node_version_of "${NODE_BIN:-node}")" "$NODE_MIN_VERSION"
      fi
      ;;
    download)
      info NODE_DOWNLOADING "${NODE_TARBALL%.tar.xz}"
      curl -fL --retry 3 --connect-timeout 10 "$(curl_progress)" -o "$_work/$NODE_TARBALL" "$NODE_URL" ||
        die ERR_DOWNLOAD "$NODE_URL"
      _got="$(sha256sum "$_work/$NODE_TARBALL")"
      _got="${_got%% *}"
      [ "$_got" = "$NODE_SHA256" ] || die ERR_CHECKSUM "$NODE_TARBALL"
      mkdir -p "$OPT_DIR"
      rm -rf "$_staging"
      mkdir -p "$_staging"
      tar -xJf "$_work/$NODE_TARBALL" -C "$_staging" --strip-components=1 --no-same-owner
      rm -rf "$NODE_DIR"
      mv "$_staging" "$NODE_DIR"
      chown -R root:root "$NODE_DIR"
      NODE_BIN="$NODE_DIR/bin/node"
      NPM_BIN="$NODE_DIR/bin/npm"
      node_version_ok "$NODE_BIN" || die ERR_NODE_BROKEN "$NODE_BIN"
      ;;
    *) die ERR_NODE_INDEX "$NODE_DIST_URL/SHASUMS256.txt" ;;
  esac
  _v="$(node_version_of "$NODE_BIN")"
  NODE_VERSION="$_v"
  export NODE_BIN NPM_BIN NODE_VERSION
}
