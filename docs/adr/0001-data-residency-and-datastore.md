# ADR 0001 — Data residency and the choice of datastore

**Status:** Accepted
**Date:** 21 September 2026
**Supersedes:** the unstated assumption in CLAUDE.md §3 that Supabase is the datastore

## Context

NFR-05, RC-03 and AP-09 require that all customer, transaction and document data is stored
and processed in-Kingdom. The wording admits no exception: *"including for logs, backups,
analytics and third-party processors."* SDD §4.8 places UAT and above in-Kingdom, and §5.9
makes residency a continuously verified control rather than a one-time design assertion.

Supabase has no Saudi region. It is therefore not a lawful home for production data under
the regime this product is being built for.

That is uncomfortable, because Supabase is genuinely useful for the phase we are in: it
gives us PostgreSQL, a credential vault, auth and a migration path in an afternoon, and
the alternative — standing up hardened PostgreSQL in an in-Kingdom region — is Phase 0
infrastructure work that would block the domain build for no design benefit.

The trap to avoid is not "using Supabase". It is using it *without deciding*, and
discovering at the point of deployment that the schema has grown dependencies on a
platform that cannot be deployed.

## Decision

**Supabase is a development and design-partner datastore only. It is not the production
datastore, and it is not the UAT datastore.**

The production deployment is self-hosted PostgreSQL in an in-Kingdom region, inside the
same trust boundary as the application — the same position already taken for the document
platform, for the same reason (SDD §4.8).

To keep that true rather than aspirational, three rules:

1. **The schema stays portable PostgreSQL.** Anything Supabase-specific is quarantined in
   a named migration and enforced by test, so a new dependency cannot appear quietly.
2. **PostgREST is not used for domain data at all**, which CLAUDE.md §3.1 already requires
   for a different reason. A pleasant side effect: losing it on migration costs nothing.
3. **Supabase Auth is not load-bearing.** External identity is the national identity
   provider behind an adapter; internal identity is enterprise SSO (SDD §4.7). Neither
   routes through Supabase.

## What is Supabase-specific today

| Dependency | Where | On migration |
|---|---|---|
| `vault.create_secret`, `vault.update_secret`, `vault.decrypted_secrets` | `0001_integration_credentials.sql` | Replaced by the in-Kingdom secret backend — see below |
| `supabase_vault` extension | `0005_vault_extension_guard.sql` | Not installed; the guard fails loudly |
| `anon`, `authenticated`, `service_role` roles | `0001`, `0003`, `0004` (revokes only) | Harmless — revoking a role that does not exist is a no-op, but the grants to `sanad_app` are what matter |
| `gen_random_uuid()` | throughout | Core PostgreSQL 13+. Not a dependency. |

Everything else — schemas, constraints, triggers, row-level security, the deferred
constraint triggers carrying SH-02 — is ordinary PostgreSQL.

An architecture test asserts this list is exhaustive: `vault.` may appear only in the two
quarantined migrations, and a new migration that reaches for it fails the build.

## The credential problem is the real one

`docs/SAVING-CREDENTIALS.md` already notes it: **Vault's encryption key is managed by
Supabase.** For a bank deployment that key must be customer-managed and held in an
in-Kingdom HSM (SDD §4.7 — "keys in a hardware security module with documented rotation").

So the secret backend is not merely being ported, it is being replaced. Candidates, to be
decided in Phase 0 with the client's security function:

- **HashiCorp Vault** or equivalent, in-Kingdom, with the application holding a short-lived
  dynamic credential rather than a static one (SDD §4.7 — "centrally managed, dynamically
  issued, short-lived").
- **The institution's existing secrets platform.** A bank will have one. Using it is likely
  faster than justifying a new one through their architecture review.
- **`pgsodium` with a customer-managed key**, keeping secrets in the database. Simplest
  migration path from what exists; weakest separation, since a database compromise reaches
  both the metadata and the material.

`config.get_integration_credential` and `config.set_integration_credential` are the seam.
Their signatures do not mention Vault, so the backend swap is an implementation change to
two function bodies, not a change to any caller.

## Consequences

**Accepted.** Development runs on Supabase, and it is fast. The domain build is not blocked
on infrastructure.

**Accepted.** UAT and above need in-Kingdom PostgreSQL provisioned before Phase 1 exit, and
that provisioning is on the critical path for the phase exit gate, not for the build.

**Accepted.** Someone will have to write the secret backend twice. That cost is bounded by
the seam above and is the price of not blocking now.

**Rejected: use Supabase throughout and seek an exception.** NFR-05 says no exception.
Asking for one on the product whose entire proposition is compliance by construction would
be a poor opening move with a regulator, and a worse one with a Board.

**Rejected: stand up in-Kingdom PostgreSQL now.** It buys nothing the schema does not
already have, and it costs weeks during which no domain code gets written. The portability
test gives us most of the protection for none of the delay.

## Actions

- [ ] Confirm the in-Kingdom region and managed-service options with the client's
      infrastructure function (relates to SDD §4.8)
- [ ] Decide the secret backend with the client's security function
- [ ] Provision in-Kingdom PostgreSQL before UAT
- [ ] Verify residency as a continuous control, not a one-time assertion (SDD §5.9) —
      including log sinks, backup destinations and the analytical store
- [ ] Keep `npm run verify` green: the portability test is the thing preventing drift
