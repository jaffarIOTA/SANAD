#!/usr/bin/env bash
# OI-02, step A.1 — what loan products does the Tuum sandbox hold?
#
# Reads the TUUM sandbox credentials from the vault through the audited
# function (never from a file, never from an argument), authenticates as the
# employee, lists the loan products, and writes the response to
# adapters/tuum/verification/findings/loan-products.<date>.json for the README.
#
# Nothing secret is printed. The token lives in a shell variable for the
# duration of the run and is not written anywhere.
#
#   adapters/tuum/verification/list-products.sh [tenant-code]   (default bank-a)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
TENANT_CODE="${1:-bank-a}"
URL="$(grep '^SANAD_DATABASE_URL=' "${ROOT}/.env.local" | head -1 | cut -d= -f2-)"
[ -n "${URL}" ] || { printf 'SANAD_DATABASE_URL is not set in .env.local. Run: npm run db:connect\n' >&2; exit 1; }

# Reads one credential by name through the audited vault function. Several
# spellings are accepted for a name, in order, because the vendor's own
# documentation spells some in camel case and the vault keeps what was saved.
read_credential() {
  local name
  for name in "$@"; do
    if value="$(psql "${URL}" -At -v ON_ERROR_STOP=1 -c \
      "select config.get_integration_credential((select id from core.tenant where code = '${TENANT_CODE}'), 'TUUM', 'sandbox', '${name}', gen_random_uuid())" 2>/dev/null)"; then
      printf '%s' "${value}"; return 0
    fi
  done
  return 1
}
required() { read_credential "$@" || { printf 'No TUUM sandbox credential named %s for %s. Save it in Admin → Credentials.\n' "$1" "${TENANT_CODE}" >&2; exit 1; }; }

USERNAME="$(required username)"
PASSWORD="$(required password)"
TUUM_TENANT="$(required tenant_code tenantcode tenantCode)"
AUTH_HOST="$(required auth_base_url)"
# The loan module's host, or the authentication host with its module name swapped, which is how the sandbox names its modules.
LOAN_HOST="$(read_credential loan_api_base_url loan_base_url || printf '%s' "${AUTH_HOST}" | sed 's#//auth-api\.#//loan-api.#')"

printf 'Authenticating as an employee of tenant %s at %s ...\n' "${TUUM_TENANT}" "${AUTH_HOST}"
BODY="$(python3 -c 'import json,sys; print(json.dumps({"csrfToken": "string", "username": sys.argv[1], "password": sys.argv[2], "tenantCode": sys.argv[3]}))' "${USERNAME}" "${PASSWORD}" "${TUUM_TENANT}")"
AUTH_RESPONSE="$(curl -sS --max-time 30 -X POST "${AUTH_HOST}/api/v1/employees/authorise" \
  -H 'accept: application/json' -H "x-tenant-code: ${TUUM_TENANT}" -H 'Accept-Language: en' -H 'Content-Type: application/json' \
  --data-binary "${BODY}")"
unset BODY PASSWORD
TOKEN="$(printf '%s' "${AUTH_RESPONSE}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
data = d.get("data") or {}
token = data.get("token") or data.get("accessToken") or d.get("token") or ""
print(token)')"
if [ -z "${TOKEN}" ]; then
  printf 'Authentication did not return a token. Error codes: %s\n' "$(printf '%s' "${AUTH_RESPONSE}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print([e.get("code", e) if isinstance(e, dict) else e for e in (d.get("errors") or []) + (d.get("validationErrors") or [])])' 2>/dev/null || echo 'unreadable response')" >&2
  exit 1
fi
printf 'Authenticated. Listing loan products at %s ...\n' "${LOAN_HOST}"

OUT_DIR="${ROOT}/adapters/tuum/verification/findings"
mkdir -p "${OUT_DIR}"
OUT="${OUT_DIR}/loan-products.$(date +%Y-%m-%d).json"
# The token travels in x-auth-token; an Authorization header is silently ignored (README, finding 2).
HTTP="$(curl -sS --max-time 30 -o "${OUT}" -w '%{http_code}' "${LOAN_HOST}/api/v1/loan-products" \
  -H 'accept: application/json' -H "x-tenant-code: ${TUUM_TENANT}" -H "x-auth-token: ${TOKEN}")"
unset TOKEN
printf 'HTTP %s. Response saved to %s\n' "${HTTP}" "${OUT#${ROOT}/}"
python3 - "${OUT}" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print('response is not JSON:', e); sys.exit(0)
items = d.get('data') if isinstance(d, dict) else d
if isinstance(items, dict): items = items.get('content') or items.get('items') or [items]
if not isinstance(items, list):
    print('shape:', type(d).__name__, 'keys:', list(d.keys())[:10] if isinstance(d, dict) else ''); sys.exit(0)
print(f'{len(items)} product(s):')
for p in items:
    if isinstance(p, dict):
        print('  -', p.get('productCode') or p.get('code') or p.get('id'), '|', p.get('productName') or p.get('name'), '|', p.get('productType') or p.get('type') or p.get('scheduleType'), '|', p.get('currencyCode') or p.get('currency'))
PY
