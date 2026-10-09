# Threat Model — Sanad as built

**Status:** Draft for review (SEC-TM01)
**Date:** 2026-10-08
**Assessed at:** commit `77e07dc` on `main`, plus the uncommitted working tree of that day
**Method:** STRIDE per trust boundary, then each product abuse case SEC-TM02..TM14 from
`docs/CYBERSECURITY-REQUIREMENTS.md` §2.1 checked against the code
**Companion:** `docs/SECURITY-REGISTER.md`. Every gap below has an `SR-` number there, with a
severity, an owner and a due date.
**Review:** each release, and whenever a trust boundary in §3 changes (SEC-TM01)

> **How to read this document.** It describes the repository as it is, not as the SDD
> intends it to be. A control is listed only if the code has it, with the file that holds
> it. A control counts as **proven** only if a named test exercises it. A control with no
> test is listed as a gap. A test marked *(DB-skipped)* runs only when
> `SANAD_TEST_DATABASE_URL` is set. No CI workflow sets it, so in CI these tests never run.

> **Being remediated while this was written.** Another change is replacing the ops
> workbench's development principals with a real sign-in (`apps/ops`, `packages/auth`,
> `core/config/staff-identity.ts`). This document records the state before that change as
> **SR-002, in remediation**. Re-verify §7.13 and §7.14 once it lands.

---

## 1. Scope

In scope: the four Next.js surfaces (`apps/ops`, `apps/sme`, `apps/consumer`, `apps/admin`),
the API routes they host, the origination service (`services/origination`), the outbox worker
(`services/outbox`), the domain (`core/`, `products/`), the rail adapters (`adapters/`), the
schema (`supabase/migrations/0001..0016`), the gateway definitions (`gateway/ibm/`) and the CI
workflows (`.github/workflows/`).

Out of scope until they exist: the production identity provider (SAML/OIDC), the in-Kingdom
PostgreSQL and HSM (ADR 0001), the RFC 3161 timestamping authority, the Temporal cluster
(ADR 0003), and any live rail. Each of these is a trust boundary the platform will depend on.
None of them is wired today, and §6 shows what stands in for each.

## 2. System as built

| Component | Path | What it does today | Live or stand-in |
|---|---|---|---|
| Ops workbench | `apps/ops` | Staff screens: request review, SME business pipeline (stages 5–9), merchants, documents. It also hosts the partner API (`/api/origination/v1`) and the review API (`/api/review/v1`) | Screens act as hard-coded principals (`src/server/session.ts`, `business.ts` `BUSINESS_ROLES`). The APIs authenticate bearer tokens from environment variables (`src/server/staff.ts`, `services/origination/src/principal.ts`) |
| Consumer app | `apps/consumer` | Amount-first journey: sign in, quote, disclosure, acceptance. Also the merchant checkout API (`/api/checkout/v1`) | Sign-in uses `developmentIdentity()` (`src/server/identity.ts`), which accepts any applicant reference. The session is a sealed cookie |
| Admin app | `apps/admin` | Configuration revisions under four eyes, credentials (names only), jurisdiction, rails | Development token sign-in, refused when `NODE_ENV=production`. No production IdP, so admin fails closed in production |
| SME portal | `apps/sme` | Read-only Murabaha trade screens | In-memory fixture (`src/server/trades.ts`). No authentication |
| Origination service | `services/origination` | Partner API: raise, list and withdraw requests; eligibility; health | Wired with `developmentRegistry`, `developmentSnapshots` and `developmentTimestamps` unconditionally (`src/index.ts`) |
| Outbox worker | `services/outbox` | Dispatches outbox events to rail ports | Wired with `developmentDispatchPorts` unconditionally (`src/index.ts`) |
| Database | `supabase/migrations` | Domain schemas `core`, `config`, `evidence`, `audit` with RLS policies, append-only triggers, vault functions and a hash-chained audit writer | Hosted Supabase (ADR 0004), synthetic data only. Apps connect with the session-pooler `postgres` login (`scripts/set-database-url.sh`) |
| Vault | `0001_integration_credentials.sql`, `adapters/kernel/credentials-vault.ts` | Integration credentials, with every read audited to `audit.credential_access` | Supabase Vault |
| Rail adapters | `adapters/ksa/*`, `adapters/uae/*`, `adapters/tuum`, `adapters/nutrient` | Capability ports over HTTP with a circuit breaker and vault credentials | Fixture transports. Only Tuum and Nutrient have made sandbox calls |
| Timestamping | `core/time/tsa.ts` | Branded `TsaInstant`, built only from a `VerifiedTimestamp` | **No TSA adapter exists.** Every instant is minted from the host clock by stand-ins in `apps/*` and `services/*` |
| Gateway | `gateway/ibm` | API Connect definitions, an egress allowlist to core banking | Declarative. The service re-authenticates and does not depend on the gateway |

