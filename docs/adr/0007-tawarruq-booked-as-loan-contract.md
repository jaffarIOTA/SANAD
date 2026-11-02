# ADR 0007 — SME Tawarruq is booked in the loan system as a loan contract

**Status:** Accepted, 2026-10-15, by the product owner. **Board view required before go-live.**
**Relates to:** `products/sme-term-islamic/INVARIANTS.md` SI-2; ADR 0002 (re-charter);
`adapters/tuum/README.md` ("Steps A.2–A.5", "Lending adapter").

## Context

After the commodity sale, a Tawarruq facility is a debt of a fixed deferred price. The
Islamic module's invariant SI-2 states that the catalogue rate is used once, at quotation,
to fix that price, and that after the offer the contract is a price, not a rate.

The loan system offers two ways to hold it:

1. **Account-shaped** — `CoreBankingProvider.bookObligation` (core-banking-adapter.ts):
   a fixed total and an instalment schedule, no rate. This is how Murabaha is held.
2. **Loan contract** — the lending module (lending-adapter.ts), which carries an
   interest rate and computes its own schedule from it. The 2026-10-08 sandbox note
   opened it for rate-priced products, Tawarruq personal among them.

## Decision

The product owner chose (2) for SME Tawarruq on 2026-10-15: a disbursed Tawarruq is
booked as a Tuum loan contract, with the profit rate snapshotted at quotation sent as the
contract's rate.

## Consequences and containment

- **The deferred price stays the contract's figure.** The signed letter, the schedule
  and the customer's obligation are Sanad's, fixed at the offer (SI-2 still governs
  Sanad's own records). The loan system's rate is the means it uses to service that
  price, not a new price.
- **Reconciliation.** Before go-live, the booking must be reconciled against the deferred
  price: the loan system's total payable and schedule equal Sanad's, or the booking is
  refused. Tuum's contract response does not yet return totals; reading them back is
  added to verification item TUUM-LEND-01.
- **Murabaha is unaffected.** It is never booked as a loan contract
  (`loadLoanBookingConfig` refuses a `murabaha-scf` mapping; the architecture test keeps
  the lending path in one file and out of `products/murabaha-scf`).
- **Board view.** Each institution's Shariah board must state its view on servicing a
  Tawarruq debt through a rate-carrying loan contract before this goes live for that
  institution. Until it has, the booking runs on fixture transports only.
