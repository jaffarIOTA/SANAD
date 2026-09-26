# Wathq — business registry

**Port:** `core/ports/counterparty-registry.ts` (the registry half). **Status:** `BLOCKED` — fixture transport only.

## Verification item

KSA-RAIL-WATHQ-01 — the subscription scope (which CR attributes are returned), the
status vocabulary, and the rate limits. Also the decision to split the port into
`business-registry` and `counterparty-master` (WATHQ-DEV-001).

## What is settled without the sandbox

- A ten-digit CR is required before any call; a 404 is "unknown", not an error.
- Signatory national identifiers are dropped at the boundary (WATHQ-DEV-002).
- `get()` and `beginOnboarding()` are typed refusals, not silent no-ops.