The GitHub repository `jaffarIOTA/SANAD` is **public** (checked 2026-10-08). Everything in
this repository, including its history, should be treated as known to an attacker.

## 3. Trust boundaries

```
 [Internet / staff network]
   │ TB-01 browser → Next apps (ops, sme, consumer, admin) — cookies, server actions, forms
   │ TB-02 partner / merchant / upstream → API Connect → API routes and origination service
   ▼
 [Application zone: apps/*, services/origination, services/outbox]
   │ TB-03 services → PostgreSQL (Supabase now; in-Kingdom later) — tenant scope, RLS, triggers
   │ TB-04 services → vault (config.get_integration_credential) — credentials
   │ TB-05 services → rails, via adapters and the outbox — consent, response authenticity
   │ TB-06 services → timestamping authority / signing (Nutrient) — non-repudiation
   │ TB-07 audit chain (audit.audit_event, contract-leg chain) — integrity over time
   │ TB-08 tenant ↔ tenant — inside every one of the above
   │ TB-09 source → CI → artefact — the supply chain (public repository, GitHub Actions)
```

## 4. Data flows

| Ref | Flow | Crosses | Authentication today |
|---|---|---|---|
| DF-01 | Staff use the workbench screens and server actions | TB-01, TB-08 | None. Hard-coded principals. SR-002 |
| DF-02 | Staff call the review API (`/api/review/v1/*`) | TB-02, TB-08 | Bearer token from the environment, by digest in constant time (`apps/ops/src/server/staff.ts`) |
| DF-03 | Partners and aggregators raise requests (origination service and `/api/origination/v1`) | TB-02, TB-08 | Bearer token from the environment. The tenant and channel come from the credential (`services/origination/src/principal.ts`) |
| DF-04 | Upstream record system hands over SME applications (`/api/origination/v1/business-applications`) | TB-02, TB-08 | As DF-03, with scope `business:write`. The tenant must be active in the deployment (`business-applications/shared.ts`) |
| DF-05 | Merchant checkout (`/api/checkout/v1/sessions`) | TB-02 | Merchant bearer token (`apps/consumer/src/server/merchants.ts`) |
| DF-06 | Consumer signs in, quotes and accepts | TB-01, TB-06 | Development identity stand-in, then a sealed session cookie. SR-005 |
| DF-07 | Admin proposes and approves configuration | TB-01, TB-03 | Development token sign-in (not production), sealed cookie, then the four-eyes `config.decide_revision` |
| DF-08 | Services read and write domain rows | TB-03 | Database login. `sanad.tenant_id` is never set. SR-003 |
| DF-09 | Adapters fetch credentials | TB-04 | `config.get_integration_credential()`, audited |
| DF-10 | Outbox worker delivers effects (bureau reporting, payments, notifications, webhooks) | TB-05 | Development ports only. SR-004 |
| DF-11 | Instants with contractual effect are attested | TB-06 | Host clock stand-in. SR-004, SR-006 |
| DF-12 | Changes are recorded in the audit chain | TB-07 | `audit.record_event()` for config revisions, deployment jurisdiction and merchants only. SR-012 |

## 5. Assets

| Ref | Asset | Why it matters | Where it lives |
|---|---|---|---|
| A-01 | Money state: amounts, schedules, limits, disbursement and payment status | Direct financial loss | `core.origination_request`, `core.offer`, `core.business_*`, `core.facility`, `core.limit_reservation`, `core.transaction` |
| A-02 | Sequencing gates and their evidence (ownership, possession, risk period) | A non-compliant contract is a Shariah and regulatory incident | `products/murabaha-scf/sequencing/*`, `evidence.evidence`, DB constraints in `0003` |
| A-03 | Consent records | PDPL purpose limitation; every bureau, GOSI, Yakeen, OB or Tahaqoq call depends on one | `core/consent/consent.ts`, the snapshot inputs |
| A-04 | PII and national identifiers | PDPL; must never appear in a log, trace or error | Not stored by design. References only (`containsIdentityNumber`, ports by reference) |
| A-05 | Credentials: rail keys, session master secrets, partner tokens, the DB login | Full compromise of core banking and the document platform | Vault (rails); **environment variables** (session secrets, development tokens, DB URL) |
| A-06 | Audit evidence: the audit chain, contract-leg chain, TSA tokens, signed documents | Without these the institution can prove nothing | `audit.audit_event`, `contract_leg`, `evidence.*`, Nutrient |
| A-07 | Shariah and credit configuration: structures, board positions, catalogues, policies | Tampering silently converts compliant products into non-compliant ones | `config/tenants/*` (files) and `config.revision` (DB, four eyes) |

