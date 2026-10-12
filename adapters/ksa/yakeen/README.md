# Yakeen — identity attribute verification

**Port:** `core/ports/identity-verification.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-YAKEEN-01 — which attributes the institution’s subscription returns, and the consent evidence the provider expects to be referenced.

## Demonstration and assumed contract

**Source: none published.** Elm's product page (`https://www.elm.sa`) describes Yakeen; the
public UAPI listing SP014 names the attributes returned; operation names
(`CitizenInfo`, `AlienInfoByIqama`, …) come from leaked integration code and are
**unconfirmed**. Row "Yakeen" in `docs/rails/public-structures.md`.

What the adapter now speaks: `POST /yakeen/v1/person-info` with `{applicantRef, consentRef}`
(the egress resolves the reference to the identifier and declared date of birth, and picks
`CitizenInfo` for a national ID or `AlienInfoByIqama` for an iqama by the identifier's
leading digit). The answer is either

- `{logId, operation, personInfo{firstName, fatherName, grandFatherName, familyName,
  englishFirstName, englishSecondName, englishThirdName, englishLastName, gender,
  dateOfBirthH, dateOfBirthG, nationalityCode, idExpiryDateH}}` — a match; the adapter
  checks the core attributes are present and **drops every value**; or
- `{logId, error{code, message}}` — `DATE_OF_BIRTH_MISMATCH` → mismatch `dateOfBirth`,
  `ID_EXPIRED` → `idExpiry`, `ID_NOT_ACTIVE` → `idStatus`, `NOT_FOUND` → `REFUSED NOT_FOUND`;
  any other code is `UNAVAILABLE`, never a match.

Only `verified`, the mismatched attribute names and `logId` (as `verificationRef`) cross.
An HTTP 404 is `REFUSED NOT_FOUND`.

**Unconfirmed, and the verification item:** the REST rendering of the service, every field
name above, the error codes (assumed names), and whether `logId` is the reference to keep.

The demonstration transport answers with the cast's synthetic attributes; a reference
containing `mismatch`, `expired-id` or `unknown` steers the failure.

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
