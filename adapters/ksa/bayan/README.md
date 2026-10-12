# Bayan — credit bureau (secondary)

**Port:** `core/ports/credit-bureau.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-BAYAN-01 — the same items as SIMAH; the tenant chooses primary and fallback by configuration.

## Demonstration and assumed contract

**Source: none published.** Bayan Credit Bureau's public pages describe commercial credit
reports for businesses; no schema is public, so no schema URL is cited. The layout is the
same named analogue as SIMAH — the international credit-bureau report layout — mapped by
the shared `adapters/ksa/kernel/bureau-report.ts`. Row "Bayan" in
`docs/rails/public-structures.md`.

- Enquiry: `POST /v1/credit-reports` with `{product: 'COMMERCIAL_CREDIT_REPORT',
  enquiryPurpose, subject{crNumber, memberReference}, consentReference}`.
- Report fields, mapping and fail-closed rules: as SIMAH's README. The score is an opaque
  integer with **no published range**.
- Reporting: `POST /v1/facility-events`, decimal amount, `acknowledgementId`.

Bayan has its own mapping tests in `test/adapters/ksa-rails.test.ts`.

**Unconfirmed, and the verification item:** every field name, the product code, and
whether Bayan's layout differs from SIMAH's at all.

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
