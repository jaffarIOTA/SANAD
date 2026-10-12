# AECB — Al Etihad Credit Bureau

**Port:** `core/ports/credit-bureau.ts`. **Vault provider:** `AECB`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (through the institution's egress) has made a verified sandbox
call and the findings are written here.

## Verification item

**UAE-RAIL-AECB-01** — what only a sandbox call can answer:

- the real report schema (everything below is an assumed contract);
- the commercial report's key: trade licence number alone, or licence number
  plus issuing authority (emirate / free zone), and how a licence shared across
  branches is resolved;
- the consent artefact the bureau expects for a commercial and an individual
  enquiry, and its reference format;
- the enquiry purpose codes for a new SME facility;
- whether a "no hit" is an answer or an HTTP status;
- the contract status and role vocabularies;
- the data-contribution (reporting) channel and cadence for a new facility and
  its changes — API or periodic file — and the acknowledgement it returns.

## Demonstration and assumed contract

The bureau publishes no schema (member access only). What it does publish is
the score scale — **300 to 900, higher meaning lower risk**, for individuals and
companies — and that a report carries payment history, credit contracts, court
obligations and bounced cheques (u.ae, "financial credibility";
<https://aecb.gov.ae/>). The assumed contract arranges those contents in the
**layout common to international credit-bureau reports** (report block, subject
block, score block with band and reason codes, contracts with type / role /
status / limit / outstanding / overdue / days past due and a monthly payment
history, enquiries, public records):

```
POST /v1/reports/commercial  { tradeLicenceNumber, consentRef, purpose }
POST /v1/reports/individual  { applicantRef, consentRef, purpose }
→ { report:   { reference, generated_at, product, subject_found },
    subject:  { … }                                             ← dropped whole
    score:    { value, range_min: 300, range_max: 900, band, reason_codes[] },
    contracts: [{ contract_ref, type, role: PRIMARY|JOINT|GUARANTOR,
                  status: ACTIVE|RESTRUCTURED|DEFAULTED|WRITTEN_OFF|CLOSED|SETTLED,
                  credit_limit, outstanding_balance, overdue_amount: {amount, currency},
                  days_past_due, payment_history: [{ period: YYYY-MM, days_past_due }] }],
    enquiries: [ … ],
    public_records: { court_cases: [ … ], bounced_cheques: [{ cheque_date, amount, settled }] } }
```

**These field names are not AECB's published specification**; they remain the
verification item. The demonstration transport answers in this shape from the
synthetic cast, or: a licence starting `UNK-` has no file, `DEF-` has a
written-off facility and an unpaid bounced cheque (score 412); an individual
reference containing `nohit` has no file, `default` a defaulted personal loan.

## What is settled without the sandbox

- `request()` is the commercial report; `requestIndividual()` (adapter method,
  not on the port) is the owner's or guarantor's individual report, keyed by an
  applicant reference. The Emirates ID never crosses the port.
- No consent id, no call (`CONSENT_MISSING`), tested.
- Unreachable or refusing bureau → `UNAVAILABLE`, routed to the bureau-
  unavailable exception; never a decline and never a pass.
- The reduction (`AECB-DEV-004`): exposure, overdue and the active count are
  over open contracts where the subject is the borrower (a guarantee is
  contingent); worst days past due includes the payment history; defaults are
  defaulted or written-off contracts and bounced cheques. Band, reason codes,
  enquiries and court cases do not cross the port.
- A score outside 300–900, or a report stating another scale, is malformed.
- Amounts are AED minor units without a float; a report in another currency, or
  with one unreadable line, is refused whole.
- `report()` refuses a facility event not in AED and carries the outbox
  idempotency key.

## Deviations

See `AECB_DEVIATIONS` in `adapter.ts`.
