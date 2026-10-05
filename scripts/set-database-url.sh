#!/usr/bin/env bash
# Point the apps at a hosted database without the connection string ever
# appearing on screen, in shell history, or in a chat.
#
#   npm run db:connect
#
# Paste the project's SESSION POOLER connection string when asked (Supabase
# dashboard → Connect → Session pooler), with the real database password in
# place of [YOUR-PASSWORD]. The input is hidden. The script checks its shape,
# tries one connection, and only then writes SANAD_DATABASE_URL in .env.local.
# The local database stays available as SANAD_TEST_DATABASE_URL for the tests.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ROOT}/.env.local"

printf 'Paste the Session pooler connection string (input hidden), then Enter:\n'
IFS= read -r -s URL
printf '\n'
URL="$(printf '%s' "${URL}" | tr -d '[:space:]')"

fail() { printf 'Not saved: %s\n' "$1" >&2; exit 1; }
[ -n "${URL}" ] || fail 'nothing was pasted.'
case "${URL}" in postgresql://*|postgres://*) ;; *) fail 'it does not start with postgresql://';; esac
case "${URL}" in *'[YOUR-PASSWORD]'*|*'%5BYOUR-PASSWORD%5D'*) fail 'the password placeholder is still in it. Replace [YOUR-PASSWORD] with the database password.';; esac
HOST="$(printf '%s' "${URL}" | sed -E 's#^[a-z]+://([^@/]*@)?([^/:?]+).*#\2#')"
case "${HOST}" in
  db.*.supabase.co) printf 'Note: %s is the direct host, which is IPv6-only. If the connection test fails, use the Session pooler string instead.\n' "${HOST}";;
esac

printf 'Testing a connection to %s ...\n' "${HOST}"
if ! PGCONNECT_TIMEOUT=10 psql "${URL}" -At -c 'select 1' >/dev/null 2>"${ROOT}/.db-connect-error"; then
  # The error may name the host or the user; it never contains the password.
  REASON="$(sed -E 's#(postgres(ql)?://)[^@ ]*@#\1***@#g' "${ROOT}/.db-connect-error" | head -2)"
  rm -f "${ROOT}/.db-connect-error"
  fail "could not connect. ${REASON}"
fi
rm -f "${ROOT}/.db-connect-error"

touch "${ENV_FILE}"
TMP="$(mktemp)"
grep -v '^SANAD_DATABASE_URL=' "${ENV_FILE}" > "${TMP}" || true
printf 'SANAD_DATABASE_URL=%s\n' "${URL}" >> "${TMP}"
mv "${TMP}" "${ENV_FILE}"
printf 'Connected and saved. SANAD_DATABASE_URL now points at %s.\n' "${HOST}"
printf 'Next: npm run db:push   (applies the migrations), then restart the apps.\n'
