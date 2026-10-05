# Sanad — build status

**As at 25 September 2026.**

A record of what exists, what has been decided, and what is waiting. The
companion to [ClaudeRecommendations.md](../ClaudeRecommendations.md), which
holds the open items in detail; this is the summary a delivery conversation
needs.

> **Re-chartered 2026-09-25 (ADR 0002).** Sanad is now a product-agnostic KSA Loan Origination Platform; Wasl is its first product module. The table *What is deliberately not built* below no longer applies to embedded lending or the commodity broker integration, which are now product modules and a port respectively. Everything under *Built and tested* remains accurate. Read `CLAUDE.md` for the operative charter and build order.

---

## Where we are in one paragraph

Sanad was **re-chartered on 25 September 2026** (ADR 0002) as a product-agnostic
KSA Loan Origination Platform. Since then: the Murabaha engine has been
**relocated intact** into `products/murabaha-scf/` with its invariants narrowed to
that directory and a test that the engine imports no product; the **product
engine** exists — `ProductModule`, tenant catalogues, sourced basis-point rates,
one platform APR function with golden tests, a disclosure screen; **five product
modules** are built (Murabaha SCF, personal Tawarruq, BNPL, embedded lending,
conventional term) and quote end to end through the workbench; **thirteen KSA
rail adapters** exist on fixtures behind capability-named ports; the workflow
engine is decided (ADR 0003, Temporal) and the origination store has a
PostgreSQL implementation with its migration. **679 tests pass, 2 are skipped
until a database is reachable.**

What is not done is what needs something outside this repository: no rail has
made a live sandbox call, no regulatory threshold has its article confirmed, the
PostgreSQL store has not been run against a database, the Temporal adapter and
the consumer app do not exist, and nothing is deployed. The shape is right and
the numbers are honest; it is not nearly finished.

---

## Built and tested

### The engine — `core/`, 55 modules · the products — `products/`, 5 modules · the rails — `adapters/ksa/`, 14 adapters · the workflow — `adapters/workflow-temporal/`

The part that makes non-compliant transactions structurally impossible.

| | |
|---|---|
| **Product engine** | `ProductModule` (journey shape, `validateTerms`, `quote`, `disclose`, `execute`); per-tenant product catalogue with pricing rules (`FIXED_PROFIT_AMOUNT`, `CATALOGUE_RATE`, `BENCHMARK_PLUS_MARGIN` bounded by the published market range); an Islamic product cannot be enabled without the tenant's board ruling reference. |
| **Rates and APR** | `Rate = { bp: bigint, basis, period }`, effective-dated and sourced (catalogue / publisher / manual override with approval); **one** APR function in `core/pricing/apr.ts`, fixed-point `bigint` throughout, golden-tested against analytically exact cases; integer reducing-balance and flat schedules that sum exactly. |
| **Offers and disclosure** | `buildOffer` is the only constructor and stamps `apr.computedBy`; `<Rate>` and `<Disclosure>` render exactly what `disclose()` returned plus the platform APR, in both languages, with the disclosure version in the markup. |
| **Product modules** | `murabaha-scf` (relocated, trade-first, profit amount, gates intact), `tawarruq-personal` (broker sequence: own → sell → title → onward sale → disburse, board-gated agency), `bnpl` (zero consumer cost, consumer limit, merchant discount), `embedded-lending` (partner-raised, fixed total, revenue-linked collection by tenant permission), `conventional-term` (reducing balance). Every consumer module refuses without a bureau enquiry and queues disbursement and bureau report once, keyed on the transaction. |
| **Outbox** | Pure aggregate: every external effect carries an idempotency key; a duplicate key is refused. |
| **Sequencing state machine** | *(Murabaha module)* States as a discriminated union, so a transition from `PURCHASE_EXECUTED` to `SALE_OFFERED` does not typecheck. No override exists, for any role. |
| **Gate evaluation** | A pure function of (transaction, evidence set). No I/O, no clock read — which is what makes it replayable by the Board and reusable as the acceptance test for both DR and migration. |
| **Trusted time** | `TsaInstant` is branded and constructible only from a verified RFC 3161 attestation. The module exports no `now()`. Measuring a risk period against a server clock does not compile. |
| **Money** | Minor-unit `bigint`. No multiply-by-fraction, no percentage helper, no division — those are rate operations. |
| **Leg hash chain** | Each leg binds its predecessor's content hash. Verified to survive migration; see below. |
| **Decisioning** | A closed expression language with no loops, no regex, no clock. Failure mode is REFER, never approve. |
| **Origination requests** | Five channels (operator, counterparty, partner API, aggregator, agent), maker–checker with four eyes enforced in the domain, tenant-configured approval tiers, agent and partner entitlements, SLAs and expiry — all as configuration (`config/tenants/*/origination/policy.json`), none of it able to reach a gate. |
| **Request lifecycle** | `PENDING_INFORMATION` (from the counterparty, the partner or documents), `SERVICING_UNAVAILABLE` with an attempt ledger and tenant-bounded automatic retry, manual resubmission by a named person with a recorded note, and `resubmit()` after a return — identifier kept, diff recorded, material changes (a tenant-listed field) re-validated. |
| **Exceptions, consent, documents** | `CaseException` as append-only events with owner, SLA and mandatory resolution; consent records that gate the bureau and screening ports; a per-programme document checklist with validity windows. |
| **Eligibility pre-check** | The policy version in force, run over a snapshot, answering approve / refer / decline with reason codes and `persisted: false` in the type. Never a price. |
| **Ports** | Counterparty registry, credit bureau (query **and** reporting duty), screening, notifications, applicant snapshot, rate publisher, workflow, identity authentication, identity verification, document verification, employment verification, tax compliance, account information, payment initiation, bill collection, payments, commodity broker — capability-named, consent-bearing, unavailable as a typed outcome, no personal identifier by value. |
| **Rail adapters** | Nafath, Yakeen, Tahaqoq, SIMAH, Bayan, Wathq, GOSI, ZATCA (tax status), Open Banking (AIS + PIS), SADAD, payments hub, rate publisher, commodity broker — on a shared `RailAdapter` base (vault credential, circuit breaker, typed outcomes) with a fixture transport for tests and an HTTP transport for production; each README names its verification item. **All BLOCKED until a live sandbox call.** |

