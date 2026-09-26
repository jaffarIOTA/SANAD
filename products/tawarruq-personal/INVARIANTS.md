# Tawarruq module invariants

Apply inside `products/tawarruq-personal/` only. Each is enforced by type or test.

## T-1 The institution owns the commodity before it sells it

`sellToCustomer()` accepts only a `CommodityPurchased` state whose lot the broker has
confirmed. There is no transition from `DRAFT` to `SOLD_TO_CUSTOMER`.

## T-2 The deferred sale price is fixed at inception and never increases

The customer owes cost + profit as quoted. A reschedule may move dates and split
instalments; the total is compared and refused if it differs. No late charge is
added to the obligation; late amounts go to the charity ledger the platform provides.

## T-3 The onward sale happens only after title has passed to the customer

`realiseProceeds()` accepts only `TitleTransferred`. The commodity sold on is the
identified lot the customer now owns, and the proceeds are the customer's.

## T-4 Nothing is disbursed before the proceeds exist, and nothing twice

`disburse()` accepts only `ProceedsRealised` and queues exactly one `PAYMENT_DISBURSE`
outbox event keyed on the transaction. A second call is a duplicate the outbox refuses.

## T-5 No approval without the bureau, and no booking without reporting it

`execute()` refuses an approval that carries no bureau enquiry reference or an expired
consent, and `disburse()` queues the `BUREAU_REPORT` event beside the payment.

## T-6 Affordability is a tenant rule with a citation

The deduction-ratio cap is configuration carrying the regulation it comes from. A quote
that would exceed it is refused with `DEDUCTION_RATIO_EXCEEDED`; a term sheet without a
citation does not parse.

## T-7 The APR is the platform's

This module never computes an APR. The offer carries the one `core/pricing/apr.ts`
computed from this module's own schedule.
