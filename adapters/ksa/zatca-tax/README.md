# ZATCA — tax certificate status

**Port:** `core/ports/tax-compliance.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-ZATCA-02 — the certificate status vocabulary and whether status is queryable by CR without the taxpayer’s own session.

## Demonstration and assumed contract

**Source: none published as an API.** ZATCA's zakat / tax certificate inquiry is a web
e-service (`https://zatca.gov.sa`), searched by commercial registration or TIN; its screen
shows the certificate number, type, status, issue and expiry dates and the taxpayer. Row
"ZATCA Fatoora" (zakat certificate note) in `docs/rails/public-structures.md`.

What the adapter now speaks: `GET /zatca/v1/zakat-certificates?crNumber={cr}` answered by
`{certificateNumber, certificateType, status, issueDate, expiryDate, taxpayer{crNumber,
nameAr}}`.

- `status` by **own-key** lookup: `VALID`/`ACTIVE` → `VALID`, `EXPIRED`,
  `SUSPENDED`/`REVOKED`/`CANCELLED` → `SUSPENDED`. Anything else — including
  `constructor`, which a plain index once resolved to `Object.prototype.constructor` — is
  `UNAVAILABLE`, never `VALID`.
- A `VALID` certificate whose `expiryDate` has passed is `EXPIRED`. A certificate for
  another CR is not understood. A 404 is the port's `NOT_FOUND` status.

**Unconfirmed, and the verification item:** whether any API (or the Wathq / ZATCA partner
route) exposes this to a financier, every field name, and the status vocabulary.

The demonstration answers the cast's certificates (company 2's has expired); a CR ending
`7777` is expired, `0000` has none.

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
