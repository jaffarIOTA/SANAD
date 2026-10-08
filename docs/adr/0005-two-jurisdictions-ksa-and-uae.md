# ADR 0005 — Two jurisdictions: Saudi Arabia (SAR) and the UAE (AED)

**Status:** Accepted
**Date:** 2026-10-08
**Decided by:** the product owner
**Amends:** ADR 0002 and CLAUDE.md §1, which chartered Sanad for the Kingdom only

## Context

Tuum, the core banking partner, asked for SME lending as it runs for a UAE development fund:
dirham amounts, the UAE credit bureau, UAE Pass, Emirates ID, trade licences, wage records,
partner-bank disbursement. The charter scoped Sanad to SAMA-regulated institutions in the
Kingdom. The product owner decided Sanad should serve both.

Two ways to decide which jurisdiction applies were considered:

1. **Per institution (tenant), from its onboarding record.** One deployment could serve a
   Saudi bank and a UAE fund side by side.
2. **Per deployment, chosen by administrators.** The whole application behaves as one
   jurisdiction at a time.

## Decision

**Per deployment, chosen by administrators in the Admin app, with each institution still
carrying the jurisdiction it was onboarded under.**

- `config.deployment_profile.jurisdiction` (migration 0014) is the jurisdiction the whole
  application behaves as. Changed only by `config.decide_deployment_jurisdiction()` after a
  proposal by a *different* administrator (four eyes), and recorded in every tenant's audit
  chain.
- **Locked in production once there is business**: a deployment cleared for production data
  cannot change jurisdiction after any tenant of the current jurisdiction has recorded
  business, because every amount it holds is in that currency. Development and UAT (synthetic
  data, ADR 0004) can switch freely, so both can be demonstrated.
- **Residency follows the jurisdiction**: production data in the Kingdom for SA, in the UAE
  for AE, behind a customer-managed HSM (constraint `deployment_profile_production_residency`).
- **Tenants keep their own jurisdiction** (`core.tenant.jurisdiction`, `base_currency`,
  migration 0013), frozen once they have done business. The deployment setting decides
  which tenants are *active*; it never rewrites a tenant's currency. Every money-bearing
  table refuses a row whose currency is not its tenant's.
- A **jurisdiction profile** (`config/jurisdictions/ksa.json`, `uae.json`) states currency,
  regulator, time zone, contractual calendars and the adapters permitted per capability.
  A tenant's rails are parsed against the catalogue narrowed to its jurisdiction, so a Saudi
  tenant cannot be configured onto a UAE bureau or the reverse.
- **Regulatory definitions live per jurisdiction** under `config/regulatory/<code>/`, each
  with its instrument: SAMA Circular 381000064902 for Saudi SME size; UAE Cabinet Resolution
  No. 22 of 2016 for UAE SME size, by sector.

## Why per deployment

Data residency settles it for production. SAMA's outsourcing and cloud rules and the PDPL
keep Saudi customer data in the Kingdom; UAE customer data has its own residency
requirements. A production database therefore does not mix the two, so a per-tenant choice
would only ever be exercised in development. A deployment-level setting matches how the
platform will actually be installed, and keeps every screen, rule and integration consistent
with one switch.

## What does not change

Every invariant in CLAUDE.md §2 and §12 holds in both jurisdictions: no floating point in the
financial path, no secret outside the vault, tenant and channel from the principal, APR from
`core/pricing/apr.ts` only, consent before every rail call, Murabaha invariants inside
`products/murabaha-scf/`. Products with jurisdiction-specific rules say so: BNPL as built
follows the SAMA BNPL Rules and stays riyal-only.

## Consequences

- `CurrencyCode` is `'SAR' | 'AED'`; amounts in different currencies are never combined.
- UAE rail adapters (AECB, UAE Pass, ICP, NER, MOHRE, FTA, partner bank) are built on fixtures
  and stay BLOCKED until a sandbox call is verified, as for the Saudi rails.
- Open items for the UAE: which CBUAE rules bind the institution depends on its licence (a
  government development fund may sit outside them), confirmation of the SME-definition
  reading where its two criteria disagree, and UAE data-residency requirements for the
  production deployment.