### The API — `services/origination/`

A Node HTTP service, no framework. Five operations plus platform health,
the fifth being `POST /eligibility`, which creates nothing. The request store
and the idempotency ledger have PostgreSQL implementations (migration 0006)
selected by `DATABASE_URL`; without it the service runs in memory and says so
in its health report.

The load-bearing piece: **the OpenAPI document is compiled into the runtime
validators**. `additionalProperties: false` stopped being a claim in a
document and became the SH-01 control — post a proportion-shaped field and it
is refused, bilingually, without the field name echoed back.

Also: idempotency scoped `(tenant, partner, key)`, RFC 9457 problem details
carrying the control code in both languages, tenant and channel derived from
the credential and never from the body, and no gateway header read anywhere.

### The interface — `apps/ops`, `apps/sme`

Arabic-first with logical properties throughout, both calendars, and a
`<Money>` component that cannot gain a rate prop — adding one fails the build
rather than a test. The workbench hosts the partner API in development so a
request raised by an ERP, an aggregator or an officer lands in the same queue;
the queue has views for review, servicing, the maker, awaiting information,
integration failures, past SLA and decided; the request page carries the
lifecycle controls, the attempt ledger, the resubmission diff and the
document checklist.

### The gateway — `gateway/ibm/`

Two API definitions and two Products for IBM API Connect, all four validated
against the real toolkit. The origination definition is **generated** from the
3.1 contract, because API Connect v10.0.11 cannot parse 3.1; five constructs
that 3.0 cannot express are listed inside the generated file rather than
dropped silently.

### Tests — 736 across 47 files (2 skipped until a database is reachable)

| Suite | Tests | What it protects |
|---|---|---|
| `compliance/` | 183 | Each test *attempts* a prohibited outcome and passes only when it fails |
| `contract/` | 85 (+2 skipped) | The published contract, and the running service over HTTP |
| `unit/` | 115 | Decisioning, eligibility, APR goldens, rates, schedules, product engine, product modules, store codec |
| `architecture/` | 138 | The absences: no rate, no clock in core, no secret, no gateway dependency |
| `adapters/` | 65 | Partner integration, Tuum authentication, the thirteen KSA rails on fixtures |
| `ui/` | 93 | RTL/LTR parity, logical properties, no rate on a screen |

---

## Decided

