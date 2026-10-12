# SADAD — bill presentment and collection

**Port:** `core/ports/bill-collection.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-SADAD-01 — the institution’s biller registration and the reconciliation feed format.

## Demonstration and assumed contract

**Source: none published** — SADAD's biller interfaces are released at biller onboarding.
Two public pieces are used: the bill addressing of the SAMA Open Banking Framework,
`BillDetails{BillerID, BillNumber}` (`https://openbanking.sama.gov.sa`), and the bill
lifecycle SADAD publishes (`https://www.sadad.com`, FAQ): **presented** (uploaded by the
biller), **paid** (by the customer through any bank channel), **settled** (credited to the
biller), with end-of-day reconciliation. Row "SADAD" in `docs/rails/public-structures.md`.

What the adapter now speaks:

- Present: `POST /v1/bills` with `{BillDetails{BillerID, BillNumber}, payerRef,
  Amount{Amount, Currency}, DueDate, idempotencyKey}`; the biller id is the tenant's
  configuration (constructor argument), never a request field. Answer `{BillDetails,
  Status: PRESENTED, PresentedDateTime}`; the bill reference is `BillerID-BillNumber`. SAR
  and positive only.
- Reconcile: `GET /v1/bills/reconciliation?fromDateTime=…` answered by `Data.Bill[]
  {BillDetails, Status, PaidAmount{Amount, Currency}, PaymentDateTime, SadadPaymentId,
  SettlementReference}`. `PAID` and `SETTLED` bills are reconciled (settlement reference,
  else SADAD's payment id); `PRESENTED`/`EXPIRED` are skipped; one line that does not read,
  or another biller's bill, refuses the batch.

**Unconfirmed, and the verification item:** every field name and path, the status
vocabulary beyond the public lifecycle, and the reconciliation file's real format.

The demonstration's reconciliation file is issued under `DEMO_SADAD_BILLER_ID`; a bill
number containing `reject` is not presented.

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
