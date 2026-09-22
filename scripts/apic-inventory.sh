#!/bin/sh
# What we need to know about an API Connect instance before publishing to it.
#
# Read-only. Runs a series of `apic` list commands and writes the results to
# `apic-inventory.txt`, which you can read before sharing.
#
# It captures NAMES and VERSIONS, never credentials. It deliberately does not
# run `apic config` or read the toolkit credentials file, because both contain
# secrets. If you share the output, read it first — the rule is the same as
# everywhere else in this repository: no credential leaves the machine it was
# issued to.
#
# Command flags differ between API Connect versions, so every call is allowed
# to fail without stopping the rest. A failure is information too: it tells us
# which command set this version has.
#
# Usage:
#   export APIC_SERVER=api.ap-south-a.apiconnect.ibmappdomain.cloud
#   export APIC_ORG=iota-api-dev
#   sh scripts/apic-inventory.sh

set -u

SERVER="${APIC_SERVER:?set APIC_SERVER to the management endpoint host}"
ORG="${APIC_ORG:-}"
OUT="apic-inventory.txt"

run() {
  printf '\n=== %s ===\n' "$*" >> "$OUT"
  # shellcheck disable=SC2068
  $@ >> "$OUT" 2>&1 || printf '(command unavailable or failed — this is useful to know)\n' >> "$OUT"
}

: > "$OUT"
printf 'API Connect inventory — %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" >> "$OUT"
printf 'server: %s\norg: %s\n' "$SERVER" "${ORG:-<unset>}" >> "$OUT"

# 1. Toolkit version. Tells us which command set and which OpenAPI versions.
run apic version
run apic --version

# 2. Are we logged in, and as whom. No token is printed by these.
run apic me:get --server "$SERVER"

# 3. Provider organisations visible to this identity.
run apic orgs:list --my --server "$SERVER"

# 4. Catalogs — the publish target.
if [ -n "$ORG" ]; then
  run apic catalogs:list --server "$SERVER" --org "$ORG"
fi

# 5. Gateway services. THE important one: "DataPower API Gateway" and
#    "DataPower Gateway (v5 compatible)" have different policy sets, so the
#    assembly we write differs.
run apic gateway-services:list --server "$SERVER" --availability-zone availability-zone-default
if [ -n "$ORG" ]; then
  run apic gateway-services:list --server "$SERVER" --org "$ORG"
fi

# 6. Availability zones, in case the default is not what this instance uses.
run apic availability-zones:list --server "$SERVER"

# 7. Which command groups exist at all. Differs by version, and tells us more
#    about the version than the version string sometimes does.
run apic --help

printf '\n=== done ===\n' >> "$OUT"
printf 'Written to %s. Read it before sharing.\n' "$OUT"
