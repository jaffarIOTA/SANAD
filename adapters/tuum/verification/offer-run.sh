#!/usr/bin/env bash
# OI-02, steps A.2 to A.5 — does the sandbox derive a rate on a Tawarruq-shaped offer?
#
# Creates one synthetic person (fictitious name, id number and address; nothing
# real), opens a servicing account for it, raises an offer under a loan product
# with NO rate supplied and a fixed repayment, reads the offer's schedule,
# accepts it, and reads the contract version's record and components. Every
# response is saved under verification/findings/ (gitignored) for the README.
#
# Credentials come from the vault through the audited function. The token is
# held in a shell variable for the run and written nowhere.
#
# What the 2026-10-08 run taught, now built in (see README "Steps A.2–A.5"):
#   - loanPeriod and numberOfPayments are mutually exclusive on the offer.
#   - the sandbox's riyal products carry invoiceTermDays / minBillingPeriodDays of
#     30, which a monthly cycle fails (err.invoiceTermDaysTooLong); a two-month
#     cycle (paymentFrequency 2 MONTH) is accepted.
#   - the offer needs a servicingAccountId; an explicit IBAN instruction is not
#     enough (err.paymentInstructionBeneficiaryAccountIdMissing). Opening the
#     account needs a customerGroupCode and a priceListTypeCode valid for it.
#
#   adapters/tuum/verification/offer-run.sh [loanTypeCode] [tenant-code] [customerGroupCode] [priceListTypeCode]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
PRODUCT="${1:-TAWRROUQ}"
TENANT_CODE="${2:-bank-a}"
CUSTOMER_GROUP="${3:-P_RESIDENT}"
PRICE_LIST="${4:-RETAIL_CURR_PRICE_LIST}"
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

errs() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); e=[x.get("code", x) if isinstance(x, dict) else x for x in (d.get("errors") or []) + (d.get("validationErrors") or [])]; print("  errors:", json.dumps(e)[:300]) if e else None' "$1"; }
pick() { python3 -c 'import json,sys; d=(json.load(open(sys.argv[1])).get("data") or {}); d = d[0] if isinstance(d, list) and d else d; print("  ", {k: d.get(k) for k in sys.argv[2].split(",")})' "$1" "$2"; }
field() { python3 -c 'import json,sys; d=(json.load(open(sys.argv[1])).get("data") or {}); d = d[0] if isinstance(d, list) and d else d; print(d.get(sys.argv[2]) or "" if isinstance(d, dict) else "")' "$1" "$2"; }
STAMP="$(date +%Y%m%d%H%M%S)"

printf 'A.2a  synthetic person\n'
curl -sS --max-time 30 -X POST "${PERSON_HOST}/api/v2/persons" "${H[@]}" -o "${F}/person.json" -w '  HTTP %{http_code}\n' -d "{\"personTypeCode\":\"P\",\"givenName\":\"Sanad\",\"surname\":\"Verification ${STAMP}\",\"residencyCountryCode\":\"SA\",\"nationality\":\"SA\",\"language\":\"en\",\"birthDate\":\"1990-01-01\",\"sex\":\"M\",\"identificationNumbers\":[{\"idCountryCode\":\"SA\",\"idNumber\":\"SANAD-TEST-${STAMP}\",\"primary\":true}],\"addresses\":[{\"addressTypeCode\":\"R\",\"countryCode\":\"SA\",\"cityCounty\":\"Riyadh\",\"street1\":\"Test Street 1\",\"zip\":\"00000\"}]}"
errs "${F}/person.json"; PID="$(field "${F}/person.json" personId)"
[ -n "${PID}" ] || exit 1
printf '  personId %s…\n' "${PID:0:8}"

printf 'A.2b  servicing account (CURRENCY, SAR, group %s, price list %s)\n' "${CUSTOMER_GROUP}" "${PRICE_LIST}"
curl -sS --max-time 30 -X POST "${ACCOUNT_HOST}/api/v4/persons/${PID}/accounts" "${H[@]}" -o "${F}/account.json" -w '  HTTP %{http_code}\n' -d "{\"accountTypeCode\":\"CURRENCY\",\"currencyCode\":\"SAR\",\"personName\":\"Sanad Verification\",\"residencyCountryCode\":\"SA\",\"personTypeCode\":\"P\",\"customerGroupCode\":\"${CUSTOMER_GROUP}\",\"priceListTypeCode\":\"${PRICE_LIST}\",\"accountName\":\"Sanad verification servicing\"}"
errs "${F}/account.json"; pick "${F}/account.json" statusCode,accountTypeCode; AID="$(field "${F}/account.json" accountId)"
[ -n "${AID}" ] || { printf '  Customer group codes: GET %s/api/v1/accounts/customer-group-codes; price lists: GET /api/v1/price-lists-with-prices.\n' "${ACCOUNT_HOST}"; exit 1; }

