# `sme-term-islamic` — SME finance by Tawarruq

Amount-first SME finance through commodity Murabaha (Tawarruq): the institution buys a
commodity from a board-approved broker, sells it to the enterprise at a deferred price fixed at
the offer, and — where the board permits — sells it on as the enterprise's agent to realise the
cash. The rate from the tenant's catalogue rule is used once, at quotation, to fix the deferred
sale price; from the offer on, the contract is a price, not a rate.

**Journey shape:** `AMOUNT_FIRST`. **Family:** Islamic — cannot be enabled for a tenant without
that tenant's Shariah board ruling reference (the catalogue parser refuses, `SH-18`). Both
shipped tenants carry it **disabled** until their ruling is recorded through Admin → Products,
under four eyes. **Consumer:** no. **Booking shape:** `CORE_FACILITY` — the tenant maps a core
banking product type in its catalogue.

## Term sheet: currency and variants

As `sme-term-conventional` (see its README for the field and preference tables): a required
**currency** (`SAR` or `AED`) that the request must match, and a list of **variants**, each with
its ceiling, tenor band, grace, owner contribution band, minimum years in operation, purposes,
document checklist, collateral and an illustrative-values note. The variant code is written
again in this module's `variants.ts`, not imported (modules are isolated); the compliance suite
checks the two copies are identical. The schedule is the dated ACT/365 schedule
(`core/pricing/dated-schedule.ts`); grace instalments carry **profit only**, and the deferred
sale price is the schedule's total, fixed at the offer. Dates are never defaulted.

The Saudi tenants carry one SAR variant each; the UAE SME fund carries the same six AED variants
as its conventional entry, **disabled** until its board ruling is recorded.

## What governs it, and what is the institution's own

| Figure | Where it comes from | Status |
|---|---|---|
| The structure, broker, commodity, agency | The tenant's Shariah board ruling (`boardRulingRef`), as configuration | Required before enabling. |
| Enterprise size | SAMA Rulebook, *Definition of SMEs*, Circular No. 381000064902 (14 March 2017), via `config/regulatory/sme-definition.json` | Cited. |
| Debt-service cover, revenue share, no-history ceiling | **The institution's credit policy** (`source: TENANT_CREDIT_POLICY`) | Illustrative; no SAMA rule found that sets them (searched 2026-10-08). |
| Programme guarantee coverage | The institution's agreement with the national SME loan guarantee programme | Placeholder. |
| Structure | AAOIFI Shari'ah Standard No. 30 (Monetization / Tawarruq), as the board applies it | The board's ruling governs. |

## The sequence

Draft → commodity purchased (at exactly the quoted cost, `SH-03`) → sold to the enterprise
(signed deed) → title transferred → proceeds realised (agency only where the board permits,
`SH-18`) → disbursed once, with the bureau report, and only after the programme guarantee
where the term sheet requires it. Each step is attested strictly after the one before.

The sequence is the same as `tawarruq-personal`'s and is written again here rather than
imported, because product modules are isolated from each other. The compliance suite runs the
same sequence cases against both, so the two copies cannot drift apart unnoticed.

## Rails it needs (by port)

`commodity-broker`, `credit-bureau` (commercial), `business-registry`, `tax-compliance`,
`payments`, `rate-publisher`.

## Verification items before go-live

1. The tenant board's ruling on SME Tawarruq, recorded as `boardRulingRef` with the broker,
   commodity and agency permission it approves.
2. The tenant's approved SME credit policy, replacing the illustrative values.
3. The guarantee programme agreement, if the product is to be guaranteed.
4. A core banking product type for SME Tawarruq on the tenant, mapped in Admin.
