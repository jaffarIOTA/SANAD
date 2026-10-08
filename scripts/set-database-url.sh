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

# Tries one connection. The error, if any, is kept for the message; it names
# the host or the user and never contains the password.
try_connect() {
  PGCONNECT_TIMEOUT=10 psql "$1" -At -c 'select 1' >/dev/null 2>"${ROOT}/.db-connect-error"
}

case "${HOST}" in
  db.*.supabase.co)
    # The direct host is IPv6-only. The same project is reachable over IPv4
    # through its region's Session pooler, with the user qualified by the
    # project reference. The region is read from Amazon's published ranges
    # for the address the direct host resolves to.
    REF="$(printf '%s' "${HOST}" | sed -E 's#^db\.([^.]+)\.supabase\.co$#\1#')"
    PASS="$(printf '%s' "${URL}" | sed -E 's#^[a-z]+://[^:/]+:([^@]*)@.*#\1#')"
    printf 'That is the direct host, which is IPv6-only here. Looking up the project''s region to use its Session pooler instead ...\n'
    ADDR="$(host -t AAAA "${HOST}" 2>/dev/null | awk '/IPv6 address/ {print $NF; exit}')"
    REGION=""
    if [ -n "${ADDR}" ]; then
      REGION="$(curl -s --max-time 30 https://ip-ranges.amazonaws.com/ip-ranges.json | python3 -c '
import json, sys, ipaddress
addr = ipaddress.ip_address(sys.argv[1]); best = ("", -1)
for p in json.load(sys.stdin)["ipv6_prefixes"]:
    net = ipaddress.ip_network(p["ipv6_prefix"])
    if addr in net and net.prefixlen > best[1]: best = (p["region"], net.prefixlen)
print(best[0])' "${ADDR}" 2>/dev/null || true)"
    fi
    [ -n "${REGION}" ] || fail "could not determine the project's region. Paste the Session pooler string from the dashboard (Connect → Session pooler) instead."
    FOUND=""
    for PREFIX in aws-0 aws-1; do
      CANDIDATE="postgresql://postgres.${REF}:${PASS}@${PREFIX}-${REGION}.pooler.supabase.com:5432/postgres"
      printf 'Trying %s-%s.pooler.supabase.com ...\n' "${PREFIX}" "${REGION}"
      if try_connect "${CANDIDATE}"; then FOUND="${CANDIDATE}"; break; fi
      # A pooler that does not know the project says so; any other answer came from the right pooler and is the real reason.
      grep -q 'tenant/user .* not found' "${ROOT}/.db-connect-error" || break
    done
    if [ -z "${FOUND}" ]; then
      REASON="$(sed -E 's#(postgres(ql)?://)[^@ ]*@#\1***@#g' "${ROOT}/.db-connect-error" | head -1)"
      rm -f "${ROOT}/.db-connect-error"
      case "${REASON}" in
        *"password authentication failed"*) fail "the pooler knows the project but the password was refused. Reset the database password in the dashboard (Project Settings → Database → Reset database password), then paste the string again with the new password." ;;
        *) fail "the pooler refused the connection. ${REASON}" ;;
      esac
    fi
    URL="${FOUND}"
    HOST="$(printf '%s' "${URL}" | sed -E 's#^[a-z]+://([^@/]*@)?([^/:?]+).*#\2#')"
    ;;
  *)
    printf 'Testing a connection to %s ...\n' "${HOST}"
    if ! try_connect "${URL}"; then
      REASON="$(sed -E 's#(postgres(ql)?://)[^@ ]*@#\1***@#g' "${ROOT}/.db-connect-error" | head -2)"
      rm -f "${ROOT}/.db-connect-error"
      fail "could not connect. ${REASON}"
    fi
    ;;
esac
rm -f "${ROOT}/.db-connect-error"

touch "${ENV_FILE}"
TMP="$(mktemp)"
grep -v '^SANAD_DATABASE_URL=' "${ENV_FILE}" > "${TMP}" || true
printf 'SANAD_DATABASE_URL=%s\n' "${URL}" >> "${TMP}"
mv "${TMP}" "${ENV_FILE}"
printf 'Connected and saved. SANAD_DATABASE_URL now points at %s.\n' "${HOST}"
printf 'Next: npm run db:push   (applies the migrations), then restart the apps.\n'
