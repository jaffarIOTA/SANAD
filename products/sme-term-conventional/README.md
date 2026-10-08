# `sme-term-conventional` — conventional SME term finance

Amount-first, reducing-balance term finance for a **business applicant** (a micro, small or
medium enterprise), priced by a rate from the tenant's catalogue rule, on the dated ACT/365
schedule from `core/pricing/dated-schedule.ts` (the schedule the core banking system books, to
the minor unit), with the platform's APR on every offer.

## Term sheet: currency and variants

The term sheet (`terms.ts`) names its **currency** (`SAR` or `AED`, ADR 0005); a request in
another currency is refused (`CURRENCY_MISMATCH`). It lists one or more **variants**
(`variants.ts`): the named products a tenant offers under this module. The product minimum,
the administration fee, the credit rule and the guarantee are the module's and apply to every
variant. Each variant carries:

| Field | Meaning |
|---|---|
| `code`, `nameEn`, `nameAr` | The product as the applicant sees it |
| `maxAmountMinorUnits` | Ceiling for this variant |
| `minMonths`, `maxMonths` | Tenor band, in instalments (grace instalments included) |
| `maxGraceMonths` | Interest-only instalments allowed at the start |
| `min/maxContributionPerTenThousand` | The owner's own contribution to the project cost |
| `minYearsInOperation` | 0 = no minimum |
| `purposes` | Codes with English and Arabic labels; the request must name one |
| `documentChecklistRef` | The programme id of the variant's checklist (`config/loader.ts` `CHECKLISTS`); absent = the programme's own checklist |
| `collateral` | Requirements, labelled in both languages |
| `knockOutNotes` | Optional, display only; the rules that decide are the credit rule's |
| `note` | Where the figures come from and which are illustrative |

The Saudi tenants carry one variant each (`SME_TERM`, SAR), converted from the former single
term sheet. The UAE SME fund (`sme-fund-ae`, AED) carries six, from the core banking partner's
prototype screens shared 2026-10-08: Small Loan, Working Capital, Fixed Assets, Expansion Loan,
First-time Founders, Advanced Tech & AI. Every value the screens did not show is marked
ILLUSTRATIVE in the variant's `note`. Their checklists are
`config/tenants/sme-fund-ae/documents/sme-ae-*.json` (version `0.1.0-illustrative-2026-10-08`).

## Quotation inputs (`QuoteRequest.preferences`)

| Key | Required | Notes |
|---|---|---|
| `variant` | yes | A variant code |
| `purpose` | yes | One of the variant's purposes |
| `disbursementDate`, `firstDueDate` | yes | ISO dates. **Never defaulted**: the schedule rests on agreed dates |
| `paymentDay` | no | Day of month; absent = the first due date's day |
| `graceMonths` | no | Absent = 0 |
| `contributionPerTenThousand` | no | Absent = 0, which fails a variant with a minimum |
| `yearsInOperation` | when the variant has a minimum | `BusinessFacts` does not carry it yet; until it does, the engine passes it here from the registry snapshot |

The tenor in months is `round(requestedTenorDays / 30)`. The quote's `tenorDays` is the actual
day count from disbursement to the last due date. Debt service for the cover test is the level
instalment × 12 (the year after grace, the conservative figure). With a grace period the
disclosure omits the single instalment amount and shows the grace-period interest and the level
instalment as lines.

**Journey shape:** `AMOUNT_FIRST`. **Family:** conventional. **Consumer:** no — the applicant is
an enterprise; the full disclosure set is still produced, because the person signing for a
small enterprise is usually its owner. **Booking shape:** `CORE_FACILITY` — the tenant maps a
core banking product type in its catalogue (`coreBankingProductCode`, Admin → Products).

## What governs it, and what is the institution's own

| Figure | Where it comes from | Status |
|---|---|---|
| Enterprise size (micro, small, medium, large) | SAMA Rulebook, *Definition of SMEs*, Circular No. 381000064902, effective 14 March 2017. Revenue decides; full-time employees decide only with no revenue history. Held in `config/regulatory/sme-definition.json` with that citation. | Cited. Confirm the revision in force before go-live. |
| Minimum debt-service cover | **The institution's credit policy**, `terms.credit.minDebtServiceCoverPerTenThousand`, tagged `source: TENANT_CREDIT_POLICY` with the policy reference. | No SAMA rule found that sets one for SME finance (searched 2026-10-08). The shipped values are illustrative and say so. |
| Maximum financing as a share of revenue | Same: the institution's credit policy. | Illustrative. |
| Ceiling for an enterprise with no revenue history | Same: the institution's credit policy; absent means such enterprises are not served. | Illustrative. |
| Programme guarantee coverage | The national SME loan guarantee programme's coverage for the initiative, from the institution's agreement with the programme; `terms.guarantee.programmeRef`. Coverage varies by initiative and enterprise size. | Placeholder. |
| Variant ceilings, tenors, grace, contribution, years in operation, purposes, collateral | **The institution's product paper.** For the UAE fund: the partner's prototype screens of 2026-10-08, each variant's `note` naming what was shown and what is illustrative. | Illustrative until the fund's product paper is supplied. |
| Enterprise size, UAE | UAE Cabinet Resolution No. (22) of 2016, via `config/regulatory/ae/sme-definition.json` | Cited. |

The limits above are the institution's, and the platform will not pretend otherwise: a credit
rule that does not name `TENANT_CREDIT_POLICY` and a policy reference does not parse.

## Rails it needs (by port)

`credit-bureau` (commercial report, consent-gated; mandatory reporting on booking),
`business-registry` (the enterprise, its legal form and signatories), `tax-compliance`
(Zakat and tax certificate status), `payments`, `rate-publisher`. Financial figures arrive as
snapshots with a source reference (`BusinessFacts.financialsSourceRef`), never typed in.

## Verification items before go-live

1. The tenant's approved SME credit policy and version, replacing the illustrative values.
2. The guarantee programme agreement: coverage, initiative, and whether issuance must precede
   disbursement (`terms.guarantee.requiredBeforeDisbursement`).
3. A core banking product type for SME term finance on the tenant, mapped in Admin. The
   partners sandbox lists one riyal SME product belonging to another partner; it is not ours.
