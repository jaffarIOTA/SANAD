# `bnpl` — buy now, pay later

Amount-first: a basket amount at a merchant's checkout, split into a small number of
equal instalments at no cost to the consumer. The merchant pays a discount; the
consumer pays the basket price and nothing more. A consumer limit, a bureau enquiry
before approval and reporting after booking are conditions of the licence, so they
are conditions of this module.

**Journey shape:** `AMOUNT_FIRST`. **Pricing:** `FIXED_PROFIT_AMOUNT` of zero for the
consumer; the merchant discount is a fee on the merchant side and never appears in
the consumer's cash flows. APR is therefore 0.00% and the platform computes it anyway.

| | |
|---|---|
| Governing rules | SAMA Rules for Regulating Buy-Now-Pay-Later Companies, November 2023 (Jumada I 1445H), issued under the Finance Companies Control Law (Royal Decree M/51). Read with the Responsible Lending Principles for Retail Consumers (Art. 19(1)), the Debt Collection Regulations for Individual Customers (Art. 20(1)) and the Financial Consumer Protection Principles (Art. 3(3)(e)). |
| Applicability | The Rules apply to companies SAMA licenses for BNPL activity (Art. 2). A bank tenant offering an instalment product is governed by its own rulebook; it may keep these ceilings as its policy or configure others, each with its own citation. The module ships the Rules' ceilings as the defaults every tenant must consciously depart from. |
| Ports | `credit-bureau` (query and report), `payments` (merchant settlement), `bill-collection` / `payment-initiation` (electronic collection, Art. 22(3)), `identity-authentication` and `identity-verification` (Art. 19(6), 21(2)), `notifications` (instalment due-date notice, Art. 26(5)) |
| Built | the module; merchant onboarding (`core/merchants`); the checkout API and shopper checkout (`apps/consumer`); settlement reconciliation |

## What the Rules require, and where each requirement lives

| Article | Requirement | Where |
|---|---|---|
| 1, 20(1) | No term cost or fee to the consumer; only delay penalties and collection fees under the Debt Collection Regulations. Footnote: the administrative fee (1% or SAR 50) is suspended by SAMA decision of 14/02/1446H | `pricing.ts` refuses any consumer cost; `fees` is always empty (B-1) |
| 19(1) | Responsible Lending Principles for Retail Consumers | deduction ratio in the tenant credit policy — **citation still a placeholder** until that text is to hand |
| 19(2), 19(3) | Bureau check with consent before dealing; register and keep the consumer's credit information updated | `execution.ts` refuses without enquiry and consent; booking queues `BUREAU_REPORT` (B-3); later updates are servicing events |
| 19(4) | Approvals and acknowledgments shown as a pop-up and agreed before dealing | consumer app disclosure and acceptance screen; acceptance records the disclosure version |
| 19(5) | A documented method for creditworthiness and repayment capacity | `core/decisioning` with the tenant credit policy |
| 19(6), 21(2) | Identity through a reliable independent source; phone verified by authentication token; national address verified | `eligibility.identityVerificationRef` (B-8); phone and address verification are identity-rail facts recorded on the applicant snapshot — not yet asserted by this module |
| 19(7) | Stores may not pass fees to the consumer; the company monitors them | merchant contract term in `core/merchants`; monitoring is an operations duty |
| 20(3), 20(4), 20(5) | No consumer under 18 Hijri years; no non-resident without SAMA non-objection; riyals only | `execution.ts` (B-8), `pricing.ts` (B-7) |
| 22(1), 22(2) | SAR 10,000 per consumer, variable by SAMA; at most 12 instalments | `terms.ts` (B-2) |
| 22(3) | Electronic collection only; no cash | `terms.ts` `collectionMethods` (B-6) |
| 22(4) | Total outstanding finance ≤ 20× capital and reserves without non-objection | a portfolio limit for the tenant's finance function; not an origination rule, not modelled here |
| 26 | Contract minimum contents: parties, term, goods, rights and obligations, instalment amount/number/term with advance notice of due dates, consequences of delay, cancellation and refund, early payment, default procedures, credit-record consent, dispute resolution | `disclose()` carries the figures; the remaining items are clauses of the Board-approved finance template rendered by the document platform, and the advance notice is a `notifications` job |
| 27 | Store contract minimum contents | merchant onboarding (`core/merchants`): the merchant agreement reference is required before a merchant can open a checkout session |
| 13(4) | Retain consumer records 10 years after the relationship ends | retention policy on `evidence` and `audit`; asserted at the datastore, not here |
| 17(2), 29(3) | Confidentiality; no disclosure to third parties without SAMA non-objection | the redaction port and consent purposes in `core/consent` |