## 6. STRIDE by boundary

| Boundary | S — spoofing | T — tampering | R — repudiation | I — disclosure | D — denial | E — elevation |
|---|---|---|---|---|---|---|
| TB-01 browser → apps | **Ops: no sign-in (SR-002). Consumer: any applicant reference accepted (SR-005).** Admin: development token, sealed cookie (`packages/auth/sealed-token.ts`) | Server actions read form fields, including `tenant` (SR-002). No CSP or frame-ancestors (SR-027) | Ops acts are attributed to fixed principal IDs, not people (SR-002) | Sealed cookies are opaque and `httpOnly`. The documents route serves without auth (SR-020) | No app-level rate limit (SR-031) | One ops build holds maker and checker at once (SR-002) |
| TB-02 partner → API | Static bearer tokens from the environment, no expiry, wired unconditionally (SR-004). mTLS lives in the contract only | Closed schemas. Tenant and channel come from the credential | Idempotency ledger; correlation ID | Problems carry no credential. Health detail needs its own scope | No hard rate limit, by design (`test/architecture/gateway.test.ts`) (SR-031) | Scopes per credential. No review action on the partner API |
| TB-03 services → DB | — | **RLS is not in force at runtime (SR-003).** Triggers are untested (SR-015) | Most state changes have no chained audit row (SR-012) | Owner login can read every tenant and the vault directly (SR-003) | — | Owner login can disable triggers (SR-003, SR-009) |
| TB-04 vault | — | Revocation is honoured (`vault-credentials.test.ts`, DB-skipped) | Every read is audited in `audit.credential_access` | Values are never returned to the browser. A security-definer `search_path` includes `public` (SR-029) | — | — |
| TB-05 rails | Responses trusted on TLS alone; ZATCA `stampValid` read from a response field (SR-016) | Same | Outbox rows with idempotency keys | Ports carry references, not identifiers | Typed `UNAVAILABLE`; circuit breaker | Consent checked for presence only (SR-026) |
| TB-06 TSA / signing | **No TSA. `TsaInstant` can be minted anywhere (SR-006).** Nafath replay not checked (SR-007) | Signed hash must equal presented hash (Nutrient adapter) | Without a TSA, nothing is independently attested (SR-004) | — | — | — |
| TB-07 audit chain | — | Direct INSERT bypasses the chain (SR-009). The chain forks under concurrency (SR-010) | No verifier (SR-011) | — | — | — |
| TB-08 tenant ↔ tenant | Tenant comes from the credential (API) but from a form field (ops screens, SR-002) | — | — | **Review API reads are not tenant-scoped (SR-018)** | — | — |
| TB-09 supply chain | **Unprotected `main`, unsigned commits (SR-021).** Public repository (SR-040) | Shariah config changes go through git alone (SR-025) | — | **Upstash token in public history (SR-001).** Gitleaks does not scan full history (SR-023) | — | CI runs only the compliance and architecture suites (SR-024) |

---

## 7. Product abuse cases (SEC-TM02..TM14)

Each case gives the threat, the controls the code has, the tests that prove them, and the
gap that remains.

### 7.1 SEC-TM02 — Sequencing gate bypass

**Threat.** Reach a sale leg without ownership, possession or the risk period, through a
direct DB write, PostgREST, a race or a crafted state transition.

**Controls in code.**
- The state machine allows only typed transitions: `products/murabaha-scf/sequencing/state.ts`, `transitions.ts`. Gates are a pure function of evidence and attested instants: `sequencing/gates.ts`.
- A transaction opens only in DRAFT: `products/murabaha-scf/origination/open-transaction.ts`.
- The platform floor: a structure cannot drop a gate or set the risk period below `MINIMUM_RISK_PERIOD_SECONDS` (`products/murabaha-scf/structures/definition.ts`).
- DB second lock: the `transaction_risk_interval_observed` and `transaction_post_possession_states_have_risk_start` constraints, `trg_contract_leg_monotonic` and `trg_transaction_amounts_immutable` (`supabase/migrations/0003_core_domain.sql`).
- No domain table in `public`, so PostgREST cannot reach one (`supabase/config.toml` exposes `public` and `graphql_public` only).

