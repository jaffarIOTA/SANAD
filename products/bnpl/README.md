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
| Governing rules | SAMA Rules for Regulating Buy Now Pay Later Companies (2023): consumer limits, bureau query and reporting, disclosure, no charges to the consumer beyond what the rules permit |
| Thresholds needing a citation before go-live | `terms.consumerLimit` and `terms.maxInstalments` — placeholder values ship with a `citation` that says which article to confirm |
| Ports | `credit-bureau` (query and report), `payments` (merchant settlement), `notifications` |
| Not built | merchant onboarding and the checkout API (CLAUDE.md §13 step 4); the module is the product logic they will call |
