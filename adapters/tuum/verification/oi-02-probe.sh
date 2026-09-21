#!/usr/bin/env bash
#
# OI-02 probe — does the core banking Loan module derive and persist a rate?
#
# Tuum's own published example for POST /api/v2/offers/{offerId}/accept returns
# "interestRate": 1.539 and "apr": 2.11 on the created contract, from a request
# that supplied neither. This script reproduces that against the sandbox on the
# product type most likely to avoid it — a single-payment BULLET, which is the
# closest shape to a Murabaha.
#
#   A null rate and a null annualised percentage reopens the Loan module.
#   Anything else confirms it cannot hold a Murabaha (see ../README.md, Finding 1).
#
# Responses are written to ./out/ so the run can be attached to the verification
# register. The token is never printed and never written to disk.
#
# Usage:
#   export TUUM_USERNAME='...' TUUM_PASSWORD='...'
#   ./oi-02-probe.sh
#
# Nothing here is secret except the two environment variables, and those must not
# be committed, pasted into a chat or an issue, or echoed. See CLAUDE.md §4.

set -euo pipefail

# -- Sandbox coordinates ------------------------------------------------------
# Per-module subdomains.
AUTH_HOST="${TUUM_AUTH_HOST:-https://auth-api.sandbox.tuumplatform.com}"
LOAN_HOST="${TUUM_LOAN_HOST:-https://loan-api.sandbox.tuumplatform.com}"

# -- Fill these in from your sandbox -----------------------------------------
PERSON_ID="${TUUM_PERSON_ID:-REPLACE_ME}"       # an existing legal person
TENANT_CODE="${TUUM_TENANT_CODE:-REPLACE_ME}"
COUNTRY_CODE="${TUUM_COUNTRY_CODE:-GB}"
PAYMENT_CHANNEL="${TUUM_PAYMENT_CHANNEL:-}"     # optional; leave empty to omit
CURRENCY="${TUUM_CURRENCY:-EUR}"

# The Murabaha shape: one payment at maturity, total = cost + profit.
#   cost 10,000 · profit 250 · total 10,250 · no rate supplied
COST="10000"
TOTAL="10250"
LOAN_PERIOD="1"
PAYMENT_DAY="1"

# Set after step 1 tells you what exists. Prefer a BULLET product.
LOAN_TYPE_CODE="${TUUM_LOAN_TYPE_CODE:-}"

# -----------------------------------------------------------------------------

OUT="$(dirname "$0")/out"
mkdir -p "$OUT"

if [[ "${TUUM_USERNAME:-}" == "" || "${TUUM_PASSWORD:-}" == "" ]]; then
  echo "set TUUM_USERNAME and TUUM_PASSWORD in the environment" >&2
  exit 1
fi

uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }

# Pretty-print a field from a saved response without needing jq.
field() {
  python3 - "$1" "$2" <<'PY'
import json, sys
path, key = sys.argv[1], sys.argv[2]
try:
    doc = json.load(open(path))
except Exception as exc:
    print(f"<unparseable: {exc}>"); raise SystemExit
def find(node):
    if isinstance(node, dict):
        if key in node: return node[key]
        for v in node.values():
            hit = find(v)
            if hit is not None: return hit
    elif isinstance(node, list):
        for v in node:
            hit = find(v)
            if hit is not None: return hit
    return None
value = find(doc)
print("null" if value is None else json.dumps(value))
PY
}

# -- Step 0: authenticate -----------------------------------------------------
echo "0. authenticating…"
TOKEN=$(curl -sS -X POST "$AUTH_HOST/api/v1/employees/authorise" \
  -H 'Content-Type: application/json' \
  --data-raw "$(python3 -c '
import json, os
print(json.dumps({"username": os.environ["TUUM_USERNAME"],
                  "password": os.environ["TUUM_PASSWORD"]}))')" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')

if [[ -z "$TOKEN" ]]; then echo "no token returned" >&2; exit 1; fi
echo "   token acquired (not printed)"

auth=(-H "x-auth-token: $TOKEN" -H 'x-channel-code: system' -H 'Content-Type: application/json')

# -- Step 1: what loan products exist? ---------------------------------------
echo "1. GET /api/v1/loan-products"
curl -sS "${auth[@]}" "$LOAN_HOST/api/v1/loan-products" -o "$OUT/1-loan-products.json"
python3 - "$OUT/1-loan-products.json" <<'PY'
import json, sys
doc = json.load(open(sys.argv[1]))
rows = doc.get("data", doc) if isinstance(doc, dict) else doc
rows = rows if isinstance(rows, list) else [rows]
for r in rows:
    if isinstance(r, dict):
        print("   ", r.get("loanTypeCode"), "|", r.get("name") or r.get("description"),
              "| schedule:", r.get("scheduleTypeCode") or r.get("repaymentScheduleCode"))