**Tests that prove it.**
- `test/compliance/gate-bypass.test.ts`, per tenant: "refuses to acquire ownership with no evidence at all", "refuses ownership evidence from a self-attested source", "refuses to confirm possession before ownership is evidenced", "refuses to offer the sale before the risk-holding interval has run", "refuses to offer the sale when possession evidence is later withdrawn", "measures the interval from the attested instant, not from when evidence was filed", "refuses an acceptance attested at the same instant as the offer".
- `test/compliance/origination-channels.test.ts`: "exposes no way to open a transaction in any later state", "lands at the start of the sequence, not part-way through it".
- `test/compliance/board-divergence.test.ts`: "refuses a definition that declares a sale leg and omits the risk-period gate", "refuses a risk-holding interval of zero".
- `test/architecture/absences.test.ts`: "migrations create nothing in the schema PostgREST exposes", "SH-06 — the domain reads no clock".

**Residual gaps.**
- No test exercises any of the DB constraints or triggers above, not even a DB-skipped one (SR-015).
- The runtime login is the table owner, which can `ALTER TABLE … DISABLE TRIGGER` (SR-003).
- The floor is one second, and structures are file configuration outside four eyes (SR-025).
- No race test (SR-013).
- Not verified: whether the hosted project's exposed-schema setting matches `config.toml` (SR-041).

### 7.2 SEC-TM03 — Duplicate financing race

**Threat.** Two concurrent drawdowns against one invoice identifier.

**Controls in code.**
- The unique constraint `financed_invoice_unique (tenant_id, invoice_uuid)` and the immutability trigger on `core.financed_invoice_registry` (`0003`).
- The port `FinancedInvoiceRegistryPort`, with no upsert (`products/murabaha-scf/trade/financed-invoice-registry.ts`).

**Tests that prove it.**
- `test/compliance/prohibited-outcomes.test.ts`: "refuses a second drawdown against an invoice already financed", "still allows an idempotent replay of the same drawdown", "keeps the record after settlement". All three are **sequential** and run against an in-memory double (`InMemoryRegistry`).
- An analogous race test exists for offers, not invoices: `test/contract/consumer-persistence.test.ts` "an offer is accepted once: the database refuses a second acceptance, whoever raced past the check" (DB-skipped).

**Residual gaps.**
- No production implementation of the registry port exists. The DB constraint is never exercised.
- No concurrent test (SR-013).
- Nothing deduplicates two in-flight origination requests that cite the same invoice before a transaction exists.

### 7.3 SEC-TM04 — Limit reservation race

**Threat.** Concurrent drawdowns both consume the last capacity.

**Controls in code.** `core.enforce_facility_capacity()`, a deferred constraint trigger that
locks the facility row `FOR UPDATE` and re-sums held reservations at commit
(`0004_decisioning_and_limits.sql`). The ops business book serialises mutations per tenant
(`withTenantLock`, `apps/ops/src/server/business.ts`).

**Tests that prove it.**
- None for the facility trigger.
- `test/unit/ops-business-actions.test.ts` "#1 an action makes and saves its change as one unit (mutateBusiness): concurrent posts both land" proves the in-process lock only, not capacity.

**Residual gaps.**
- No race test, and no repository writes `core.limit_reservation` today (SR-014).
- The in-process lock does not hold across two app instances.

### 7.4 SEC-TM05 — Document tampering after execution

**Threat.** Alter an executed document, offer or evidence record.

**Controls in code.**
- Offer letter version = content hash (`core/documents/offer-letter.ts`).
- One leg, one document, hash-chained (`products/murabaha-scf/legs/leg.ts`).
- The Nutrient adapter refuses a signature whose signed hash is not the presented hash, or that has no verified timestamp (`adapters/nutrient/document-adapter.ts`).
- DB: `trg_offer_immutable` and `trg_offer_acceptance_append_only` (`0011`); `trg_presented_document_append_only` (`0012`); `evidence_append_only` (`0003`); `trg_append_only` on business offer letters and events (`0016`).

**Tests that prove it.**
- `test/unit/offer-letter.test.ts`: "the letter version is a content hash", "the Arabic digits are part of the hashed content".
- `test/compliance/prohibited-outcomes.test.ts`: "refuses to bind one document to a second leg", "refuses to render two legs into one instrument".
- `test/adapters/nutrient-document.test.ts`: "refuses when the signed hash is not the presented hash", "refuses a signature without a verified timestamp (SH-06)".
- `test/adapters/partner-integration.test.ts`: "refuses a signature over a rendition other than the one presented".
- `test/compliance/chain-migration.test.ts`: "detects content altered in transit".
- DB-skipped: `test/contract/consumer-persistence.test.ts` "an offer is a snapshot: the table refuses a change, and saving it again changes nothing"; `test/contract/merchants-documents.test.ts` "appends in the order presented, loads back the attested capture time, and refuses any edit".

