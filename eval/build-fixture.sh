#!/usr/bin/env bash
# Rebuild the evalLoop.md mapLimit fixture as a throwaway git repo.
# Seeds in ./seeds/ are LITERAL copies, sha-verified 2026-08-07 against
# /Users/awesome/dev/devtest/advisor/docs/evalLoop.md -- no doc parsing, so this
# cannot drift the way an extraction script can.
#   acceptance.test.js sha256 = 986f39c6ef98f146e640e7ac2b688a1a9cd347dc3bb745c73923fae240a64eaf
#   run1 seed (batching) -> 5 tests, 4 pass, 1 fail   (suite RED at t=0)
#   run2 seed (pool)     -> 5 tests, 5 pass, 0 fail   (GREEN but violates contract clauses 5 and 6)
# Usage: build-fixture.sh <dest-dir> [run1|run2]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:?usage: build-fixture.sh <dest-dir> [run1|run2]}"
SEED="${2:-run1}"
case "$SEED" in run1|run2) ;; *) echo "seed must be run1 or run2" >&2; exit 2;; esac
rm -rf "$DEST"; mkdir -p "$DEST/src" "$DEST/test"
cp "$HERE/seeds/acceptance.test.js" "$DEST/test/acceptance.test.js"
cp "$HERE/seeds/mapLimit.$SEED.js" "$DEST/src/mapLimit.js"
cd "$DEST"
git init -q .; git config user.email eval@local; git config user.name eval
git add src test; git commit -qm "eval fixture: mapLimit $SEED seed"
echo "--- sha256 acceptance suite (expect 986f39c6ef98f146e640e7ac2b688a1a9cd347dc3bb745c73923fae240a64eaf) ---"
shasum -a 256 test/acceptance.test.js
echo "--- baseline ---"
node --test --test-timeout=20000 test/acceptance.test.js 2>&1 | grep -E '^# (tests|pass|fail)' || true
echo "fixture ready at $DEST (seed=$SEED)"
