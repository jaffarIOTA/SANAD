# SIMAH — credit bureau (primary)

**Port:** `core/ports/credit-bureau.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-SIMAH-01 — the enquiry purpose codes, the consent reference format, and the reporting file/API cadence for new facilities.

## Demonstration and assumed contract

**Source: none published** — SIMAH releases schemas after membership. Public product names
come from `https://www.simah.com`: the consumer credit report, the commercial credit report
(SIMAT), and the TAQEEM and MOLIM scores. The **layout** is a named analogue: the report
layout credit bureaus share internationally. Row "SIMAH" in
`docs/rails/public-structures.md`.

What the adapter now speaks (`adapters/ksa/kernel/bureau-report.ts`, shared with Bayan):

- Enquiry: `POST /v1/reports` with `{product: 'SIMAT_COMMERCIAL_REPORT', enquiryPurpose,
  subject{crNumber, memberReference}, consentReference}`.
- Report: `reportId`; `subject{found}` (`false` → `NO_RECORD`); `score{value, model,
  reasonCodes[]}`; `facilities[]{facilityType, status, creditLimit, outstandingBalance,
  overdueAmount, daysPastDue, currency, paymentHistory}`; `enquiries[]`;
  `defaults[]{amount, settled, defaultDate, currency}`; `judgments[]`.
- Mapped: exposure = outstanding of open facilities (`ACTIVE`, `DELINQUENT`); overdue = all
  overdue; worst delinquency = highest `daysPastDue`; active = open facilities; defaults
  as listed. One facility, default or score block that does not read exactly makes the
  report `UNAVAILABLE` (AECB parity) — never a report without that line.
- **The score range is not public.** The score is the bureau's opaque integer; nothing here
  bounds or scales it (figures such as 300–850 seen online are unreliable).
- Reporting stays an outbox-driven acknowledgement: `POST /v1/facility-events` with the
  amount as a decimal string, answered by `acknowledgementId`.

**Unconfirmed, and the verification item:** every field name, the product and purpose
codes, which score belongs to which product, the facility status vocabulary, and the
reporting (data-furnishing) format. Judgments and enquiries are read by no port field yet.

The demonstration answers the cast's commercial and consumer files; a CR starting `DEF`
carries a default, a CR ending `0000` has no file.

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