**Residual gaps.**
- The DB tests never run in CI (SR-015, SR-024).
- The owner login can bypass the triggers (SR-003).
- `core.origination_request` keeps decisions in a mutable `jsonb` row with no history (SR-012).
- The ops document route serves bytes without authentication or a hash re-check (SR-020).

### 7.5 SEC-TM06 — Signature or timestamp forgery / replay

**Threat.** Reuse a TSA token, replay a Nafath assertion, or re-anchor a hash chain.

**Controls in code.**
- The `TsaInstant` brand and the single constructor `tsaInstant()`; core reads no clock (`core/time/tsa.ts`).
- Leg timestamps must be strictly monotonic, and each leg chains to its predecessor (`legs/leg.ts` `appendLeg`, `verifyChain`).
- The consumer session is bound to the identity assertion it was issued from (`apps/consumer/src/server/session-token.ts`). Acceptance records the assertion once (`apps/consumer/src/server/store.ts` `accept`).

**Tests that prove it.**
- `test/architecture/absences.test.ts`: "%s contains no clock read" (core, Murabaha), "core exports no function that answers \"what time is it\"".
- `test/compliance/prohibited-outcomes.test.ts`: "refuses a leg that does not chain to its predecessor", "refuses a leg back-dated behind its predecessor".
- `test/compliance/chain-migration.test.ts`: "detects a leg dropped in transit", "detects a leg reordered without relinking", "retains the timestamping attestation across the move".
- `test/unit/consumer-session.test.ts`: "binds every request to the assertion it was issued from", "refuses a token altered in any byte".
- `test/unit/consumer-acceptance.test.ts`: "records the disclosure version shown, bound to the identity assertion, once".

**Residual gaps.**
- **No RFC 3161 adapter exists.** `tsaInstant({ verified: true, … })` is constructed from `Date.now()` in `apps/ops/src/server/store.ts`, `actions.ts` and `business.ts`, in `apps/consumer/src/server/store.ts` and in `services/origination/src/server.ts`. The brand is structural, so any module can mint an "attested" instant (SR-004, SR-006).
- No test for TSA token reuse (SR-006).
- The Nafath adapter (`adapters/ksa/nafath/adapter.ts`) does not check an assertion's freshness or uniqueness, and no replay test exists (SR-007).
- The chain head is not anchored to anything external, so a whole chain can be rebuilt consistently. No re-anchoring test exists (SR-008).

### 7.6 SEC-TM07 — Audit chain tampering

**Threat.** Insert, delete or reorder audit events.

**Controls in code.**
- `audit.audit_event` is append-only via `trg_audit_event_append_only` (`0003`).
- `audit.record_event()` computes `prev_hash` and `content_hash` per tenant (`0009_config_revisions.sql`). It is called by `config.propose_revision`, `config.decide_revision`, the deployment-jurisdiction functions (`0014`) and the merchant repository (`services/origination/src/merchants.ts`).

**Tests that prove it.**
- DB-skipped: `test/contract/config-revisions.test.ts` "wrote a chained audit event for the proposal and the decision"; `test/contract/merchants-documents.test.ts` "writes a chained audit event for each change, naming who made it".
- The `chain-migration` suite covers the **leg** chain, not the audit chain.

**Residual gaps.**
- `sanad_app` is granted INSERT and UPDATE on `audit`, against CLAUDE.md §7 "No UPDATE grant". The owner login can INSERT rows with arbitrary hashes, and no trigger recomputes them (SR-009).
- `record_event` locks the latest row `FOR UPDATE`, which serialises neither the first event of a tenant nor a writer that waited on the lock. The waiter reuses the same predecessor, so the chain forks. The hash also includes `timestamptz::text`, which depends on the session `TimeZone` (SR-010).
- No verifier in TypeScript or SQL, and no periodic integrity check (SEC-O10) (SR-011).
- Origination decisions, consumer acceptances and the SME stage events are not written to the chain (SR-012).

### 7.7 SEC-TM08 — Cross-tenant data access

**Threat.** One institution reads another's transactions, policies or divergence configuration.

