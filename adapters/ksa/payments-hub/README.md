# Payments hub — disbursement and collection

**Port:** `core/ports/payments.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-PAYHUB-01 — the institution’s hub API, purpose codes, and the idempotency semantics it honours.

## Demonstration and assumed contract

**Source: a named public analogue** — each institution's hub is its own. SARIE and the Saudi
instant payment system are ISO 20022 rails, so the answer is modelled on the payment status
report **pacs.002** and the ISO 20022 external code sets
(`https://www.iso20022.org/catalogue-messages/additional-content-messages/external-code-sets`).

What the adapter now speaks:

- Instruction: `POST /v1/credit-transfers` (disburse) or `/v1/direct-debits` (collect) with
  `{EndToEndId, InstrId (= idempotency key), IntrBkSttlmAmt{Amount, Ccy}, Purp{Cd},
  creditorRef | debtorRef}`. **Guard:** SAR and strictly positive, refused before any call
  (`CURRENCY_MISMATCH`, `AMOUNT_NOT_POSITIVE`), like the UAE partner-bank adapter.
- Answer: `{OrgnlEndToEndId, TxId, TxSts, AccptncDtTm, StsRsnInf{Rsn{Cd}}, RtrInf}`.
  `TxSts` by own-key lookup: `ACSC` → `SETTLED`; `ACSP`, `ACCP`, `ACTC`, `ACWC`, `PDNG` →
  `ACCEPTED`; `RJCT` → `REJECTED` (reason codes such as `AC04` closed account, `AM04`
  insufficient funds). A collection carrying `RtrInf` (a pacs.004 return) is `RETURNED`.
  An unknown status, or an end-to-end id that is not ours, is `UNAVAILABLE`.

**Unconfirmed, and the verification item:** the hub's JSON rendering of these messages,
paths, and purpose codes. The rejection reason code is not carried by the port (a
recommended port extension).

The demonstration steers by reference: `reject` → RJCT/AC04, `insufficient` → RJCT/AM04,
`pending` → PDNG, `return` (collection) → returned.

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
