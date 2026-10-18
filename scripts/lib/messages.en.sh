#!/usr/bin/env bash
# English messages for the CraftRCON installer. Sourced by common.sh.
# Every MSG_ key must exist in messages.es.sh too (checked by test/shell/test_common.sh).
# Values are printf formats: use %s for arguments and %% for a literal percent sign.
# shellcheck disable=SC2034 # the variables are read indirectly by msg()

MSG_ERR_ROOT='This command needs root privileges. Run it again with: sudo %s'
MSG_ERR_ARCH='Unsupported CPU architecture: %s'
MSG_ERR_OS_FILE='Cannot read the OS information file: %s'
MSG_ERR_OS_UNSUPPORTED='Unsupported Linux distribution: %s'
MSG_ERR_NO_PKG_MANAGER='No supported package manager found (apt, dnf, yum, zypper, pacman or apk).'
MSG_ERR_NO_CURL='curl is required but was not found. Install curl and try again.'
MSG_ERR_VERSION_INVALID='Invalid version number: "%s" (expected X.Y.Z)'
MSG_ERR_PASSWORD_MISSING='No password provided. Set CRAFTRCON_PASSWORD when running non-interactively.'
MSG_ERR_BAD_VARNAME='Invalid variable name: %s'
MSG_PKG_INSTALLING='Installing system packages: %s'
