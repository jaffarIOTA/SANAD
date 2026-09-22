#!/bin/sh
# Publish the gateway definitions to API Connect.
#
# This is the whole of "adding our APIs". There is no import, no UI step and
# no GitHub connection — the repository is authoritative and this pushes it.
# CI runs the same sequence on merge (`.github/workflows/gateway.yml`); this
# script exists so the first run can be done by hand and watched.
#
# The API key is read from the environment and never printed. Do not put it in
# a file in this repository — the pre-commit hook will refuse the commit, and
# it is right to.
#
# Usage:
#   export APIC_API_KEY='...'        # from API Manager, not stored anywhere
#   sh scripts/apic-publish.sh
#
# Override any of these if the instance differs:
#   APIC_SERVER   APIC_REALM   APIC_ORG   APIC_CATALOG

set -eu

SERVER="${APIC_SERVER:-api.ap-south-a.apiconnect.ibmappdomain.cloud}"
REALM="${APIC_REALM:-provider/ibm-verify}"
ORG="${APIC_ORG:-iota-api-dev}"
CATALOG="${APIC_CATALOG:-sandbox}"

command -v apic >/dev/null 2>&1 || {
  echo "apic is not on PATH. See scripts/install-apic.sh" >&2
  exit 1
}

# -- 0. Is the instance answering at all? -------------------------------------
#
# Checked first and deliberately. The platform API has been returning
# "Plan limit reached" on every path including unauthenticated ones, and the
# toolkit reports that as an empty `Error:` — which reads exactly like a bad
# credential and sends people to rotate keys that were never the problem.
echo "checking the platform API..."
probe="$(curl -sS --max-time 15 "https://${SERVER}/api/cloud" 2>/dev/null || true)"
case "$probe" in
  *"Plan limit reached"*)
    cat >&2 <<'MSG'

The platform API is refusing every request:

    403 {"Error":"Plan limit reached"}

This is not authentication and not the toolkit. It happens before any
credential is considered — an unauthenticated request gets the same answer.

  - IBM Cloud -> Resource list -> your API Connect instance -> Plan / Usage.
  - The API Manager UI works while this does not; they take different paths,
    so the instance is not broken. That makes it a precise support ticket:
    "platform API returns 403 Plan limit reached on all paths including
    unauthenticated; API Manager UI functions normally."

Nothing can be published until this clears.
MSG
    exit 1
    ;;
esac

# -- 1. Regenerate, so what is published matches the contract -----------------
echo "regenerating the API Connect artefact from the contract..."
node scripts/build-apic-definition.mjs

echo "validating..."
for file in gateway/ibm/*-product_*.yaml; do
  apic validate "$file"
done

# -- 2. Log in ----------------------------------------------------------------
#
# `--apiKey` rather than `--sso`: IBM Verify is OIDC and browser-based, which
# is fine at a desk and impossible in CI. Using the same path in both keeps
# this script and the pipeline honest about each other.
: "${APIC_API_KEY:?set APIC_API_KEY (from API Manager). Do not put it in a file.}"

echo "logging in to ${SERVER} as ${REALM}..."
apic login --server "$SERVER" --realm "$REALM" --apiKey "$APIC_API_KEY" >/dev/null

# -- 3. Publish ---------------------------------------------------------------
#
# Health first. It has no dependency on the origination service, so if it
# publishes and origination does not, the problem is the origination
# definition rather than the pipeline.
for product in health origination; do
  file="gateway/ibm/${product}-product_1.0.0.yaml"
  echo "publishing ${product}..."
  apic products:publish \
    --server "$SERVER" \
    --org "$ORG" \
    --catalog "$CATALOG" \
    --scope catalog \
    "$file"
done

echo
echo "published to ${ORG}/${CATALOG}:"
apic products:list --server "$SERVER" --org "$ORG" --catalog "$CATALOG" --scope catalog || true

apic logout --server "$SERVER" >/dev/null 2>&1 || true
echo "done."
