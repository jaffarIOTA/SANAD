# Embedded lending module invariants

## E-1 The partner is entitled, or nothing is quoted

A quote carries the partner reference that raised it; `quote()` refuses without one.
The entitlement itself (status, programmes, per-request limit) is enforced by the
engine at `raise()`; this module does not re-decide it and cannot widen it.

## E-2 The total is fixed at inception, in both collection modes

Revenue-linked collection changes *when* the merchant pays, never *how much*. The
expected schedule is built from the holdback and disclosed as expected; the obligation
is the fixed total.

## E-3 Revenue-linked collection is a tenant permission

`terms.collection` is `FIXED_INSTALMENTS` unless the tenant's catalogue says
`REVENUE_LINKED`; a quote that asks for revenue-linked collection under a tenant that
does not permit it is refused.

## E-4 No booking without the bureau; disbursement once, reported once

As for every product: `execute()` refuses without a bureau enquiry reference, and
booking queues one `PAYMENT_DISBURSE` and one `BUREAU_REPORT` keyed on the transaction.
