# `conventional-term` — conventional term loan

Amount-first, reducing-balance term finance for a conventional tenant: the rate from
the tenant's catalogue rule (benchmark + margin or a catalogue rate), equal monthly
instalments from `core/pricing/schedule.ts`, the full SAMA consumer disclosure set
with the platform's APR, and the tenant's responsible-lending rule with its citation.

**Journey shape:** `AMOUNT_FIRST`. **Family:** conventional — never enabled for an
Islamic tenant (the catalogue is per tenant; an Islamic tenant simply does not list it).

| | |
|---|---|
| Jurisdiction | **Saudi Arabia only** (ADR 0005). SAMA is the Saudi regulator; this module is not offered to UAE tenants. |
| Governing rules | SAMA Rules Regulating Consumer Finance; SAMA Responsible Lending Principles for Individual Customers; the Saudi Finance Companies Control Law (Royal Decree M/51) implementing regulations |
| Thresholds needing a citation | `terms.affordability` — placeholder value, citation field says which article to confirm |
| Ports | `credit-bureau`, `employment-verification`, `payments`, `rate-publisher` |
