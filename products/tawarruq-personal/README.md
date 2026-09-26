# `tawarruq-personal` — personal finance by organised Tawarruq

Amount-first personal finance for individuals, structured as commodity Murabaha:
the institution buys an identified commodity lot from a broker, sells it to the
customer at cost plus a disclosed profit on deferred monthly instalments, and the
customer (or an agent the customer appoints, where the board permits) sells the
commodity on for cash, which is disbursed to the customer.

**Journey shape:** `AMOUNT_FIRST`. **Pricing:** the tenant's catalogue rule gives a
rate (benchmark + margin, bounded by the market range); the platform turns it into
a reducing-balance schedule (`core/pricing/schedule.ts`); this module discloses the
commodity cost, the profit and the deferred sale price, and the platform discloses
the APR beside them. **Enabled per tenant only by that tenant's board ruling.**

| | |
|---|---|
| Governing rules | SAMA Rules Regulating Consumer Finance (disclosure, APR, cooling-off, fees); SAMA Responsible Lending Principles for Individual Customers (deduction ratios); AAOIFI Shariah Standard 30 (Monetization / Tawarruq); the tenant board's ruling |
| Thresholds needing a citation before go-live | the deduction-ratio cap in `terms.affordability` — the value shipped here is a placeholder and the `citation` field says so; the tenant sets the current article and figure |
| Ports | `commodity-broker`, `credit-bureau` (query before decision, report after booking), `employment-verification`, `payments`, `rate-publisher` |
| Open items | agency by the institution on the customer's behalf (board-specific); whether the broker may be the onward buyer (board-specific) — both are terms, not code |

## Layout

```
terms.ts        the tenant's term sheet: months, broker, agency, affordability rule (with citation)
pricing.ts      request → quote: reducing-balance schedule, commodity cost, profit, sale price
execution.ts    DRAFT → COMMODITY_PURCHASED → SOLD_TO_CUSTOMER → TITLE_TRANSFERRED → PROCEEDS_REALISED → DISBURSED
disclosure.ts   what the customer sees before accepting
index.ts        the ProductModule
INVARIANTS.md   this module's non-negotiables
```
