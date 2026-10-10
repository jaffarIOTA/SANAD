#!/usr/bin/env bash
# The secret scan must catch a token that was committed and later removed (SR-023).
#
# Seeds a throwaway repository: one commit adds an Upstash-shaped token, the next removes it.
# Scans its full history with this repository's .gitleaks.toml and passes only if gitleaks
# reports the leak (exit 1).
#
# Usage: scripts/gitleaks-selftest.sh <gitleaks command…>
#   e.g. scripts/gitleaks-selftest.sh docker run --rm -v "$PWD:/repo" -w /repo ghcr.io/gitleaks/gitleaks:v8.28.0
set -euo pipefail

[ "$#" -gt 0 ] || { echo "usage: $0 <gitleaks command…>" >&2; exit 2; }
root="$(cd "$(dirname "$0")/.." && pwd)"
work="$root/.gitleaks-selftest"
rm -rf "$work"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work"
cp "$root/.gitleaks.toml" "$work/.gitleaks.toml"

cd "$work"
git init -q
git config user.email selftest@example.invalid
git config user.name selftest
# A synthetic value of the right shape; it opens nothing.
printf 'UPSTASH_REDIS_REST_TOKEN="%s"\n' "AYxSYNTHETICselftestTOKENvalueABCDEFGHIJKLMNOPQRSTUV0123" > .env.example
git add .env.example && git commit -q -m "add config"
printf 'UPSTASH_REDIS_REST_TOKEN=""\n' > .env.example
git commit -q -am "remove the token"

scan() { (cd "$root" && "$@" git --log-opts=--all --config /repo/.gitleaks-selftest/.gitleaks.toml \
  --no-banner --redact /repo/.gitleaks-selftest); }

set +e
report="$(scan "$@" -v 2>&1)"
found=$?
set -e
# Exit 1 alone could be an error; the report must name the rule that fired.
if [ "$found" -ne 1 ] || ! printf '%s' "$report" | grep -q 'upstash-redis-rest-token'; then
  echo "self-test FAILED: a token removed in a later commit was not reported (exit $found)" >&2
  printf '%s\n' "$report" | tail -5 >&2
  exit 1
fi
echo "self-test passed: a token in an old commit fails the scan"
