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
- which payment purpose codes the bank accepts for a loan disbursement and for
  an instalment collection;
- how collection works: direct debit mandate, standing instruction, or sweep
  from an account held at the bank, and how returns are reported;
- whether the bank honours the idempotency key across retries, and for how
  long.

## What is settled without the sandbox

- Every instruction is in AED and strictly positive; anything else is refused
  before the call (`CURRENCY_MISMATCH`, `AMOUNT_NOT_POSITIVE`).
- Amounts travel as minor units in a string, never a float.
- The idempotency key is the outbox event key, so a retried event cannot pay
  twice. An unknown status is malformed, never `SETTLED`.
- Unreachable bank → `UNAVAILABLE`; nothing is assumed paid.
