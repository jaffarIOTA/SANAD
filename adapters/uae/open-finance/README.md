# UAE Open Finance — account information

**Port:** `core/ports/account-information.ts`. **Vault provider:** none yet (see
below). **Status:** `BLOCKED` — fixture transport only.

Affordability facts from a business's or a person's bank accounts under the
CBUAE Open Finance framework: average monthly inflow, lowest month-end balance,
returned payments, salary credits. Consent-gated (`ACCOUNT_INFORMATION`). A
snapshot of six figures with a reference — never a mirrored statement.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-OPENFINANCE-01** — what only a sandbox call can answer:

- the institution's participation route (licensed TPP itself, or through a
  licensed TPP / the CBUAE's API hub), its client registration and the FAPI
  security profile (mTLS, signed requests);
- how the per-consent user access token is obtained and refreshed; the live
  transport picks it by the `x-sanad-consent-id` header and does not forward
  that header;
- whether LFIs honour `fromBookingDateTime` / `toBookingDateTime` and page size
  consistently, and how far back transaction history is available;
- whether `Flags: Payroll` is set reliably by LFIs on salary credits (the
  salary count depends on it), and how returned cheques and direct debits
  appear (the adapter counts `Rejected` debits);
- the vault provider code (the vault's list has `OPEN_BANKING`, used by the
  Saudi adapter; a UAE tenant needs its own code by migration).

## Demonstration and assumed contract

This is the one UAE rail with a **published specification**: the CBUAE Open
Finance Standards v2.1 Account Information API, OpenAPI 3.0, base
`/open-finance/account-information/v2.1` —
<https://openfinanceuae.atlassian.net/wiki/spaces/standardsv2dot1final/pages/702421137>.
The adapter reads it field for field:

| Read | Path | Fields read |
|---|---|---|
| Consent | `GET /account-access-consents/{ConsentId}` | `Data.ConsentId` (must echo ours — the standard has the TPP assign it), `Data.Status` (`Authorized` only), `Data.Permissions` (`ReadAccountsBasic`/`Detail`, `ReadBalances`, `ReadTransactionsBasic`/`Detail`), `Data.OpenFinanceBilling.Purpose` (`RiskAssessment`) |
| Accounts | `GET /accounts` | `AccountId`, `Status` (`Active`), `Currency` (`AED`), `AccountSubType` (`CurrentAccount`, `Savings`) |
| Balances | `GET /accounts/{AccountId}/balances` | `Type` (`ClosingBooked` preferred), `CreditDebitIndicator`, `DateTime`, `Amount{Amount,Currency}` |
| Transactions | `GET /accounts/{AccountId}/transactions?fromBookingDateTime=&toBookingDateTime=` | `Status`, `CreditDebitIndicator`, `BookingDateTime`, `Amount{Amount,Currency}`, `SubTransactionType`, `Flags` |

Every response is the `Data` / `Links` / `Meta` envelope; `Links.Next` is
followed. `Amount.Amount` is a decimal **string** in the specification and is
converted to AED minor units by digit manipulation (a JSON number, or a
non-zero digit below the fils, refuses the read). `CurrencyExchange.ExchangeRate`
is a JSON number in the specification and is **never read**.

The derivation is Sanad's, not the standard's (`OPENFINANCE-DEV-003`): inflow
is booked credits in the window less reversals, refunds and loan
disbursements, averaged by integer division; the month-end balance is
reconstructed backwards from the booked balance through booked transactions;
returned payments are `Rejected` debits in the last six complete months; salary
credits are booked credits flagged `Payroll`.

The demonstration transport answers in this shape: a consent id containing a
cast licence (`of-CN-1001001`) or party reference reads that subject's twelve
months of synthetic statement; one containing `revoked`, `expired` or
`awaiting` is that consent status; anything else reads a generic SME account.

## What is settled without the sandbox

- No consent id, no call (`CONSENT_MISSING`); a bank consent that is not
  `Authorized`, not for risk assessment, or without the read permissions is
  `REFUSED` before any account is read; an unknown consent at the bank is
  `REFUSED` with `CONSENT_NOT_FOUND`.
- Accounts in another currency, cards, finance accounts and inactive accounts
  are left out, never converted; no eligible account is `REFUSED` with
  `NO_ELIGIBLE_ACCOUNT`.
- No line, account holder name or account identifier crosses the port or is
  stored. The reference is `of:<consent>:<as-of epoch>`.
- Unreachable bank → `UNAVAILABLE`, which approves nothing.

Tests: `test/adapters/uae-rails.test.ts`, `test/adapters/uae-demonstration.test.ts`.
