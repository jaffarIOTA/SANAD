# Rate publisher — benchmarks and market APRs

**Port:** `core/ports/rate-publisher.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-RATEPUB-01 — the publisher’s API, its precision (this adapter refuses more than two decimals of a percent), and its publication cadence.

## What is settled without the sandbox

- The port shape and outcomes (`ANSWERED` / `REFUSED` / `UNAVAILABLE`), tested in
  `test/adapters/ksa-rails.test.ts`.
- Consent gating where the rail is consent-gated: the adapter refuses before any
  call is made when no consent id is supplied.
- No personal identifier by value crosses the port; vendor decimals become minor
  units by digit manipulation, never through a float.
- Known deviations are declared in `adapter.ts` with their containment.

## Credentials

Stored via `config.set_integration_credential()` under the provider name in
migration 0007; read server-side at adapter construction; never logged.
