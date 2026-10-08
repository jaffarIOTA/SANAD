# MOHRE — WPS salary report

**Port:** `core/ports/employment-verification.ts`. **Vault provider:** `MOHRE`. **Status:** `BLOCKED` — fixture transport only.

The Ministry of Human Resources and Emiratisation; the Wage Protection System.
A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-MOHRE-01** — what only a sandbox call can answer:

- the access route open to a lender (direct ministry service, a WPS agent
  bank's salary certificate, or a licensed intermediary) and the consent it
  requires;
- the report shape: how many months, paid versus contracted salary, and how
  allowances are separated;
- coverage of free-zone employers, which are outside the ministry's WPS;
- the employment status vocabulary.

## What is settled without the sandbox

- Consent-gated: no consent id, no call (`CONSENT_MISSING`).
- The port's registered salary is the most recent WPS month's paid amount, in
  AED minor units, stored with the report reference. A month that cannot be
  read refuses the whole report rather than being skipped. How a tenant's
  affordability policy uses the figure is credit policy, not this adapter's.
- The establishment is mapped as an opaque reference; labour card and person
  numbers are dropped.