**Controls in code.**
- The tenant comes from the authenticated credential, in `services/origination/src/principal.ts` and `apps/ops/src/app/api/origination/v1/business-applications/shared.ts` (`businessTenantOr403`).
- Idempotency is keyed on (tenant, partner, key).
- The domain refuses a principal from another tenant (`core/origination/request.ts`).
- Every table has `tenant_id` and an RLS policy on `core.current_tenant_id()`. Primary keys include `tenant_id` (`0006`, `0011`, `0012`, `0016`).
- Semgrep rule `sanad-no-tenant-id-from-client` (`.semgrep/sanad.yml`).

**Tests that prove it.**
- `test/contract/service.test.ts`: "refuses a body claiming a tenant", "scopes keys per tenant-partner, so one caller cannot consume another’s", "never serves one partner the stored response of another".
- `test/compliance/origination-channels.test.ts`: "refuses a principal acting across a tenant boundary".
- `test/unit/exceptions.test.ts`: "never has an owner outside its tenant".
- `test/architecture/absences.test.ts`: "every domain table enables row-level security".
- DB-skipped, and testing an application `WHERE` clause rather than RLS: `test/contract/ops-persistence.test.ts` "a book belongs to its tenant: another tenant does not see the row"; `consumer-persistence.test.ts` "a book belongs to its tenant".

**Residual gaps.**
- **RLS is decorative at runtime.** No code sets `sanad.tenant_id`. The apps connect with the owner login. `FORCE ROW LEVEL SECURITY` is applied only to the `0003` and `0004` tables, and none of the tables the services actually use (`0006`, `0008`, `0009`, `0011`, `0012`, `0014`, `0016`) has it (SR-003).
- **The review API's `GET /requests/{id}` and `GET /queue` return rows without comparing the staff principal's tenant** (`apps/ops/src/app/api/review/v1/requests/[requestId]/route.ts`, `queue/route.ts`) (SR-018).
- The ops screens take the tenant from a form field (SR-002).
- The Semgrep rule matches `req.body.tenantId` only, not `FormData` (SR-033).

### 7.8 SEC-TM09 — Shariah parameter tampering

**Threat.** Set a minimum risk period to zero, empty an excluded-goods register, or swap a
template version.

**Controls in code.**
- The structure floor (`products/murabaha-scf/structures/definition.ts`).
- Configuration revisions under maker-checker in `config.revision` with `config.decide_revision` (`0009`) and `core/config/revision.ts`, for PRODUCTS, RAILS, STAFF_IDENTITY, PARTNERS, CREDIT_POLICY and ORIGINATION_POLICY.
- Islamic products need a board ruling (SH-18).
- The deployment jurisdiction is under four eyes and locked in production (`0014`).

**Tests that prove it.**
- `test/compliance/board-divergence.test.ts`: "refuses a risk-holding interval of zero", "refuses an interval measured against anything but the timestamping authority", "refuses a definition with no approval reference", "refuses a definition that turns off one-document-per-leg".
- `test/compliance/config-revisions.test.ts`: "the proposer may not approve or reject their own revision", "an Islamic product without a board ruling cannot be proposed (SH-18 holds at the admin screen too)", "Murabaha cannot be mapped onto a core banking product by configuration (SH-01)…".
- `test/compliance/sme-products.test.ts`: "%s ships it disabled, and enabling it without a ruling is refused".
- DB-skipped: `test/contract/config-revisions.test.ts` "proposes, refuses self-approval, and is not effective while proposed".

**Residual gaps.**
- Structures and board positions are not a revision area. They change by git commit on an unprotected branch, and the floor is one second.
- No excluded-goods register exists in the code.
- `templateVersionId` is checked only for being non-empty (`products/murabaha-scf/documents/render.ts`).
- All three are SR-025.

### 7.9 SEC-TM10 — Credential exfiltration

**Threat.** Credentials taken from the vault, memory, logs or error paths.

**Controls in code.**
- Vault functions with no plaintext column and every read audited (`0001`).
- Redacting secrets (`core/ports/credentials.ts`, `adapters/kernel/credentials-*.ts`).
- The staged-secret hook (`scripts/scan-staged.mjs`, `.githooks`).
- Semgrep `sanad-no-hardcoded-secret` and `sanad-no-secret-in-next-public`.
- The health report reveals no hosts. No `console.*` call exists in server code.

