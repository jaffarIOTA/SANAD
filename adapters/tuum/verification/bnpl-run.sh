#!/usr/bin/env bash
# TUUM-SERV-01 — can the sandbox book a BNPL loan the way Sanad needs it?
#
# Creates one synthetic person (fictitious name, id number and address; nothing
# real), opens a current account for it as the loan's servicing account, raises
# an offer under the BNPL product with no interest supplied, reads the offer's
# schedule, accepts it, and reads the contract, its version, its components and
# its receivables. Every response is saved under verification/findings/
# (gitignored) as bnpl-*.json for the README.
#
# Credentials come from the vault through the audited function. The token is
# held in a shell variable for the run and written nowhere.
#
#   adapters/tuum/verification/bnpl-run.sh [loanTypeCode] [amount SAR] [payments] [paymentDay] [accountTypeCode]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PRODUCT="${1:-KBNPL}"
AMOUNT="${2:-4000}"
PAYMENTS="${3:-4}"
PAYMENT_DAY="${4:-3}"
ACCOUNT_TYPE="${5:-CURRENCY}"
TENANT_CODE="bank-a"
CUSTOMER_GROUP="P_RESIDENT"
PRICE_LIST="RETAIL_CURR_PRICE_LIST"
F="${ROOT}/adapters/tuum/verification/findings"; mkdir -p "${F}"
URL="$(grep '^SANAD_DATABASE_URL=' "${ROOT}/.env.local" | head -1 | cut -d= -f2-)"
[ -n "${URL}" ] || { printf 'SANAD_DATABASE_URL is not set in .env.local.\n' >&2; exit 1; }

cred() {
  local name
  for name in "$@"; do
    if v="$(psql "${URL}" -At -v ON_ERROR_STOP=1 -c "select config.get_integration_credential((select id from core.tenant where code = '${TENANT_CODE}'), 'TUUM', 'sandbox', '${name}', gen_random_uuid())" 2>/dev/null)"; then printf '%s' "${v}"; return 0; fi
  done
  printf 'No TUUM sandbox credential named %s. Save it in Admin → Credentials.\n' "$1" >&2; exit 1
}
USERNAME="$(cred username)"; PASSWORD="$(cred password)"; TUUM_TENANT="$(cred tenant_code tenantcode tenantCode)"; AUTH_HOST="$(cred auth_base_url)"
LOAN_HOST="$(printf '%s' "${AUTH_HOST}" | sed 's#//auth-api\.#//loan-api.#')"
PERSON_HOST="$(printf '%s' "${AUTH_HOST}" | sed 's#//auth-api\.#//person-api.#')"
ACCOUNT_HOST="$(printf '%s' "${AUTH_HOST}" | sed 's#//auth-api\.#//account-api.#')"

BODY="$(python3 -c 'import json,sys; print(json.dumps({"csrfToken": "string", "username": sys.argv[1], "password": sys.argv[2], "tenantCode": sys.argv[3]}))' "${USERNAME}" "${PASSWORD}" "${TUUM_TENANT}")"
TOKEN="$(curl -sS --max-time 30 -X POST "${AUTH_HOST}/api/v1/employees/authorise" -H 'accept: application/json' -H "x-tenant-code: ${TUUM_TENANT}" -H 'Content-Type: application/json' --data-binary "${BODY}" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("data") or {}).get("token", ""))')"
unset BODY PASSWORD
[ -n "${TOKEN}" ] || { printf 'Authentication returned no token.\n' >&2; exit 1; }
H=(-H 'accept: application/json' -H "x-tenant-code: ${TUUM_TENANT}" -H "x-auth-token: ${TOKEN}" -H 'Content-Type: application/json')

errs() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); e=[x.get("code", x) if isinstance(x, dict) else x for x in (d.get("errors") or []) + (d.get("validationErrors") or [])]; print("  errors:", json.dumps(e)[:600]) if e else None' "$1"; }
pick() { python3 -c 'import json,sys; d=(json.load(open(sys.argv[1])).get("data") or {}); d = d[0] if isinstance(d, list) and d else d; print("  ", {k: d.get(k) for k in sys.argv[2].split(",")}) if isinstance(d, dict) else None' "$1" "$2"; }
field() { python3 -c 'import json,sys; d=(json.load(open(sys.argv[1])).get("data") or {}); d = d[0] if isinstance(d, list) and d else d; print(d.get(sys.argv[2]) or "" if isinstance(d, dict) else "")' "$1" "$2"; }
STAMP="$(date +%Y%m%d%H%M%S)"