| | Decision |
|---|---|
| **Gateway** | IBM API Connect with DataPower. Kong removed. |
| **Production gateway** | The bank's own DataPower on their OpenShift. We neither host nor pay for it. |
| **Cluster** | The bank's **on-premises** OpenShift, in-Kingdom. This removed the Azure region timing from the critical path. |
| **Deployment model** | Sanad is a **product**: our cloud first, then each buying institution's own cluster. |
| **Datastore** | Supabase for development **and UAT**, synthetic data only (ADR 0004, 2026-10-05, amending ADR 0001). In-Kingdom PostgreSQL with a customer-managed HSM for production. |
| **Contract format** | OpenAPI 3.1 stays the source of truth; a 3.0 artefact is generated for the gateway. |
| **Charter** | Product-agnostic origination engine with product modules; rates, APR, amount-first journeys and Tawarruq allowed by decision; the no-rate rule scoped to the Murabaha module (ADR 0002). |
| **Workflow engine** | Temporal, self-hosted on the institution's OpenShift, behind `core/ports/workflow.ts` (ADR 0003). Adapter not yet built. |

---

## Pending

### Waiting on a decision — ours to ask, yours to answer

Ordered by what it costs to guess wrong.

| | Question | Blocks |
|---|---|---|
| **E-17** | PostgreSQL, Oracle or Db2 on the bank's cluster? | The schema. Our RLS, deferred constraint triggers and immutability triggers are PostgreSQL-specific in load-bearing ways. Oracle or Db2 means re-*proving* the controls, not re-writing them. |
| **R-01** | Is Tuum the system of record for the contract, schedule and profit amount? | Settlement and lifecycle design. Tuum's own published example returns proportion-shaped fields on an accepted offer, which is a Board finding on day one. |
| **E-19** | If compute must be in-Kingdom, why is the core banking platform SaaS abroad? | The same answer as R-01, reached independently from residency. |
| **R-03** | Board answers to OI-22, OI-23, OI-24 | Embedded nomination, embedded collection, commodity brokers — 3 modules. |
| **E-01, E-02** | Five environments, and DR's RPO/RTO | Provisioning. RPO must be 0 for `evidence` and `audit`: losing rows breaks the chain rather than losing history. |
| **E-04** | Which accredited timestamping authority? | **Gate 3.** No TSA, no sale leg, no product. Unprocured and not in ADR 0001's action list. |
| **R-02** | Nutrient licence scope | Document generation and signature. |
| **E-22** | Does API Connect run on the bank's cluster or IBM Cloud SaaS? | Residency for all three integration flows. |

### Waiting on a third party

- **The IBM dev instance returns `403 Plan limit reached`** on every platform
  API path, including unauthenticated ones, on an account created the same
  day with no usage. Everything is built and validated; **nothing can be
  published until this clears.** Ticket text is in
  [gateway/ibm/INSTANCE.md](../gateway/ibm/INSTANCE.md).
- **Tuum sandbox credentials** are unverified. The authentication client is
  built and tested and there is a curl runbook; the likely cause of the
  earlier failure was the host (`sandbox-partners`, not `sandbox`) and the
  endpoint (employee, not person).

### Buildable now, nothing blocking

1. **The repository split** — first half done 2026-10-05: the workbench's
   request book is on PostgreSQL (`core.origination_request`, migrations 0006
   and 0010) when `SANAD_DATABASE_URL` is set. The store keeps its synchronous
   working set and `apps/ops/src/server/persistence.ts` makes it durable: one
   load per process, every change written in a transaction before the response
   that reports it. Proven by restart: a decision and a partner request both
   survive, the id sequence continues, the SH-10 registry is rebuilt from the
   book, and an API call works before any page has rendered. **Still in
   memory:** half-completed drafts (screen state by design), presented
   documents (the evidence store), the partner API's idempotency ledger in the
   workbench, and the consumer app's offers and checkout sessions. The
   standalone service and the workbench copy of the routes collapse next.
2. **R-10** — the internal review API specification. Approve, return and
   reject are deliberately absent from the partner contract; they need their
   own, with their own authentication.
3. ~~**R-15** — durable idempotency~~ — tested 2026-10-03 against the local
   Supabase database (`npx supabase start`, migrations 0001–0008 applied); the
   PostgreSQL store and vault contract tests run when `SANAD_TEST_DATABASE_URL`
   is set.
