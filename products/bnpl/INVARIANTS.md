# BNPL module invariants

Citations are to the SAMA Rules for Regulating Buy-Now-Pay-Later Companies, November 2023
(Jumada I 1445H), unless stated. The published text on sama.gov.sa governs; this file does not.

## B-1 The consumer pays the basket price and nothing more — Art. 1, Art. 20(1)

BNPL activity is financing "without a term cost payable by the consumer" (Art. 1), and
the company may not charge the consumer any fee, whether owed to it, the store or a third
party (Art. 20(1)). Delay penalties and collection fees are permitted only as the Debt
Collection Regulations for Individual Customers allow; the footnote to Art. 20 records
that SAMA suspended the administrative fee (1% or SAR 50) by decision of 14/02/1446H, so
no such fee is configurable here. `quote()` refuses a non-zero profit amount and any
consumer-side fee. The merchant
discount is recorded on the quote as a merchant fee and is excluded from the consumer
cash flows, so the platform's APR over those flows is zero.

## B-2 The consumer limit and instalment count are the Rules' ceilings — Art. 22(1), 22(2)

Total outstanding BNPL financing per consumer natural person may not exceed SAR 10,000,
"subject to increase or decrease by SAMA"; a term sheet above that figure parses only with
`samaLimitVariationRef`, the reference of the SAMA decision that varied it. A quote whose
basket plus the applicant's outstanding BNPL exposure would exceed `terms.consumerLimit`
is refused with `BNPL_CONSUMER_LIMIT_EXCEEDED`. At most 12 instalments. The term sheet
does not parse without the citation for its figures.

## B-3 No approval without the bureau; no booking without reporting — Art. 19(2), 19(3)

The credit record is verified with the consumer's consent before dealing, and the
consumer's credit information is registered with a licensed bureau and kept updated.
`execute()` refuses without a bureau enquiry reference and a consent id. Booking
queues the `BUREAU_REPORT` outbox event beside the merchant settlement.

## B-4 The schedule is exact

Instalments are whole minor units that sum exactly to the basket; the remainder is on
the last instalment.

## B-5 The APR is the platform's

This module computes none. The offer carries the one `core/pricing/apr.ts` computed.

## B-6 Collection is electronic — Art. 22(3)

`collectionMethods` admits SADAD, card, Open Banking payment initiation and direct debit.
Cash is not a value of the type; a term sheet naming it does not parse.

## B-7 Riyals only — Art. 20(5)

A basket in any currency but SAR is refused at quotation. A SAMA non-objection for another
currency is not modelled, because no tenant holds one.

## B-8 Identified, adult, resident — Art. 19(6), 20(3), 20(4)

`execute()` refuses without an identity verification reference from a reliable,
independent source, for a consumer under eighteen Hijri years, and for a non-resident
unless the tenant records a SAMA written non-objection. These are facts from the identity
rail and the applicant snapshot, never fields the consumer or the merchant fill.
