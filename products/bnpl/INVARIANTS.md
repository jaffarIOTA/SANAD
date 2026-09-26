# BNPL module invariants

## B-1 The consumer pays the basket price and nothing more

`quote()` refuses a non-zero profit amount and any consumer-side fee. The merchant
discount is recorded on the quote as a merchant fee and is excluded from the consumer
cash flows, so the platform's APR over those flows is zero.

## B-2 The consumer limit is a tenant rule with a citation

A quote whose basket plus the applicant's outstanding BNPL exposure would exceed
`terms.consumerLimit` is refused with `BNPL_CONSUMER_LIMIT_EXCEEDED`. The term sheet
does not parse without the citation for that figure.

## B-3 No approval without the bureau; no booking without reporting

`execute()` refuses without a bureau enquiry reference and a consent id. Booking
queues the `BUREAU_REPORT` outbox event beside the merchant settlement.

## B-4 The schedule is exact

Instalments are whole minor units that sum exactly to the basket; the remainder is on
the last instalment.

## B-5 The APR is the platform's

This module computes none. The offer carries the one `core/pricing/apr.ts` computed.
