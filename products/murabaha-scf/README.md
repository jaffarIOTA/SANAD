# `murabaha-scf` — Wasl, supply-chain finance by Murabaha

The first product module, and the one the platform was originally built around.
An institution buys the goods a cleared invoice or purchase order names, owns and
possesses them at its own risk for the interval its Shariah board requires, and
then sells them to the counterparty at a disclosed cost plus a disclosed profit
amount, payable on a fixed schedule.

**Journey shape:** `TRADE_FIRST`. An application starts from a real trade, never
from an amount. **Pricing:** cost + profit amount. There is no rate in this
directory; see `INVARIANTS.md`.

| | |
|---|---|
| Governing standard | AAOIFI Shariah Standard 8 (Murabaha); the tenant board's structure definition in `config/tenants/<tenant>/structures/` |
| Regulator | SAMA — Finance Companies Control Law and its implementing regulations for finance companies; the Banking Control Law for banks |
| Board rulings it needs | risk-holding interval (gate 3), acceptable ownership and possession evidence (gates 1–2), *ibra'* basis on early settlement, charity treatment of late amounts, permissible activities register — all tenant configuration, effective-dated |
| Open items | OI-22 / OI-23 / OI-24 — answered per tenant by that tenant's board, not by code |

## Layout

```
sequencing/     the transaction state machine, the three gates, the transitions
legs/           contract legs: one instrument each, hash-chained, timestamped
structures/     the tenant's structure definition (which legs, which gates, which evidence)
pricing/        cost + profit = sale price, fixed at inception
obligation/     the payable, its schedule, reschedule that never increases the total
ledger/         the segregated charity ledger for late amounts
trade/          the financed-invoice registry: an invoice is financed once, ever
parties/        counterparty distinctness — no 'inah
documents/      one leg, one document
origination/    what an approval buys: a DRAFT, and nothing later
```

## Relationship to the engine

The engine (`core/`) raises, reviews and approves an *application*. This module
takes an `Approved` application and opens a transaction in `DRAFT`
(`origination/open-transaction.ts`). Everything after that is this module's own
state machine. The engine never imports this directory; that absence is tested.
