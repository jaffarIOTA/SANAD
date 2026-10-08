# FTA — Federal Tax Authority

**Port:** `core/ports/tax-compliance.ts`. **Vault provider:** `FTA`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-FTA-01** — what only a sandbox call can answer:

- whether the authority offers a lender-facing registration or certificate
  status service at all, or only the public TRN verification, and what it
  returns (registration status, tax residency certificate, corporate tax
  registration as distinct from VAT);
- whether a lookup by trade licence is possible or only by TRN;
- the status vocabulary.

## What is settled without the sandbox

- The port field `crNumber` carries a fifteen-digit TRN, or otherwise a trade
  licence number (naming debt, ADR 0005). Anything else is refused before the
  call.
- Status maps to `VALID` / `EXPIRED` / `NOT_FOUND` / `SUSPENDED`; an unknown
  status is `UNAVAILABLE`, never `VALID`. A bare 404 is `REFUSED` with
  `NOT_FOUND`.
- A business below the VAT registration threshold need not be registered, so
  `NOT_FOUND` is not by itself non-compliance. Whether it matters is the
  tenant's credit policy; this adapter encodes no threshold. Any threshold a
  policy uses must cite the Federal Decree-Law and article it comes from.
