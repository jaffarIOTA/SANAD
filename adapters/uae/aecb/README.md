# AECB — Al Etihad Credit Bureau

**Port:** `core/ports/credit-bureau.ts`. **Vault provider:** `AECB`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (through the institution's egress) has made a verified sandbox
call and the findings are written here.

## Verification item

**UAE-RAIL-AECB-01** — what only a sandbox call can answer:

- the commercial report's key: trade licence number alone, or licence number
  plus issuing authority (emirate / free zone), and how a licence shared across
  branches is resolved;
- the consent artefact the bureau expects for a commercial and an individual
  enquiry, and its reference format;
- the enquiry purpose codes for a new SME facility;
- the score scale and whether a "no hit" is an answer or an HTTP status;
- the data-contribution (reporting) channel and cadence for a new facility and
  its changes — API or periodic file — and the acknowledgement it returns.

## What is settled without the sandbox

- `request()` is the commercial report; `requestIndividual()` (adapter method,
  not on the port) is the owner's or guarantor's individual report, keyed by an
  applicant reference. The Emirates ID never crosses the port.
- No consent id, no call (`CONSENT_MISSING`), tested.
- Unreachable or refusing bureau → `UNAVAILABLE`, routed to the bureau-
  unavailable exception; never a decline and never a pass.
- Amounts are AED minor units without a float; a report in another currency, or
  with one unreadable default, is refused whole.
- `report()` refuses a facility event not in AED and carries the outbox
  idempotency key.

## Deviations

See `AECB_DEVIATIONS` in `adapter.ts` (trade licence in the
`commercialRegistration` field; no subject type on the port; opaque score).
