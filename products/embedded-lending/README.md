# `embedded-lending` — partner-originated merchant finance

Amount-first finance for a merchant, raised by the partner or aggregator the
merchant trades through (the `EMBEDDED_AGGREGATOR` and `PARTNER_API` channels the
engine already has), and collected either as fixed instalments or as a holdback on
the merchant's revenue flowing through the partner, where the tenant's policy — and,
for an Islamic tenant, its board — permits it.

**Journey shape:** `AMOUNT_FIRST`. **Pricing:** the tenant's catalogue rule (a flat
catalogue rate today) gives a profit amount fixed at inception; the total never
increases whichever collection mode is used. **Family:** conventional by default; an
Islamic tenant enables it only under its board ruling (OI-22 / OI-23 — a revenue-linked
sweep has no determinate final payment date, which some boards refuse).

| | |
|---|---|
| Governing rules | Finance Companies Control Law implementing regulations; SAMA Responsible Lending Principles where the merchant is an individual; partner entitlements in `config/tenants/*/origination/policy.json` |
| Ports | `payments` (disbursement to the merchant), `credit-bureau` (query and report), `notifications`, partner callbacks through the contract's webhooks |
| Not built | partner settlement reconciliation (the holdback actually arriving), which needs the partner's settlement feed |