# The product's limitUsageRule is SPECIFIC_DATE: the offer names the date the loan is drawn (err.limitUsageDateMissing otherwise).
USAGE_DATE="${USAGE_DATE:-$(date +%Y-%m-%d)}"

# PERSON_ID and ACCOUNT_ID reuse a synthetic person and account from an earlier run, so a retry adds no new party.
if [ -n "${PERSON_ID:-}" ] && [ -n "${ACCOUNT_ID:-}" ]; then
  PID="${PERSON_ID}"; AID="${ACCOUNT_ID}"; printf '1–2  reusing person %s… and its account\n' "${PID:0:8}"
else
printf '1  synthetic person\n'
curl -sS --max-time 30 -X POST "${PERSON_HOST}/api/v2/persons" "${H[@]}" -o "${F}/bnpl-person.json" -w '  HTTP %{http_code}\n' -d "{\"personTypeCode\":\"P\",\"givenName\":\"Sanad\",\"surname\":\"BNPL Verification ${STAMP}\",\"residencyCountryCode\":\"SA\",\"nationality\":\"SA\",\"language\":\"en\",\"birthDate\":\"1990-01-01\",\"sex\":\"M\",\"identificationNumbers\":[{\"idCountryCode\":\"SA\",\"idNumber\":\"SANAD-TEST-${STAMP}\",\"primary\":true}],\"addresses\":[{\"addressTypeCode\":\"R\",\"countryCode\":\"SA\",\"cityCounty\":\"Riyadh\",\"street1\":\"Test Street 1\",\"zip\":\"00000\"}]}"
errs "${F}/bnpl-person.json"; PID="$(field "${F}/bnpl-person.json" personId)"
[ -n "${PID}" ] || exit 1
printf '  personId %s…\n' "${PID:0:8}"

printf '2  servicing account (%s, SAR, group %s, price list %s)\n' "${ACCOUNT_TYPE}" "${CUSTOMER_GROUP}" "${PRICE_LIST}"
curl -sS --max-time 30 -X POST "${ACCOUNT_HOST}/api/v4/persons/${PID}/accounts" "${H[@]}" -o "${F}/bnpl-account.json" -w '  HTTP %{http_code}\n' -d "{\"accountTypeCode\":\"${ACCOUNT_TYPE}\",\"currencyCode\":\"SAR\",\"personName\":\"Sanad BNPL Verification\",\"residencyCountryCode\":\"SA\",\"personTypeCode\":\"P\",\"customerGroupCode\":\"${CUSTOMER_GROUP}\",\"priceListTypeCode\":\"${PRICE_LIST}\",\"accountName\":\"Sanad BNPL servicing\"}"
errs "${F}/bnpl-account.json"; pick "${F}/bnpl-account.json" statusCode,accountTypeCode; AID="$(field "${F}/bnpl-account.json" accountId)"
[ -n "${AID}" ] || exit 1
printf '  to reuse: PERSON_ID=%s ACCOUNT_ID=%s\n' "${PID}" "${AID}"
fi

