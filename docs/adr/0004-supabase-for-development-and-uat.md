# ADR 0004 — Supabase for development and UAT

**Status:** Accepted
**Date:** 2026-10-05
**Decided by:** the product owner
**Amends:** ADR 0001, which placed UAT on in-Kingdom PostgreSQL

## Context

ADR 0001 made Supabase the development datastore only and required in-Kingdom PostgreSQL
from UAT onward. That provisioning has not happened: the in-Kingdom region and managed
service are still unconfirmed with the client's infrastructure team (ADR 0001 action list,
E-01, E-17). Meanwhile the platform now depends on a real database for three things that
were in memory or in files until this month: the credential vault, configuration revisions
under maker-checker, and the origination store.

A hosted Supabase project exists (`vcnfwcbjjnxcaykcocsk`), outside the Kingdom.

## Decision

**Supabase is the datastore for development and for UAT. Production remains self-hosted
PostgreSQL in an in-Kingdom region, with a customer-managed HSM for key custody, exactly as
ADR 0001 decided.**

## The condition this decision rests on

The residency rule is about data, not about environments' names. SAMA's cloud and
outsourcing rules, PDPL and NDMO require customer data to be processed and stored
in-Kingdom. A UAT environment outside the Kingdom is therefore lawful only while it holds no
customer data:

- **UAT on Supabase carries synthetic data only.** No real applicant, counterparty,
  national identifier, commercial registration, bureau file, salary or bank statement.
- **No rail is connected to a production endpoint from UAT.** A rail's sandbox may be used
  where the provider's own sandbox data is synthetic. A rail whose sandbox returns real
  records about real people (some identity and bureau sandboxes do) is not called from
  this environment; it waits for the in-Kingdom one.
- `config.deployment_profile.production_data_permitted` stays `false` for both. The
  constraint from migration 0005 already refuses `true` unless the data region is
  in-Kingdom and the key custody is a customer-managed HSM, so this condition is enforced
  by the database rather than by this document.

If UAT must exercise real customer data — a pilot with a real merchant, a bureau sandbox
that returns live records — that UAT is an in-Kingdom deployment and this ADR does not
cover it. ADR 0001's provisioning items stay open for that reason and for production.

## What does not change

- The schema stays portable PostgreSQL. Platform coupling stays quarantined in migrations
  0001 and 0005 (ADR 0001's table), and the architecture suite still asserts it.
- Every migration guards its grants and revokes against platform roles, so the same files
  apply to the in-Kingdom database.
- The secret backend is still a seam: Supabase Vault here, an in-Kingdom HSM-backed store
  in production. `VaultCredentialProvider` calls `config.get_integration_credential()` and
  does not know which is behind it.

## Consequences

**Accepted.** Development and UAT share a platform, so what is proven in one is proven in
the other. Migrations are applied with `npm run db:push`.

**Accepted.** The in-Kingdom provisioning moves off the UAT critical path and onto the
production one. It is not cancelled.

**Accepted, with the condition above.** A synthetic-only UAT cannot stand in for a pilot.
Whoever plans the first pilot plans the in-Kingdom environment with it.

## Connection note

The hosted project's direct database host resolves to IPv6 only. From a network without an
IPv6 route, use the project's Session pooler connection string as `SANAD_DATABASE_URL`.
Local development can also run the whole stack with `npx supabase start`.