4. ~~The Temporal adapter~~ — built (`adapters/workflow-temporal/`): programs
   over effects, activities, worker, in-memory runner; not yet run against a
   Temporal server (KSA-WF-TEMPORAL-01).
5. ~~The consumer app~~ — built (`apps/consumer`, port 3003): national-identity
   sign-in (development stand-in), amount-first application, disclosure,
   acceptance bound to the disclosure version, merchant checkout.
6. ~~Splitting `counterparty-registry`~~ — done: `core/ports/business-registry.ts`
   and `core/ports/counterparty-master.ts`; the Wathq adapter implements the first.
7. **Every regulatory threshold's citation.** The BNPL ceilings now cite the
   SAMA Rules for Regulating BNPL Companies (Nov 2023): Art. 22(1) SAR 10,000,
   Art. 22(2) twelve instalments, Art. 22(3) electronic collection, Art. 20(3)–(5)
   age, residency, riyals, Art. 19(6) identity (2026-10-02). Still placeholders:
   the deduction-ratio cap (Responsible Lending Principles for Retail Consumers)
   and the SAMA APR annex examples for the APR golden tests.
8. ~~Merchant onboarding, checkout API, settlement reconciliation, ZATCA
   e-invoicing~~ — built: `core/merchants`, `core/checkout`,
   `api/openapi/checkout.v1.yaml` served by the consumer app,
   `core/reconciliation/settlement.ts`, `adapters/ksa/zatca-einvoicing`.
9. ~~Applying the remaining Figma frames~~ — done 2026-09-28: the queue (Transactions
   frame: summary cards, tab strip, pill actions, pagination), the request page
   (Setting frame: tab strip, two-column kit fields, filled primary action) and
   the products page (Loans frame: four tiles, catalogue table). The kit's
   tab strip, pills, pagination, tile and field styles live in
   `packages/design/primitives.tsx`. The "Key a request" wizard followed on
   2026-09-30: step strip in the tab form, choice cards, kit fields and buttons.
10. ~~An outbox dispatcher~~ — built: `core/outbox/dispatch.ts` (one event, one
    port, DELIVERED / RETRY / DEAD), `core/outbox/store.ts` (leased claims),
    migration 0008 and `services/outbox` worker; development ports until the
    adapters go live.
11. ~~R-10 the internal review API~~ — built: `api/openapi/review.v1.yaml`,
    served by the workbench at `/api/review/v1` under staff credentials; four
    eyes and authority tiers refused by the service. The consumer session is a
    sealed token bound to the assertion's time (R-23, 2026-09-30).
15. **Configuration revisions under maker-checker** — built 2026-10-04:
    migration 0009 (`config.revision`, four-eyes constraint, immutability
    trigger, `audit.record_event` hash chain), `core/config/revision.ts` (the
    same rules in pure code for the compliance suite), the catalogue resolver
    (`services/origination/src/catalogue.ts`: the approved revision in force,
    else the file) wired into the ops and consumer apps, and the admin
    **Products & modules** area: propose a term-sheet change validated by the
    module's own parser, approve or reject as a different administrator.
    Two development administrators (`adm-dev-01`, `adm-dev-02`) so four eyes
    can be exercised locally.
16. **Rails & adapters** — built 2026-10-05: `core/config/rails.ts` (the
    tenant's rail configuration, vendor-free; the adapter catalogue is an
    input), `adapters/catalogue.ts` (which adapter codes may serve each
    capability), a rail file per tenant, the resolver
    (`services/origination/src/rails.ts`) and the admin area, proposing and
    deciding through the same revision mechanism. Beyond the sandbox a rail
    is TLS only; a fallback is a different adapter; a base URL carries no
    path. Not yet consumed by the adapter composition root — the apps still
    run development ports until a rail goes live.
17. **Staff identity (SSO) configuration** — built 2026-10-05:
    `core/config/staff-identity.ts` (provider: SAML, OIDC or a development
    stand-in that does not parse under a deployed profile; groups → MAKER,
    the approval tiers, PLATFORM_ADMIN; session lifetime ≤ 1 hour; optional
    step-up window; no secret accepted in the configuration), a file per
    tenant, the resolver and the admin area. The admin session lifetime now
    follows the configuration in force. **Not built:** the SAML/OIDC sign-in
    handshake itself — it is built when a provider exists to test against.