printf 'A.2c  offer under %s with no rate: 10,000 SAR, 2 payments two months apart, repayment 5,250 (a fixed 500 of profit)\n' "${PRODUCT}"
curl -sS --max-time 30 -X POST "${LOAN_HOST}/api/v3/persons/${PID}/offers" "${H[@]}" -o "${F}/offer-created.json" -w '  HTTP %{http_code}\n' -d "{\"tenantCode\":\"${TUUM_TENANT}\",\"countryCode\":\"SA\",\"loanTypeCode\":\"${PRODUCT}\",\"servicingAccountId\":\"${AID}\",\"requestedMoney\":{\"amount\":10000,\"currencyCode\":\"SAR\"},\"offeredMoney\":{\"amount\":10000,\"currencyCode\":\"SAR\"},\"loanPeriod\":4,\"paymentDay\":8,\"paymentFrequency\":2,\"paymentFrequencyUnit\":\"MONTH\",\"repaymentMoney\":{\"amount\":5250,\"currencyCode\":\"SAR\"}}"
errs "${F}/offer-created.json"; pick "${F}/offer-created.json" offerId,statusCode,scheduleTypeCode,interestRate,apr,interestTypeCode,interestMarginRate,repaymentMoney,grossMoney,netMoney,numberOfPayments,loanPeriod
OID="$(field "${F}/offer-created.json" offerId)"
[ -n "${OID}" ] || exit 1

printf 'A.2d  the offer’s schedule (component rows: PRI and INT per payment date)\n'
curl -sS --max-time 30 "${LOAN_HOST}/api/v1/offers/${OID}/schedule" "${H[@]}" -o "${F}/offer-schedule.json" -w '  HTTP %{http_code}\n'
python3 -c 'import json,sys; rows=json.load(open(sys.argv[1])).get("data") or []; [print("  ", r.get("paymentDate"), r.get("componentTypeCode"), (r.get("paymentMoney") or {}).get("amount"), "days", r.get("daysOfInterest")) for r in rows]' "${F}/offer-schedule.json"

printf 'A.3   accept\n'
curl -sS --max-time 30 -X POST "${LOAN_HOST}/api/v2/offers/${OID}/accept" "${H[@]}" -o "${F}/offer-accepted.json" -w '  HTTP %{http_code}\n'
errs "${F}/offer-accepted.json"; pick "${F}/offer-accepted.json" statusCode,statusCodeReason,interestRate,apr,interestTypeCode,scheduleTypeCode,repaymentMoney

printf 'A.4   the contract\n'
curl -sS --max-time 30 "${LOAN_HOST}/api/v2/offers/${OID}/contracts" "${H[@]}" -o "${F}/offer-contracts.json" -w '  HTTP %{http_code}\n'
errs "${F}/offer-contracts.json"; pick "${F}/offer-contracts.json" headerId,contractNumber,activeVersionId,firstVersionId,repaymentChannelCode
HID="$(field "${F}/offer-contracts.json" headerId)"; VID="$(field "${F}/offer-contracts.json" activeVersionId)"; [ -n "${VID}" ] || VID="$(field "${F}/offer-contracts.json" firstVersionId)"
[ -n "${HID}" ] && [ -n "${VID}" ] || exit 0

printf 'A.5   the contract version, its components and the interest record\n'
curl -sS --max-time 30 "${LOAN_HOST}/api/v1/versions/${VID}" "${H[@]}" -o "${F}/contract-version.json" -w '  HTTP %{http_code}\n'
pick "${F}/contract-version.json" versionId,statusCode,interestRate,apr,scheduleTypeCode,repaymentMoney
curl -sS --max-time 30 "${LOAN_HOST}/api/v2/versions/${VID}/components" "${H[@]}" -o "${F}/contract-components.json" -w '  HTTP %{http_code}\n'
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])).get("data") or []; [print("  ", {k: c.get(k) for k in ("componentTypeCode","rate","rateTypeCode","calculationMethod","initialMoney")}) for c in d]' "${F}/contract-components.json"
curl -sS --max-time 30 "${LOAN_HOST}/api/v1/contracts/${HID}/interests" "${H[@]}" -o "${F}/contract-interests.json" -w '  HTTP %{http_code}\n'
python3 -c 'import json,sys; print("  ", json.dumps(json.load(open(sys.argv[1])).get("data"))[:600])' "${F}/contract-interests.json"
unset TOKEN
printf 'Responses saved under adapters/tuum/verification/findings/. Record the findings in adapters/tuum/README.md.\n'
