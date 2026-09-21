# Core banking adapter — Tuum

Implements `CoreBankingProvider` (`core/ports/core-banking.ts`). The vendor name
appears in this directory and nowhere else. Replacing the core banking platform means
writing a sibling directory, not touching `core/`.

---

## OI-02 — findings from the public developer documentation

**Reviewed 21 September 2026** against the public developer portal
(`developer.tuumplatform.com`): Account, Account Transaction, Loan Product, Loan
Application, Loan Offer, Loan Contract, Loan Receivables, Receivables and Tenant APIs.

These are **public docs, not a commercial answer.** They may not describe everything
available under licence — an Islamic banking module or a fixed-price product type could
exist and simply not be published. Nothing below replaces the written answers OI-02 calls
for. It does make the questions a great deal sharper.

### Finding 1 — the Loan module derives and persists a rate. This is blocking.

**Upgraded from "likely blocking" on review of the API cookbooks.** The platform does not
merely accept a rate; supply none and it computes one, and writes it onto the contract.

From Tuum's own published worked example for `POST /api/v2/offers/{offerId}/accept` — the
call that creates the loan contract — the response carries:

```
"interestRate": 1.539
"apr": 2.11
"contractId": "ID-1664282473"
```

Neither figure was supplied. The request to create the offer carries `requestedMoney`,
`offeredMoney`, `loanPeriod`, `loanTypeCode` and `monthlyRepaymentMoney`; the platform
back-solves a rate and an annualised percentage from them and persists both against the
contract.

**Why that is decisive on its own, before any question of accrual.** DP-01 and SH-01 require
that no rate is persisted against an executed transaction. The reason is not squeamishness
about a column name: under SH-18 the Board audits transactions in the institution's records,
and the servicing platform is the system of record for the obligation. A Murabaha whose
contract record shows an interest rate of 1.539 and an annualised percentage of 2.11 is a
Shariah audit finding on the day it is opened, whatever Sanad's own database contains.

This is also outside what CLAUDE.md §7 anticipated. That rule covers a vendor field we must
*fill* — "the adapter supplies a structural equivalent and records it as a known deviation".
It does not cover a vendor *computing* riba's arithmetic from our figures and storing the
result as the record of the trade. An adapter can contain a vendor's vocabulary. It cannot
contain a vendor's behaviour.

The previous version of this file said: *"a vendor that recalculates a balance over time
would be a blocking finding, not a deviation — it would mean the total can increase, which
SH-02 forbids absolutely."*

The public documentation indicates it does recalculate:

| Evidence | Source |
|---|---|
| `GET /api/v1/contracts/{headerId}/accrued-interest` | Loan Contract API |
| `GET /api/v1/contracts/{headerId}/interests` | Loan Contract API |
| `POST /api/v2/contracts/{headerId}/interest-rate` — a rate is a first-class, changeable contract parameter | Loan Contract API |
| All four repayment schedules (Annuity, Amortisation, Bullet, Balloon) are described as splitting each payment between principal and a periodic charge | Loan Product API |
| Account closure validation blocks on "unpaid accrued interest" — accrual reaches the **account** model, not only the loan module | Account API |

No zero-accrual, fixed-price or fee-only product mode is documented. Searching all eight
API documents for *Islamic*, *Shariah*, *Murabaha* and *profit* returns nothing, and the
262-page API cookbook index contains no Islamic finance recipe of any kind.

**One crack of light, from the cookbooks.** Creating a loan application does *not* require
a rate — the worked example returns `"interestRate": null` — and `monthlyRepaymentMoney` is
a **caller-supplied input**, not something the platform derives. In the published example a
10,000 EUR request carries a 1,032.86 monthly repayment over ten periods: a total of
10,328.60, with the markup dictated by the caller.

That is closer to a fixed-price shape than the Loan Product guide alone suggests. But the
annuity schedule is defined as dividing each repayment "between the interest payment and
principal", and the worked schedule has an Interest column. So the open question is not
*must we supply a rate* — we need not — but **does the platform derive one internally and
accrue on it anyway**. Prose cannot settle that. See "The decisive test" below.

**Consequence.** A Murabaha total is fixed at execution and is never recomputed. A module
whose core behaviour is to recompute a balance over time cannot hold one, and configuring
the periodic charge to zero is not a fix — it leaves the mechanism in place, one
back-office edit away from producing riba on a live contract.

### Finding 2 — the platform has its own paths that increase an executed total

> "With the top-up, the loan principal balance **increases** by the amount of the
> additional top-up amount disbursement. And the system re-calculates the repayment
> schedule." — Loan Contract API