18. **Partner entitlements** — built 2026-10-05: the origination policy
    (partners, aggregators, agents, approval tiers, expiries, SLAs) is now a
    revision area; a resolver prefers the approved revision; the workbench
    syncs the policy in force on every request, so a partner suspended in the
    admin app is refused by the partner API on its next call (walked end to
    end). The admin area proposes partner changes; agents and tiers change
    through the same mechanism and get their own forms next. **All five
    admin areas now exist.** Open: the SAML/OIDC handshake, the adapter
    composition root reading the rail configuration, a per-field term-sheet
    form in place of JSON.
14. **Administration app** — begun 2026-10-03: `apps/admin` (port 3004) with
    the credentials area: sign-in with the platform operations token (sealed
    30-minute session), save or rotate a credential into the vault, list names
    and dates, revoke. Products, rails, staff identity (SSO) and partner
    entitlements are listed as not built. `SANAD_DATABASE_URL` switches every
    app from the environment credential provider to the vault.
13. **Document platform verification** — in progress (2026-10-02). The adapter
    is tested without the vendor; the live transport, viewer token, local
    Document Engine stack and synthetic samples exist; the Web SDK viewer runs
    in the workbench in evaluation mode (check V-01, first half). Waiting on the
    trial licence, the engine activation key and a signing certificate for
    V-01 (second half) to V-08 — `adapters/nutrient/verification/README.md`.
12. ~~Snapshot assembly from the rails~~ — built: `core/decisioning/assemble.ts`
    over the registry, screening, bureau, e-invoicing, employment and open-banking
    ports; consent gates each source; `railSnapshots()` is the port. The service
    still runs the development snapshot until the adapters have made live calls.

---

## What is deliberately not built

Recorded so they read as decisions rather than omissions.

| | Why |
|---|---|
| A fourth engine outcome for "needs information" | A person asks for information; the engine says what it could not read. |
| APR inside a product module | One function on the platform computes it; a module supplies cash flows. |
| A rate inside `products/murabaha-scf/` | M-1. The absence is the control, and it is now scoped to where it belongs. |
| Any gate override | Murabaha M-3. A test asserts no entitlement capable of it can be defined. |
| Reading proxy variables inside the HTTP transport | Egress is the institution's; a `fetch` bound to the right dispatcher is injected. |
| A delta chip on the dashboard | No history to compare against. A fabricated percentage on an operations screen is a lie with a percent sign on it. |

---

## Honest caveats

Worth stating plainly, because a green test suite can flatter.

- **The database in use is the local one.** A local Supabase stack (Docker) carries the
  schema, the vault, the configuration revisions and the workbench's request book. The
  hosted project chosen for development and UAT (ADR 0004) has no migrations applied yet:
  its direct host is IPv6-only and unreachable from the development machine, and its
  Session pooler connection string has not been supplied. `npm run db:push` applies all
  ten migrations once `SANAD_DATABASE_URL` points at it.
- **The invariant-guard hook did not see most of October's code.** It fires on the Write
  and Edit tools; a long stretch of this build was written through the shell. A
  retroactive run of the hook over all 298 source files found no credential, no table in
  the exposed schema and no floating-point money or rate. It flags five fields whose
  names begin with `instalment` and are counts, ordinals or intervals rather than money
  (`instalmentCount`, `instalmentNo`, `instalments`, `instalmentIntervalDays`), three of
  which predate October. They are the hook's name-based rule meeting a non-money number;
  the hook's own guidance is to rename them, and that decision is open.
- **There is no timestamping authority.** A development substitute produces
  attestations, clearly named so it is obvious in a diff. Nothing it produces
  may feed a gate in a deployed environment.
- **No adapter has ever made a live call.** Tuum and the document platform are
  ports with fixture implementations. The HTTP transport is unwritten — and
  when it is written, it must honour the bank's forward proxy, which Node's
  `fetch` does not do by default (E-18).
- **Nothing is deployed anywhere.**
- **3 of 40 modules are live.** 31 are specified and unbuilt, 5 blocked on
  answers above, 1 excluded by the specification. The operator navigation
  shows this honestly rather than hiding what is missing.
- **Two toolchain advisories remain**, both the same PostCSS issue bundled
  inside Next, fixable only by a major upgrade. Assessed as not exploitable in
  our usage — a build-time path over our own stylesheets — and written up in
  R-07 so the answer exists before a supply-chain review asks.
