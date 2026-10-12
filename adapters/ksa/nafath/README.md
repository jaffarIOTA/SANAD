# Nafath — national digital identity

**Port:** `core/ports/identity-authentication.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-NAFATH-01 — the request/callback shape of the authentication flow and how the assertion is retrieved (push notification vs. polling); whether the assertion can anchor an e-signature intent.

## Demonstration and assumed contract

**Source: third-party published** (no official specification is public). Azakaw's Nafath
wrapper and the Laravel/Packagist integrations describe Elm's multi-factor flow at
`https://nafath.api.elm.sa/api/v1/mfa/request` and `/api/v1/mfa/request/status`. Row
"Nafath" in `docs/rails/public-structures.md`.

What the adapter now speaks:

| Step | Request | Answer read |
|---|---|---|
| start (`identity.start`) | `POST /api/v1/mfa/request?local=ar&requestId={correlationId}` with `{applicantRef, service}` (the egress resolves the reference to the national identifier) | `transId`, `random` (the number the person picks in the app). The transaction lives **200 seconds**; `expiresAtEpochSeconds` is start + 200. |
| status (`identity.confirm`) | `POST /api/v1/mfa/request/status` with `{transId, random}` | `status` ∈ `WAITING` · `COMPLETED` · `REJECTED` · `EXPIRED` · `ERROR`; on `COMPLETED`, `transId` and `iat` of the verified callback token |

- The port's transaction reference is `transId:random` (NAFATH-DEV-002).
- `WAITING`, `REJECTED`, `EXPIRED`, `ERROR` are `REFUSED` with `STATUS_<status>`; any other
  status (own-key lookup) is `UNAVAILABLE`. A completed status for another `transId` is
  not understood.
- The completed `transId` is the assertion: once, fresh, for this tenant (SR-007,
  `test/compliance/assertion-replay.test.ts`). `identityRef` is `nafath:{transId}`; the
  national identifier in the callback claims is dropped here.

**Unconfirmed, and the verification item:** the `service` values, the request body
field for the identifier, whether status polling or only the signed JWT callback carries
completion, the callback's claim names (`iat` assumed), and how the random number reaches
the applicant's screen (the port has no field for it — a recommended port extension).

The demonstration transport (`adapters/ksa/demonstration/transport.ts`) answers both
calls; an applicant reference containing `reject`, `expire` or `wait` steers the status.

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
