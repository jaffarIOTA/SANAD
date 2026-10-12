# FTA — Federal Tax Authority

**Port:** `core/ports/tax-compliance.ts`. **Vault provider:** `FTA`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-FTA-01** — what only a sandbox call can answer:

- whether the authority offers a lender-facing registration or certificate
  status service at all, or only the public (CAPTCHA) TRN verification, and
  what it returns (registration status, tax residency certificate, corporate
  tax registration as distinct from VAT);
- the real field names (everything below is an assumed contract);
- whether a lookup by trade licence is possible or only by TRN;
- the status vocabulary.

## Demonstration and assumed contract

The authority publishes no API; tax.gov.ae offers a TRN check that returns the
legal name (English and Arabic) for a valid fifteen-digit TRN and "does not
exist" otherwise. The assumed contract is modelled on the **European
Commission's VIES VAT-number validation REST service** —
<https://ec.europa.eu/taxation_customs/vies/> — the best-known public
registration check:

```
GET /v1/vat-registrations/{trn}          (fifteen digits, as the FTA publishes)
GET /v1/vat-registrations?licence={no}
→ { isValid, requestDate (ISO 8601), userError, vatNumber, name, nameAr, address, requestIdentifier }
```

`userError` takes the VIES values (`VALID`, `INVALID`, `INVALID_INPUT`,
`SERVICE_UNAVAILABLE`, `MS_UNAVAILABLE`, `TIMEOUT`, `*_MAX_CONCURRENT_REQ`,
`VAT_BLOCKED`, `IP_BLOCKED`) plus two the FTA needs and VIES lacks:
`SUSPENDED`, `DEREGISTERED`.

**These field names are not the FTA's published specification** (there is
none); they remain the verification item. The demonstration answers cast TRNs
and licences as registered; a licence starting `UNK-` or a TRN starting `9` is
not registered; `DEREG-` is deregistered.

## What is settled without the sandbox

- The port field `crNumber` carries a fifteen-digit TRN, or otherwise a trade
  licence number (naming debt, ADR 0005). Anything else is refused before the
  call.
- `VALID` → `VALID`; `INVALID` → `NOT_FOUND`; `DEREGISTERED` → `EXPIRED`;
  `SUSPENDED` → `SUSPENDED`; a service-side outcome → `UNAVAILABLE`; an input
  or blocking outcome → `REFUSED`. `isValid` contradicting the outcome, an
  answer for another TRN, or an unknown outcome is malformed. A bare 404 is
  `REFUSED` with `NOT_FOUND`.
- The consultation number (`requestIdentifier`) becomes `certificateRef`. The
  legal name and address are dropped (the port has no field; see
  `FTA-DEV-003`).
- A business below the VAT registration threshold need not be registered, so
  `NOT_FOUND` is not by itself non-compliance. Whether it matters is the
  tenant's credit policy; this adapter encodes no threshold. Any threshold a
  policy uses must cite the Federal Decree-Law and article it comes from.
