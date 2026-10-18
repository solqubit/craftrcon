#!/usr/bin/env bash
# Runs every test/shell/test_*.sh; exits 1 if any of them fails.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
failed=0
for t in ./test_*.sh; do
  echo "== $t"
  bash "$t" || failed=1
done
if [ "$failed" -ne 0 ]; then
  echo "SHELL TESTS FAILED" >&2
  exit 1
fi
echo "ALL SHELL TESTS PASSED"