Alongside contract-version endpoints that change the `limit`, the
`monthly-repayment-amount`, the `period` and the rate on an existing contract.

This matters beyond "do not call those endpoints". **Our guarantees stop at our boundary.**
Sanad has no override role and no path that increases a total; the servicing platform's
own back office is a different surface with different entitlements. A contract we booked
can be modified by someone who never touches Sanad.

Two mitigations, both required, neither sufficient alone:

- **Entitlement configuration in the servicing platform**, so no operator role can reach
  top-up or contract-version amendment on a Wasl contract. To be confirmed as achievable.
- **Detection in reconciliation.** The nightly job (SDD §6.10) must assert that every
  booked obligation's total still equals `cost + profit` as executed, and raise a Shariah
  incident on any difference. Drift alerts rather than self-heals. *This check is not yet
  implemented and should be added when the settlement service is built.*

### Finding 3 — credit lines exist but carry no schedule

> "Credit lines or overdraft loans without account — a type of on demand loan that allows
> to disburse and repay the loan when required. **The credit lines have no repayment
> schedules.**" — Loan Product API

Disbursement is also noted as "at this time applicable for credit lines only". Each Wasl
drawdown is a separate Murabaha with its own fixed total and determinate schedule, so a
scheduleless credit line does not model it either.

This supports the design's existing assumption that **Sanad owns the limit and facility
engine** (SDD §6.7), rather than delegating it.

### Finding 4 — the fee mechanism is not a way round this, and must not be used as one

Someone will propose carrying the Murabaha markup as a contract fee. The cookbook shows
the shape: `POST` a fee booking with a `componentTypeCode`, an `effectiveDate` and a fixed
`money` amount. It would work technically.

**It must be rejected, on Shariah grounds rather than technical ones.** In a Murabaha the
profit is part of the sale price, agreed and disclosed at inception as a component of the
one total the buyer accepts (SH-15 — disclosure is a validity condition, not a courtesy).
A markup booked afterwards as an administration fee is the same substance in different
clothing, which is *hiyal*. SDD §3.4 already rejects the identical move on the other side
of the product — "invoice discounting restyled as a service fee" — as a ruse whose
substance is unchanged. The reasoning transfers exactly.

Two supporting observations from the same page:

- The fee catalogue is conduct fees only — `ADM`, `COF`, `CHANGE_FEE`, `CERTIFICATE_FEE`,
  `DISBURSEMENT_FEE`, `BILLING_ADMINISTRATION_FEE`, `REMINDER_FEE`. There is no markup or
  profit component. Nothing here was designed to carry the return on a trade.
- Fee bookings **themselves accrue** — the worked response shows an accrual range across a
  month for a one-off 10 EUR fee. Even the fixed-amount path in this platform is expressed
  as something that accrues over time.

### Finding 5 — `REMINDER_FEE` is a late charge that resolves to income

A reminder fee is, in this model, a revenue component on the contract. Under SH-13 a late
amount posts exclusively to a segregated charity liability, and the chart-of-accounts
mapping must make income recognition impossible rather than merely discouraged.

So `REMINDER_FEE` and any equivalent must be **disabled at product level**, not simply left
unused — and the question "can late amounts post to a segregated liability with no path to
revenue" needs asking about this component specifically, not in the abstract.

### Findings 6–8 — not addressed either way in the public documentation

- **Segregated charity liability** for late amounts (SH-13). Not evidenced. The `INTERNAL`
  account type is "reflected in a certain GL account", which is the plausible vehicle, but
  the chart-of-accounts mapping constraint — *no path to a revenue account* — is the part
  that matters and is unverified.
- **AAOIFI-aligned chart of accounts.** Not addressed.
- **Goods inventory.** Not addressed. Account types are Currency, Internal, Virtual, Shadow
  and Saving. Wasl genuinely holds title between purchase and sale, so this is a real
  balance, and an `INTERNAL` account against a GL account is the likely answer.
- **Commercial model at volume** remains OI-03 and is not public.

### The sandbox run — now confirmation, not discovery

Finding 1 is answered by Tuum's published example. The sandbox run still matters, because
"we ran it against the sandbox and here is the response" carries weight with a Board that
"it says so in a cookbook" does not. Base URLs are per module:
`https://loan-api.sandbox.tuumplatform.com`.

**A. Does it derive a rate on a product shaped like ours?** (confirms Finding 1)

1. `GET /api/v1/loan-products` — list what product types exist in the sandbox.
2. `POST /api/v3/persons/{personId}/offers` with **no rate supplied**, a single payment
   period, and `monthlyRepaymentMoney` equal to `cost + profit`. Prefer a `BULLET`
   product type over `ANNUITY STANDARD` — a single payment at maturity is the closest
   shape to a Murabaha, and if any product type avoids a derived rate it is that one.