printf '3  offer under %s, no interest supplied: %s SAR, %s monthly payments on day %s\n' "${PRODUCT}" "${AMOUNT}" "${PAYMENTS}" "${PAYMENT_DAY}"
curl -sS --max-time 30 -X POST "${LOAN_HOST}/api/v3/persons/${PID}/offers" "${H[@]}" -o "${F}/bnpl-offer-created.json" -w '  HTTP %{http_code}\n' -d "{\"tenantCode\":\"${TUUM_TENANT}\",\"countryCode\":\"SA\",\"loanTypeCode\":\"${PRODUCT}\",\"servicingAccountId\":\"${AID}\",\"requestedMoney\":{\"amount\":${AMOUNT},\"currencyCode\":\"SAR\"},\"offeredMoney\":{\"amount\":${AMOUNT},\"currencyCode\":\"SAR\"},\"loanPeriod\":${PAYMENTS},\"paymentDay\":${PAYMENT_DAY},\"paymentFrequency\":1,\"paymentFrequencyUnit\":\"MONTH\",\"limitUsageDate\":\"${USAGE_DATE}\"}"
errs "${F}/bnpl-offer-created.json"; pick "${F}/bnpl-offer-created.json" offerId,statusCode,scheduleTypeCode,interestRate,apr,interestTypeCode,repaymentMoney,grossMoney,netMoney,numberOfPayments,loanPeriod
OID="$(field "${F}/bnpl-offer-created.json" offerId)"
[ -n "${OID}" ] || exit 1

printf '4  the offer schedule\n'
curl -sS --max-time 30 "${LOAN_HOST}/api/v1/offers/${OID}/schedule" "${H[@]}" -o "${F}/bnpl-offer-schedule.json" -w '  HTTP %{http_code}\n'
errs "${F}/bnpl-offer-schedule.json"
python3 -c 'import json,sys; rows=json.load(open(sys.argv[1])).get("data") or []; [print("  ", r.get("paymentDate"), r.get("componentTypeCode"), (r.get("paymentMoney") or {}).get("amount")) for r in rows]' "${F}/bnpl-offer-schedule.json"

printf '5  accept\n'
curl -sS --max-time 30 -X POST "${LOAN_HOST}/api/v2/offers/${OID}/accept" "${H[@]}" -o "${F}/bnpl-offer-accepted.json" -w '  HTTP %{http_code}\n'
errs "${F}/bnpl-offer-accepted.json"; pick "${F}/bnpl-offer-accepted.json" statusCode,statusCodeReason,interestRate,apr,scheduleTypeCode,repaymentMoney

printf '6  the contract\n'
curl -sS --max-time 30 "${LOAN_HOST}/api/v2/offers/${OID}/contracts" "${H[@]}" -o "${F}/bnpl-offer-contracts.json" -w '  HTTP %{http_code}\n'
errs "${F}/bnpl-offer-contracts.json"; pick "${F}/bnpl-offer-contracts.json" headerId,contractNumber,statusCode,activeVersionId,firstVersionId,repaymentChannelCode
HID="$(field "${F}/bnpl-offer-contracts.json" headerId)"; VID="$(field "${F}/bnpl-offer-contracts.json" activeVersionId)"; [ -n "${VID}" ] || VID="$(field "${F}/bnpl-offer-contracts.json" firstVersionId)"
[ -n "${HID}" ] && [ -n "${VID}" ] || { unset TOKEN; exit 0; }

printf '7  the contract version, its components and its receivables\n'
curl -sS --max-time 30 "${LOAN_HOST}/api/v1/versions/${VID}" "${H[@]}" -o "${F}/bnpl-contract-version.json" -w '  HTTP %{http_code}\n'
pick "${F}/bnpl-contract-version.json" versionId,statusCode,interestRate,apr,scheduleTypeCode,repaymentMoney
curl -sS --max-time 30 "${LOAN_HOST}/api/v2/versions/${VID}/components" "${H[@]}" -o "${F}/bnpl-contract-components.json" -w '  HTTP %{http_code}\n'
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])).get("data") or []; [print("  ", {k: c.get(k) for k in ("componentTypeCode","rate","rateTypeCode","initialMoney")}) for c in d]' "${F}/bnpl-contract-components.json"
curl -sS --max-time 30 "${LOAN_HOST}/api/v1/contracts/${HID}/receivables" "${H[@]}" -o "${F}/bnpl-contract-receivables.json" -w '  HTTP %{http_code}\n'
errs "${F}/bnpl-contract-receivables.json"
python3 -c 'import json,sys; print("  ", json.dumps(json.load(open(sys.argv[1])).get("data"))[:800])' "${F}/bnpl-contract-receivables.json"
unset TOKEN
printf 'Responses saved under adapters/tuum/verification/findings/bnpl-*.json. Record the findings in adapters/tuum/README.md.\n'
