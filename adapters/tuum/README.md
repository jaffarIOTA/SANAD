# Core banking adapter — Tuum

Implements `CoreBankingProvider` (`core/ports/core-banking.ts`). The vendor name
appears in this directory and nowhere else. Replacing the core banking platform
means writing a sibling directory, not touching `core/`.

## Verification status

**The API surface used here is unverified.** SDD §"Status of this document" ¶2 records
that specific Tuum API surfaces and their Islamic-finance and supply-chain capability have
not been checked against vendor documentation or a sandbox. That is open item **OI-02**,
and it is Critical.

Consequently this adapter is built in two halves:

| Half | Status |
|---|---|
| `TuumCoreBankingAdapter` — mapping, idempotency, breaker, credential handling, failure posture | Real. Tested against fixtures. |
| `TuumTransport` — endpoint paths, request and response DTO shapes | **Placeholder.** Every shape is a stated assumption pending sandbox access. |

Endpoint paths and payload field names are supplied as adapter *configuration*, not
hardcoded, precisely because they are unknown. When the sandbox answers OI-02, the
configuration is filled in and the fixtures are re-recorded from real responses. Nothing
in `core/` changes.

## The six questions OI-02 must answer

1. Can the platform hold a **fixed-price deferred sale** — a total agreed at inception with
   no accrual and nothing that recomputes it?
2. Can it model **revolving, multi-drawdown facilities** at supply chain volume with
   real-time utilisation under concurrency? (If not, the limit engine stays in Sanad —
   which is the design's assumption anyway. See SDD §6.7.)
3. Can late amounts post to a **segregated charity liability** with no mapping to a revenue
   account?
4. Does it support an **AAOIFI-aligned chart of accounts**?
5. Does it support the institution holding **goods inventory** between purchase and sale?
   Wasl takes title; this is a real balance, not a notional one.
6. What is the **commercial model at volume**? A per-contract price could break the unit
   economics (OI-03).

## Known deviations

Deviations are also declared in code, in `deviations` on the adapter class, so they surface
in review as well as in audit.

### `TUUM-DEV-001` — vendor pricing field on the booking payload

Core banking platforms built for conventional lending commonly require a pricing field on
a credit agreement that expresses return as a periodic proportion. The Sanad domain model
has no such concept and will not acquire one (CLAUDE.md §1.1, SH-01, DP-01).

**Containment.** If the sandbox confirms such a field is mandatory, the adapter supplies a
structural equivalent — a zero, or whatever the platform's "fixed fee, no accrual" encoding
turns out to be — from `vendorPricingCompatibilityFields` in adapter configuration. The
field name is configuration rather than code so that the concept is not even *named* in
this repository outside this document.

What the adapter sends upward is unaffected: `BookObligationRequest` carries a cost, a
profit amount and a total. Nothing recomputes. Nothing persists a proportion against the
transaction.

**Must be verified before Phase 1 exit:** that the platform does not itself accrue on the
booked obligation. A vendor that recalculates a balance over time would be a blocking
finding, not a deviation — it would mean the total can increase, which SH-02 forbids
absolutely.

### `TUUM-DEV-002` — party master requires restricted attributes

The party master will need national identifiers the domain model deliberately does not
carry. `PartyDetails.restrictedAttributesRef` is a pointer; the adapter resolves it inside
the trust boundary immediately before the call and never returns it, logs it or places it
on a trace span.

## Failure posture

`QUEUE_AND_RECONCILE`. Origination continues when the core is unavailable; bookings and
settlement instructions accumulate in the transactional outbox and drain on recovery.
Nightly reconciliation proves exactly-once in both directions (SDD §4.9, §6.10).

This is the correct posture *because* the core is not a compliance dependency. Screening,
e-invoicing, signing and timestamping all fail closed instead.
