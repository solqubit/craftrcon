#!/usr/bin/env bash
# Tiny assertion helpers shared by test/shell/test_*.sh (sourced, not executed).

T_PASS=0
T_FAIL=0

assert_eq() { # assert_eq EXPECTED ACTUAL LABEL
  if [ "$1" = "$2" ]; then
    T_PASS=$((T_PASS + 1))
    printf '  ok   %s\n' "$3"
  else
    T_FAIL=$((T_FAIL + 1))
    printf '  FAIL %s\n       expected: [%s]\n       actual:   [%s]\n' "$3" "$1" "$2"
  fi
}

assert_ok() { # assert_ok LABEL CMD [ARGS...]   (command must succeed)
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    T_PASS=$((T_PASS + 1))
    printf '  ok   %s\n' "$label"
  else
    T_FAIL=$((T_FAIL + 1))
    printf '  FAIL %s (command failed: %s)\n' "$label" "$*"
  fi
}

assert_fail() { # assert_fail LABEL CMD [ARGS...]   (command must fail)
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    T_FAIL=$((T_FAIL + 1))
    printf '  FAIL %s (command unexpectedly succeeded: %s)\n' "$label" "$*"
  else
    T_PASS=$((T_PASS + 1))
    printf '  ok   %s\n' "$label"
  fi
}

assert_contains() { # assert_contains NEEDLE HAYSTACK LABEL
  case "$2" in
    *"$1"*)
      T_PASS=$((T_PASS + 1))
      printf '  ok   %s\n' "$3"
      ;;
    *)
      T_FAIL=$((T_FAIL + 1))
      printf '  FAIL %s\n       [%s] not found in [%s]\n' "$3" "$1" "$2"
      ;;
  esac
}

finish() { # prints the summary and exits non-zero on any failure
  printf '  %d passed, %d failed\n' "$T_PASS" "$T_FAIL"
  [ "$T_FAIL" -eq 0 ]
  exit $?
}
