# Murabaha module invariants

These are this module's non-negotiables. They are stricter than the platform's, and
they apply **only inside `products/murabaha-scf/`**. Rates, APR and amount-first
journeys are legitimate elsewhere on the platform (ADR 0002); in here they are not.
Violating one is a defect of the same severity as data loss, and several are
regulatory incidents. Each is enforced by type, test or hook, not by review.

## M-1 There is no rate in this module

No column, field, type, variable, DTO or parameter named or meaning `interest_rate`,
`profit_rate`, `apr`, `accrued_interest`, `compounding`, `penalty_rate`, `rate_index`
or a synonym. Return is a profit *amount*:

```
sale_price_amount = cost_amount + profit_amount
```

fixed once at inception and immutable after. A benchmark may inform how the profit
amount is calculated at quotation time — that happens in the engine's pricing, not
here — and no rate is ever persisted against a transaction. **The absence is the
control.** Enforced by `test/architecture/absences.test.ts` (SH-01, scoped to this
directory) and the pre-tool hook.

## M-2 The total never increases

No code path may increase an executed obligation's total. `reschedule()` accepts new
dates and new instalment splits and refuses any split whose sum differs from the
original total. Enforced in `obligation/obligation.ts` and by a database constraint.

## M-3 The sequencing gates cannot be bypassed

```
PURCHASE_EXECUTED → GATE 1 ownership evidence valid → OWNERSHIP_ACQUIRED
                  → GATE 2 possession evidence valid → POSSESSION_CONFIRMED
                  → GATE 3 risk period elapsed (attested time) → SALE_OFFERED
```

- No transition exists from `PURCHASE_EXECUTED` or earlier to `SALE_OFFERED`. States
  are a discriminated union, so the transition is not callable.
- No override role exists, for anyone. `test/compliance/gate-bypass.test.ts` proves no
  entitlement can be defined that advances a transaction past an unsatisfied gate.
- Gate evaluation is a pure function of (transaction, evidence set). No I/O, no clock.
- Risk-period elapse is measured against the timestamping authority, never `Date`.

## M-4 One leg, one document

Each contractual leg is a separate instrument, separately executed and timestamped,
hash-chained to its predecessor. `documents/render.ts` cannot express two legs in one
request; the database holds a uniqueness constraint on the document reference.

## M-5 Duplicate financing is impossible

The financed-invoice registry is unique on `(tenant_id, invoice_uuid)`. No
`ON CONFLICT DO NOTHING`, no soft delete, no purge — including after settlement.

## M-6 Late charges are never income

Late amounts post only to the segregated charity ledger (`ledger/charity.ts`). No
accounting mapping or report routes them to revenue.

## M-7 No 'inah

The parties on the declared pairs of legs are different legal entities, matched on
verified commercial registration number, never on name (`parties/distinctness.ts`).

## M-8 Anything a Shariah board can rule on is configuration

Risk-holding period, evidence types, structure sequence, *ibra'* basis, charity and
purification treatment are tenant-scoped, effective-dated configuration. If two
boards ruling differently would need a code change here, the design is wrong at
that point.
