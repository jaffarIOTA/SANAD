# NER — National Economic Register

**Port:** `core/ports/business-registry.ts`. **Vault provider:** `NER`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-NER-01** — what only a sandbox call can answer:

- whether a lookup needs the issuing authority (each emirate's economic
  department, each free zone) beside the licence number, and the licence number
  formats per authority;
- coverage of free-zone licences in the register;
- the licence status vocabulary (the adapter maps ACTIVE, EXPIRED, SUSPENDED,
  FROZEN, CANCELLED, REVOKED; anything else is malformed);
- the legal-form vocabulary and the activity classification codes returned;
- whether share capital is returned, and in which currency.

## What is settled without the sandbox

- The trade licence number travels in the port's `commercialRegistration`
  field (naming debt, ADR 0005). The adapter checks shape only: 3–30 letters,
  digits, hyphens or slashes.
- An unknown licence (HTTP 404) is `REFUSED` with `NOT_FOUND`.
- Owners' and managers' Emirates ID or passport numbers are dropped at this
  boundary; they become opaque signatory references.
- Share capital becomes AED minor units without a float; capital in another
  currency is left out rather than relabelled.