3. `POST /api/v2/offers/{offerId}/accept` — this creates the contract.
4. Capture the response. **Are `interestRate` and `apr` populated?**
5. `GET /api/v1/versions/{versionId}/components` and
   `GET /api/v1/contracts/{headerId}/interests` — does the contract record carry them?

**B. Does it also accrue?** (`manualDayChangeEnabled: true` makes this cheap)

6. Record the outstanding balance and `GET /api/v1/contracts/{headerId}/accrued-interest`.
7. Force a day change repeatedly, across a payment date if possible.
8. Call both again. Any movement is riba accruing on a fixed-price sale.

**C. Two configuration questions**

9. Does `POST /api/v1/contracts/{headerId}/top-up` get refused by product configuration?
   (Finding 2)
10. Can `REMINDER_FEE` be removed from the product's component set? (Finding 5)

A run in which step 4 returns nulls on a `BULLET` product is the one result that reopens
the Loan module. Everything else confirms the recommendation below.

### What follows from this

SDD RSK-04 already defines the fallback: *"Sanad owns contract logic and the facility
engine; the core holds accounts, ledger and payments only."* The evidence says **treat that
fallback as the primary design**, and use the Account, Account Transaction and payment
surfaces rather than the Loan module.

That is not a retreat. It is what §3.9 argues for on its own merits — concentrating the
Islamic contract logic where the Board can inspect it, and keeping the platform
core-agnostic so it can be sold to an institution running a different core. The Loan
module's lending intelligence was always "deliberately not used" (§1.3). This finding
means *deliberately not used* has to be *structurally not used*.

**Open question for the architect:** this changes what `bookObligation` maps onto —
account postings rather than loan contract creation. The port is unaffected; the adapter's
operation set is. Not yet actioned.

### Written questions to put to Tuum

1. Is there a product type that holds a **fixed total agreed at inception with no accrual
   and no recomputation** — and if so, is the accrual mechanism absent or merely set to
   zero?
2. Is there an **Islamic banking module** not covered by the public documentation?
3. Can **top-up and contract-version amendment be disabled** at product level, such that no
   role in the back office can increase a booked total?
4. Can late amounts post to a **segregated liability with no chart-of-accounts path to
   revenue**?
5. Is an **AAOIFI-aligned chart of accounts** supported?
6. Can an `INTERNAL` account hold a **goods inventory position** against a GL account?
7. Commercial model at supply chain finance volume (OI-03).

---

## Adapter status

| Half | Status |
|---|---|
| `TuumCoreBankingAdapter` — mapping, idempotency, breaker, credential handling, failure posture | Real. Tested against fixtures. |
| `TuumTransport` — endpoint paths, request and response DTO shapes | **Placeholder**, and now pending the design decision in Finding 1 as well as sandbox access. |

Endpoint paths and payload field names are supplied as adapter *configuration*, not
hardcoded. When OI-02 is answered the configuration is filled in and the fixtures are
re-recorded from real responses. Nothing in `core/` changes.

## Known deviations

Declared in code as `TUUM_DEVIATIONS`, so they surface in review as well as in audit.

### `TUUM-DEV-001` — vendor pricing field on the booking payload

Core banking platforms built for conventional lending commonly require a pricing field on a
credit agreement that expresses return as a periodic proportion. The Sanad domain model has
no such concept and will not acquire one (CLAUDE.md §1.1, SH-01, DP-01).

**Containment.** Where such a field is mandatory, the adapter supplies a structural
equivalent from `vendorPricingCompatibilityFields` in adapter configuration. The field name
is configuration rather than code so the concept is not named in this repository outside
this document.

**Caveat, after Finding 1.** This containment holds only where the field is inert — a
required-but-unused input. It does **not** hold where the platform accrues on it. A
deviation contains a vendor's vocabulary; it cannot contain a vendor's behaviour.

### `TUUM-DEV-002` — party master requires restricted attributes

The party master needs national identifiers the domain model deliberately does not carry.
`PartyDetails.restrictedAttributesRef` is a pointer; the adapter resolves it inside the
trust boundary immediately before the call and never returns it, logs it or places it on a
trace span.

## Failure posture

`QUEUE_AND_RECONCILE`. Origination continues when the core is unavailable; bookings and
settlement instructions accumulate in the transactional outbox and drain on recovery.
Nightly reconciliation proves exactly-once in both directions (SDD §4.9, §6.10).

Correct *because* the core is not a compliance dependency. Screening, e-invoicing, signing
and timestamping all fail closed instead.