**Tests that prove it.**
- `test/architecture/secrets.test.ts`: "tracks no environment file except the example", "keeps the example free of values", "assigns no long opaque literal to a secret-named field", "gives no secret-shaped variable a NEXT_PUBLIC_ prefix", "is the configured hooks path", "never adds a value column to config.integration_credential".
- `test/unit/credential-providers.test.ts`: "returns a redacting secret and records the read without the value".
- `test/adapters/partner-integration.test.ts`: "redacts itself in a template literal", "redacts itself when serialised", "redacts credential-shaped and identity-shaped keys on the way to a log".
- `test/adapters/tuum-authentication.test.ts`: "puts no password and no token in a rejection".
- `test/contract/service.test.ts`: "never echoes the credential in a problem body".
- DB-skipped: `test/contract/vault-credentials.test.ts` "reads back through the provider as a redacting secret, and the read is audited".

**Residual gaps.**
- **An Upstash Redis REST token is in the public history** (commit `485e57d`, `.env.example`) (SR-001).
- The gitleaks job passed with that token present, because on `push` it scans only the pushed range (SR-023).
- The DB login is the owner, so `vault.decrypted_secrets` can be read without the audited function (SR-003).
- Session master secrets and the partner, staff and admin tokens come from environment variables, not the vault (SR-034).

### 7.10 SEC-TM11 — Rail response spoofing

**Threat.** A forged ZATCA clearance, registry response or webhook.

**Controls in code.**
- Rails are reached over TLS only beyond the sandbox (`config/tenants/*/rails`, enforced by the rail-config parser).
- Typed `UNAVAILABLE` outcomes.
- The ZATCA adapter refuses a drawdown whose `stampValid` is false (`adapters/ksa/zatca-einvoicing/adapter.ts`).
- Outbound webhooks are declared as signed (`Sanad-Signature` in `api/openapi/origination.v1.yaml`; `core/ports/webhooks.ts`).

**Tests that prove it.**
- `test/compliance/rails-configuration.test.ts`: "beyond the sandbox a rail is reached over TLS only; a base URL never carries a path".
- `test/adapters/ksa-rails.test.ts`: mapping tests.

**Residual gaps.**
- No inbound callback or webhook endpoint exists, and no signature verification for one.
- `stampValid` is the rail's own claim; the ZATCA cryptographic stamp is not verified.
- No outbound signer is implemented.
- No certificate pinning or mTLS to the rails.
- All of these are SR-016.

### 7.11 SEC-TM12 — BOLA / IDOR

**Threat.** Reach a transaction, counterparty, document or evidence record by guessing or
swapping its identifier.

**Controls in code.**
- Partner requests are filtered by partner (`services/origination`).
- A checkout session must belong to the calling merchant (`apps/consumer/src/app/api/checkout/v1/sessions/[sessionId]/route.ts`).
- An offer must belong to the session's applicant (`apps/consumer/src/app/[locale]/offer/[offerId]/page.tsx`).
- SME applications are scoped to the credential's tenant book.

**Tests that prove it.**
- `test/contract/service.test.ts`: "reports another partner’s request as absent, not forbidden", "returns only this partner’s requests".
- `test/contract/store-postgres.test.ts` (DB-skipped): "saves, finds by tenant and partner, lists newest first, and hides other partners".

**Residual gaps.**
- No negative test for:
  - another merchant's checkout session;
  - another applicant's offer;
  - another tenant's business application;
  - the review API by ID across tenants.
- The review API is actually missing the check (SR-018).
- The SME portal and the ops document route have no authentication (SR-019, SR-020).
- `APPLICATION_ID_TAKEN` was verified to be **within-tenant only**: the per-tenant book and the `(tenant_id, application_id)` primary key make it so. It is not a cross-tenant oracle (SR-017, Low).

### 7.12 SEC-TM13 — Mass assignment

**Threat.** Set `profit_amount`, `state` or `tenant_id` from the client.

**Controls in code.**
- Every OpenAPI object schema is closed, compiled into validators (`services/origination/src/contract.ts`, `api/openapi/*.yaml`).
- No tenant, channel or currency field exists in any request body.
- Amounts are digit strings.

**Tests that prove it.**
- `test/contract/service.test.ts`: "refuses any unknown property, not a hardcoded list", "refuses a proportion-shaped field rather than dropping it", "refuses a body claiming a tenant", "refuses a body claiming a channel".
- `test/contract/origination-api.test.ts`: "closes every object schema against unknown properties", "accepts no tenant, channel or partner identity in a request body", "types no amount anywhere as number".
- `test/contract/business-applications-api.test.ts`: "refuses a currency in the body as an unknown property", "carries no tenant and no currency in the body, and closes every new schema".
- `test/contract/checkout-api.test.ts`: "compiles into a validator that refuses an unknown property and a numeric amount".
- `test/contract/review-api.test.ts`: "requires an Idempotency-Key on every write and compiles a closed Decision schema".

