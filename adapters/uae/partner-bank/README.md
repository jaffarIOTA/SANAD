# Partner bank — payments

**Port:** `core/ports/payments.ts`. **Vault provider:** `PARTNER_BANK`. **Status:** `BLOCKED` — fixture transport only.

A development fund disburses and collects through the bank it contracts; it
holds no settlement account of its own on the domestic payment systems. The
bank chooses the rail (instant payment, the federal transfer system, internal
book transfer); the port never names one.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-PARTNER-BANK-01** — what only a sandbox call can answer:

- the bank's corporate payments API (or host-to-host file) and its
  authentication: API key, mutual TLS, or signed payloads;
- whether it speaks ISO 20022 JSON as assumed below, XML, or its own shape;
- which payment purpose codes the bank accepts for a loan disbursement and for
  an instalment collection;
- how collection works: direct debit mandate, standing instruction, or sweep
  from an account held at the bank, and how returns are reported;
- whether the bank honours the idempotency key across retries, and for how
  long.

## Demonstration and assumed contract

Modelled on **ISO 20022** — <https://www.iso20022.org/> — the message standard
of the UAE's payment systems and of most corporate banking APIs:

```
POST /v1/payments/credit-transfers   (pain.001-style)
  { PmtId: { InstrId: <idempotency key>, EndToEndId: <reference> },
    InstdAmt: { Ccy: "AED", Amt: "500000.00" }, Cdtr: { Ref }, Purp: { Cd } }
POST /v1/payments/direct-debits      { PmtId, InstdAmt, Dbtr: { Ref } }
→ pain.002 / pacs.002-style status report
  { GrpHdr, TxInfAndSts: { OrgnlInstrId, OrgnlEndToEndId, TxSts, StsRsnInf: { Rsn: { Cd } },
                           AccptncDtTm, AcctSvcrRef, RtrInf?: { RtrRsn: { Cd } } } }
```

`TxSts` is the ExternalPaymentTransactionStatus1Code list: `ACSC` → `SETTLED`;
`RJCT` (with a reason code such as `AC04`, `AM04`) → `REJECTED`; `RCVD`,
`PDNG`, `ACTC`, `ACCP`, `ACSP`, `ACWC` → `ACCEPTED`. Return information
(pacs.004 style) on a collection → `RETURNED`.

**The JSON element names and endpoints are an analogue of the XML messages,
not the partner bank's published API**; they remain the verification item. The
demonstration answers a reference containing `reject` with `RJCT`/`AC04`,
`pending` with `PDNG`, `settled` with `ACSC`, a collection containing `return`
with a returned status (`AM04`); otherwise a disbursement is `ACSP` and a
collection `ACSC`.

## What is settled without the sandbox

- Every instruction is in AED and strictly positive; anything else is refused
  before the call (`CURRENCY_MISMATCH`, `AMOUNT_NOT_POSITIVE`).
- Amounts travel as ISO 20022 decimal strings written from minor units by digit
  manipulation, never through a float.
- The idempotency key is the outbox event key and travels as `InstrId`; a
  status report for another instruction is malformed, so a retried event
  cannot be matched to the wrong payment.
- An unknown status, or a rejection without a reason code, is malformed, never
  `SETTLED`. The reason code does not cross the port (`PARTNER-BANK-DEV-003`).
- Unreachable bank → `UNAVAILABLE`; nothing is assumed paid.
