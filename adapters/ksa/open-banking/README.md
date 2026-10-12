# Open Banking — AIS and PIS through a licensed TPP

**Port:** `core/ports/account-information · payment-initiation.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-OB-01 — which TPP, the consent dashboard requirements under the SAMA Open Banking Framework, and whether affordability aggregation is done by the TPP or must be done here from lines (which this adapter refuses to store).

## Demonstration and assumed contract

**AIS — source: published.** The SAMA Open Banking Framework (`https://openbanking.sama.gov.sa`)
as implemented on Al Rajhi Bank's developer portal
(`https://developer.alrajhibank.com.sa/open-banking/APIGuides`, AIS
`2022.11.01-final-errata2`). Row "SAMA Open Banking" in `docs/rails/public-structures.md`.

The adapter reads, under `/open-banking/account-information/2022.11.01-final-errata2`:

| Call | Read |
|---|---|
| `GET /accounts` | `Data.Account[]{AccountId, Currency, AccountType, AccountSubType}`; only SAR accounts count |
| `GET /accounts/{AccountId}/balances` | `Data.Balance[]{Type, CreditDebitIndicator, Amount{Amount, Currency}}`; the booked balance is `KSAOB.InterimBooked`, else `ClosingBooked`, else `ExpectedBooked` |
| `GET /accounts/{AccountId}/transactions?fromBookingDateTime&toBookingDateTime` | `Data.Transaction[]{CreditDebitIndicator: KSAOB.Credit \| KSAOB.Debit, Status: KSAOB.Booked \| Pending \| Rejected, BookingDateTime, Amount{Amount, Currency}, Flags[] (KSAOB.Payroll, KSAOB.Loan), TransactionType: KSAOB.*}`; `Links.Next` followed only within this rail's base URL |

`Amount` is a decimal **string** → bigint minor units; a JSON number, another currency, an
unknown indicator or status, or a non-ISO date makes the whole answer `UNAVAILABLE`.
`affordability.ts` derives the port's facts in memory and keeps no line: average monthly
inflow (booked credits ÷ months, over the complete months before this one), lowest
month-end balance (walked back from the booked balance), returned payments (rejected debits
in the last six months), salary credits (booked credits flagged `KSAOB.Payroll`).

The PSU is bound by the bank consent's access token, which the institution's Open Banking
connection holds; the adapter sends `x-sanad-applicant-ref` and `x-sanad-consent-ref` to it
(OB-DEV-002). **Unconfirmed:** that binding, and the `TransactionType` values the
demonstration uses (`KSAOB.LocalBankTransfer`, `KSAOB.POS`, `KSAOB.SADAD`).

**PIS — inferred, not retrieved.** The PIS schemas were not available publicly; the
`/v1/pis/payments` shape is this platform's assumption (OB-DEV-003) and the verification
item KSA-RAIL-OB-02.

The demonstration serves twelve months of history per cast person (salary flagged
`KSAOB.Payroll`, loan instalments `KSAOB.Loan`, returned payments `KSAOB.Rejected`), paged
40 lines at a time; `noaccount` and `unknown` steer the failures.

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
