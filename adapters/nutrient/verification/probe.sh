#!/usr/bin/env bash
# V-02 and V-03 — Document Engine answers, and a document round-trips.
#
# Reads the credentials from the environment under the derived names; never
# prints them. Run from a developer machine or the in-Kingdom host, never from
# a browser. Confirm the endpoint paths and the authorization header form
# against the vendor's current Document Engine API reference before relying on
# this script — they are recorded here as the assumption being tested.
#
#   usage: probe.sh <synthetic.pdf>
set -euo pipefail
PDF="${1:?synthetic PDF path}"
BASE="${SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_BASE_URL:?}"
TOKEN="${SANAD_CREDENTIAL_DOCUMENT_PLATFORM_SANDBOX_DOCUMENT_ENGINE_API_TOKEN:?}"
AUTH="Authorization: Token token=${TOKEN}"
OUT="$(mktemp -d)"

echo "V-02 healthcheck"
curl -sS -o /dev/null -w '  HTTP %{http_code}\n' "${BASE}/healthcheck"

echo "V-02 authenticated listing"
curl -sS -o /dev/null -w '  HTTP %{http_code}\n' -H "${AUTH}" "${BASE}/api/documents"

echo "V-03 upload"
UP_HASH="$(shasum -a 256 "${PDF}" | cut -d' ' -f1)"
DOC_ID="$(curl -sS -H "${AUTH}" -F "file=@${PDF}" "${BASE}/api/documents" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["document_id"])')"
echo "  document_id ${DOC_ID}"

echo "V-03 fetch rendition and compare"
curl -sS -H "${AUTH}" -o "${OUT}/back.pdf" "${BASE}/api/documents/${DOC_ID}/pdf"
BACK_HASH="$(shasum -a 256 "${OUT}/back.pdf" | cut -d' ' -f1)"
if [ "${UP_HASH}" = "${BACK_HASH}" ]; then echo "  identical: yes"; else echo "  identical: NO — record this; the engine re-wrote the file"; fi
rm -rf "${OUT}"
