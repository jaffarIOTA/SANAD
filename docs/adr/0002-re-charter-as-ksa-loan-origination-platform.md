# ADR 0002 — Re-charter Sanad as a product-agnostic KSA Loan Origination Platform

| | |
|---|---|
| Status | Accepted |
| Date | 2026-09-25 |
| Decided by | Product owner (IOTA Technologies) |
| Supersedes | The platform-wide invariants in `docs/archive/CLAUDE-v1-wasl-charter-2026-09-21.md` §1.1 (no rate), §6 (no amount input) and SDD §1.5 / PR-X2 (Tawarruq excluded) |

## Context

Between 21 and 25 September 2026 Sanad was built as a Murabaha-only SME supply-chain
finance origination platform (product: Wasl). The build is sound: 570 tests pass, the
domain, decisioning engine, five origination channels, maker-checker, partner API and
API Connect artefacts exist. But three platform-wide rules made it structurally unable to
serve the market it is now required to serve:

1. No free-text amount: every request had to start from a cleared invoice.
2. No rate construct anywhere, enforced by a pre-tool hook, the type system and the
   architecture test suite.
3. Tawarruq excluded by specification; embedded lending "deliberately not built".

The product owner's requirement, stated on 25 September 2026, is a Loan Origination System
that fits most banks and fintechs in Saudi Arabia for BNPL, embedded lending and general
loan origination, with the full set of Saudi integration rails.

Two of the old rules also conflicted with regulation and with the platform's own principle:

- SAMA's consumer finance and BNPL rules require APR disclosure to the customer. A platform
  that cannot represent a rate cannot issue a compliant Saudi consumer offer.
- The charter's best principle was "anything a Shariah board can rule on is configuration,
  not code". Most Saudi institutions originate personal finance through organised Tawarruq
  with their board's approval, so banning it in code violated that principle.

## Decision

1. Sanad is a **product-agnostic origination engine** (`core/`) with **pluggable product
   modules** (`products/`) and **KSA integration adapters** (`adapters/ksa/`).
2. **Amount-first applications are allowed.** The product module declares its journey
   shape (`AMOUNT_FIRST` or `TRADE_FIRST`).
3. **Rates are first-class typed values** (integer basis points, effective-dated, sourced)
   in `core/pricing`. **APR is computed by one platform function** and disclosed on every
   consumer offer. The no-rate invariant is retained **inside `products/murabaha-scf/`
   only**.
4. **Tawarruq is a product module**, enabled per tenant by that tenant's Shariah board
   configuration. Embedded lending is a product module.
5. The Murabaha engine (sequencing, gates, legs, obligation, charity ledger, pricing by
   amount) is **relocated, not deleted**, into `products/murabaha-scf/` with all of its
   invariants and tests intact.
6. An external **Rate Publisher** API is assumed as the source of benchmark rates and market
   APRs, consumed through a port; it informs pricing under tenant rules and never sets a
   customer rate directly.

## Consequences

- `CLAUDE.md` rewritten (this decision's operative form). The old charter archived with a
  superseded banner.
- `.claude/hooks/invariant-guard.py` re-scoped: the rate rules apply only under
  `products/murabaha-scf/` and the legacy Murabaha paths in `core/` until relocation is
  complete; the public-schema and hardcoded-credential rules remain global; a new global
  rule blocks `number`-typed rate or APR fields.
- `test/architecture/absences.test.ts` SH-01 must be narrowed to the Murabaha module as
  part of the relocation task. Until then the suite will fail the moment a rate is added to
  `core/pricing`; that failure is the reminder to do the relocation first, not a reason to
  delete the test.
- `docs/BRD-Gap-Analysis.md` section A ("deliberate deviations — do not fix these") is
  superseded for amounts, products with pricing references and disbursement. Those are now
  ordinary backlog for the respective modules.
- `docs/STATUS.md` "What is deliberately not built" no longer applies to embedded lending
  and the commodity broker integration.
- Open questions OI-22, OI-23 and OI-24 remain open **for Islamic tenants** and are answered
  by tenant configuration; they no longer block the platform.

## Rejected alternatives

- **Keep Sanad Murabaha-only and start a second product for BNPL/embedded.** Rejected:
  it would duplicate the 60% of the platform that is product-agnostic and already built,
  and split the KSA rails across two codebases.
- **Allow rates but keep Tawarruq banned.** Rejected: excludes most Saudi personal finance
  and contradicts the configuration-over-code principle.
