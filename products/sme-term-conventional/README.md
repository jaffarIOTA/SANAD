# `sme-term-conventional` — conventional SME term finance

Amount-first, reducing-balance term finance for a **business applicant** (a micro, small or
medium enterprise), priced by a rate from the tenant's catalogue rule, with equal monthly
instalments from `core/pricing/schedule.ts` and the platform's APR on every offer.

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