**Residual gaps.**
- Ops server actions read `FormData` fields directly, including `tenant`, with no schema (SR-002).
- The admin and consumer server actions are not schema-validated either. They validate individual fields by hand, which is not a finding in itself.

### 7.13 SEC-TM14 — Privilege escalation to an override

**Threat.** Obtain an entitlement that advances a gate.

**Controls in code.**
- A closed entitlement catalogue with no gate action (`core/authz/entitlements.ts`).
- Approval tiers (`core/origination/policy.ts`).
- Staff authorities come only from mapped groups (`core/config/staff-identity.ts`).
- Four eyes in `core/origination/request.ts` and in the SME stages.

**Tests that prove it.**
- `test/compliance/prohibited-outcomes.test.ts`: "refuses an entitlement naming a sequencing transition", "refuses any action outside the closed catalogue", "has no catalogue entry that could advance a gate".
- `test/compliance/origination-policy.test.ts`: "an approved request still opens a transaction in DRAFT and nothing later, whatever the authority", "approve() refuses a checker whose authority does not cover the amount".
- `test/compliance/origination-channels.test.ts`: "refuses the maker approving their own request".
- `test/compliance/business-application.test.ts`: "a committee case cannot be decided by the officer who submitted it".
- `test/contract/review-api.test.ts`: "offers no decision that advances a gate or overrides a refusal".
- `test/contract/origination-api.test.ts`: "exposes no review action on a partner-authenticated API".
- `test/compliance/staff-identity.test.ts`: "authorities come only from mapped groups, in the platform’s order".

**Residual gaps.**
- The ops screens hold the maker, checker, committee and finance principals at once, so anyone who reaches the workbench holds every role (SR-002, in remediation).
- The consumer can become any applicant (SR-005).

### 7.14 Further threats found while verifying

| Ref | Threat | Where | Register |
|---|---|---|---|
| TM-X1 | **Development stand-ins in production wiring, with no guard.** Origination service: environment token registry, fixture snapshots, clock timestamps. Outbox worker: development ports, which mark bureau-reporting and payment events delivered without delivering them | `services/origination/src/index.ts`, `services/outbox/src/index.ts` | SR-004 |
| TM-X2 | **Consumer impersonation.** `signInAction` accepts any `applicantRef` matching `^[a-z0-9-]{3,40}$` and calls `developmentIdentity()` with no production guard | `apps/consumer/src/server/actions.ts` | SR-005 |
| TM-X3 | Browser hardening: no CSP, `frame-ancestors`, HSTS or `X-Content-Type-Options` on any Next app, so ops approvals and admin decisions can be framed | `apps/*/next.config.mjs` | SR-027 |
| TM-X4 | CI covers only part of what the SEC-D gates name: no unit, contract or adapter suite in CI; no DB; no DAST (D11), image scan (D09), suppression expiry (D14) or licence gate beyond dependency review (D12) | `.github/workflows/security.yml` | SR-024, SR-032 |
| TM-X5 | Public repository: the design, schema, invariants, the Supabase project reference (ADR 0004) and the API Connect org and host (`ibm.yml`) are all public | GitHub | SR-040 |
| TM-X6 | Security-definer functions run with `public` on the `search_path`. `config.revision_payload(p_id)` returns any tenant's payload for an ID | `0001`, `0009` | SR-029 |
| TM-X7 | Stateless sealed sessions cannot be revoked before expiry. Sign-out only deletes the cookie | `apps/admin/src/server/session.ts`, `apps/consumer/src/server/session.ts` | SR-030 |

---

## 8. Residual risk and when to re-run this model

At this commit, the platform's central claims (gates cannot be bypassed, tenants are isolated,
the audit chain proves what happened, time is attested) hold **in the domain layer and its
tests**. They do **not** yet hold at the deployment layer:

- the database does not enforce tenancy;
- nothing attests time;
- staff and consumer identity are stand-ins;
- the DB-level second locks are untested.

That is consistent with a development build on synthetic data (ADR 0004). It is not
consistent with UAT holding real data or with any production go-live. SEC-C01 condition 1
(zero open Critical or High) is not met.

Re-run this model when any of these lands: the ops sign-in (SR-002), the runtime DB role and
`sanad.tenant_id` (SR-003), a TSA adapter, a live rail, the Temporal worker, an inbound
callback endpoint, or the move to the in-Kingdom deployment.