PY

if [[ -z "$LOAN_TYPE_CODE" ]]; then
  echo
  echo "   Pick a BULLET product from the list above, then re-run with:"
  echo "     export TUUM_LOAN_TYPE_CODE='<loanTypeCode>'"
  exit 0
fi

# -- Step 2: create an offer, supplying no rate ------------------------------
echo "2. POST /api/v3/persons/$PERSON_ID/offers   (loanTypeCode=$LOAN_TYPE_CODE, no rate supplied)"
OFFER_BODY=$(python3 - <<PY
import json, os
body = {
  "requestedMoney":       {"amount": "$COST",  "currencyCode": "$CURRENCY"},
  "offeredMoney":         {"amount": "$COST",  "currencyCode": "$CURRENCY"},
  "monthlyRepaymentMoney":{"amount": "$TOTAL", "currencyCode": "$CURRENCY"},
  "loanPeriod": $LOAN_PERIOD,
  "loanTypeCode": "$LOAN_TYPE_CODE",
  "paymentDay": $PAYMENT_DAY,
  "tenantCode": "$TENANT_CODE",
  "countryCode": "$COUNTRY_CODE",
}
if "$PAYMENT_CHANNEL":
    body["paymentChannelCode"] = "$PAYMENT_CHANNEL"
print(json.dumps(body, indent=2))
PY
)
echo "$OFFER_BODY" > "$OUT/2-offer-request.json"

curl -sS -X POST "$LOAN_HOST/api/v3/persons/$PERSON_ID/offers" \
  "${auth[@]}" -H "x-request-id: $(uuid)" \
  --data-raw "$OFFER_BODY" -o "$OUT/2-offer-response.json"

OFFER_ID=$(field "$OUT/2-offer-response.json" offerId | tr -d '"')
echo "   offerId: $OFFER_ID"
echo "   offer interestRate: $(field "$OUT/2-offer-response.json" interestRate)"

if [[ "$OFFER_ID" == "null" || -z "$OFFER_ID" ]]; then
  echo "   no offerId — see $OUT/2-offer-response.json for what the sandbox wants" >&2
  exit 1
fi

# -- Step 3: accept the offer, which creates the contract --------------------
echo "3. POST /api/v2/offers/$OFFER_ID/accept   (creates the contract)"
curl -sS -X POST "$LOAN_HOST/api/v2/offers/$OFFER_ID/accept" \
  "${auth[@]}" -H "x-request-id: $(uuid)" \
  -d '' -o "$OUT/3-accept-response.json"

CONTRACT_ID=$(field "$OUT/3-accept-response.json" contractId | tr -d '"')
VERSION_ID=$(field "$OUT/3-accept-response.json" activeVersionId | tr -d '"')

# -- Step 4: what got persisted against the contract? ------------------------
echo "4. GET /api/v1/versions/$VERSION_ID/components"
curl -sS "${auth[@]}" "$LOAN_HOST/api/v1/versions/$VERSION_ID/components" \
  -o "$OUT/4-components.json" || true
curl -sS "${auth[@]}" "$LOAN_HOST/api/v1/contracts/$CONTRACT_ID/interests" \
  -o "$OUT/4-interests.json" || true

# -- Verdict ------------------------------------------------------------------
echo
echo "════════════════════════════════════════════════════════════════"
echo " contractId          : $CONTRACT_ID"
echo " on accept response  : rate=$(field "$OUT/3-accept-response.json" interestRate)  annualised=$(field "$OUT/3-accept-response.json" apr)"
echo " on contract record  : rate=$(field "$OUT/4-components.json" interestRate)"
echo "════════════════════════════════════════════════════════════════"
echo
echo " Both null on a BULLET product  → the Loan module is back in play."
echo " Either populated               → it cannot hold a Murabaha (Finding 1)."
echo
echo " Responses saved to $OUT/ — safe to share, no token inside."
echo
echo " Optional, if you have the appetite (Findings 2 and 5):"
echo "   • force a day change, then re-read"
echo "     GET  $LOAN_HOST/api/v1/contracts/$CONTRACT_ID/accrued-interest"
echo "   • try  POST $LOAN_HOST/api/v1/contracts/$CONTRACT_ID/top-up"
echo "     and see whether product configuration refuses it"
