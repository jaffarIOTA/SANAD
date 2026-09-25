# Sanad — build status

**As at 25 September 2026.**

A record of what exists, what has been decided, and what is waiting. The
companion to [ClaudeRecommendations.md](../ClaudeRecommendations.md), which
holds the open items in detail; this is the summary a delivery conversation
needs.

> **Re-chartered 2026-09-25 (ADR 0002).** Sanad is now a product-agnostic KSA Loan Origination Platform; Wasl is its first product module. The table *What is deliberately not built* below no longer applies to embedded lending or the commodity broker integration, which are now product modules and a port respectively. Everything under *Built and tested* remains accurate. Read `CLAUDE.md` for the operative charter and build order.

---

## Where we are in one paragraph

The **domain is built and tested**: the sequencing engine, the gates, pricing,
obligations, evidence, the leg hash chain, the decisioning engine and the
charity ledger, with 1,596 lines of SQL carrying the compliance controls as
database constraints. A **partner API exists and runs** — contract authored
first, compiled into its own runtime validator, driven over HTTP by 43 tests.
The **operator workbench** runs all three origination doors — ERP over the API,
embedded aggregator, maker/checker keying — into one queue, in Arabic and
English, and the BRD's lifecycle gaps (information from outside, servicing
failure with a controlled retry ledger, resubmission with a diff, document
checklist, consent, exceptions, eligibility pre-check) are built and tested.
**570 tests pass.**

What does not exist is everything that depends on infrastructure nobody has
provisioned yet: there is no database, no timestamping authority, no live
connection to any external system, and nothing is deployed. **3 of 40 modules
are live.** That is the expected shape at this stage — the hard part was the
domain and it is done — but it should not be read as "nearly finished".

---

## Built and tested

### The domain — `core/`, 36 modules

The part that makes non-compliant transactions structurally impossible.

| | |
|---|---|
| **Sequencing state machine** | States as a discriminated union, so a transition from `PURCHASE_EXECUTED` to `SALE_OFFERED` does not typecheck. No override exists, for any role. |
| **Gate evaluation** | A pure function of (transaction, evidence set). No I/O, no clock read — which is what makes it replayable by the Board and reusable as the acceptance test for both DR and migration. |
| **Trusted time** | `TsaInstant` is branded and constructible only from a verified RFC 3161 attestation. The module exports no `now()`. Measuring a risk period against a server clock does not compile. |
| **Money** | Minor-unit `bigint`. No multiply-by-fraction, no percentage helper, no division — those are rate operations. |
| **Leg hash chain** | Each leg binds its predecessor's content hash. Verified to survive migration; see below. |
| **Decisioning** | A closed expression language with no loops, no regex, no clock. Failure mode is REFER, never approve. |
| **Origination requests** | Five channels (operator, counterparty, partner API, aggregator, agent), maker–checker with four eyes enforced in the domain, tenant-configured approval tiers, agent and partner entitlements, SLAs and expiry — all as configuration (`config/tenants/*/origination/policy.json`), none of it able to reach a gate. |
| **Request lifecycle** | `PENDING_INFORMATION` (from the counterparty, the partner or documents), `SERVICING_UNAVAILABLE` with an attempt ledger and tenant-bounded automatic retry, manual resubmission by a named person with a recorded note, and `resubmit()` after a return — identifier kept, diff recorded, material changes (a tenant-listed field) re-validated. |
| **Exceptions, consent, documents** | `CaseException` as append-only events with owner, SLA and mandatory resolution; consent records that gate the bureau and screening ports; a per-programme document checklist with validity windows. |
| **Eligibility pre-check** | The policy version in force, run over a snapshot, answering approve / refer / decline with reason codes and `persisted: false` in the type. Never a price. |
| **Ports** | Counterparty registry, credit bureau, screening, notifications, applicant snapshot — capability-named, consent-bearing, unavailable as a typed outcome, no personal identifier by value. Adapters wait on vendor access. |

### The API — `services/origination/`

A Node HTTP service, no framework. Five operations plus platform health,
the fifth being `POST /eligibility`, which creates nothing.

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

### Tests — 570 across 29 files

| Suite | Tests | What it protects |
|---|---|---|
| `compliance/` | 172 | Each test *attempts* a prohibited outcome and passes only when it fails |
| `contract/` | 85 | The published contract, and the running service over HTTP |
| `unit/` | 77 | Decisioning, eligibility, exceptions, consent, checklist, health aggregation |
| `architecture/` | 113 | The absences: no rate, no clock in core, no secret, no gateway dependency |
| `adapters/` | 43 | Partner integration and Tuum authentication |
| `ui/` | 80 | RTL/LTR parity, logical properties, no rate on a screen |

---

## Decided

| | Decision |
|---|---|
| **Gateway** | IBM API Connect with DataPower. Kong removed. |
| **Production gateway** | The bank's own DataPower on their OpenShift. We neither host nor pay for it. |
| **Cluster** | The bank's **on-premises** OpenShift, in-Kingdom. This removed the Azure region timing from the critical path. |
| **Deployment model** | Sanad is a **product**: our cloud first, then each buying institution's own cluster. |
| **Datastore** | Supabase is development only. In-Kingdom PostgreSQL from UAT (ADR 0001). |
| **Contract format** | OpenAPI 3.1 stays the source of truth; a 3.0 artefact is generated for the gateway. |

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

1. **The repository split.** Worked around for development by hosting the
   partner API inside the workbench, so every channel lands in one queue. The
   standalone service still holds its own in-memory store; both collapse onto
   the database, and the workbench copy of the routes goes at that point.
2. **R-10** — the internal review API specification. Approve, return and
   reject are deliberately absent from the partner contract; they need their
   own, with their own authentication.
3. **R-15** — durable idempotency. Works, but in memory. The dialect depends
   on E-17.

---

## What is deliberately not built

Recorded so they read as decisions rather than omissions.

| | Why |
|---|---|
| Commodity broker integration | Organised tawarruq. Excluded by SDD §1.5 and PR-X2. |
| Embedded lending origination | No identified goods, so no Murabaha. OI-22. |
| Share-of-sales repayment sweep | No determinate maturity, which is gharar. OI-23. |
| Any gate override | §1.3. A test asserts no entitlement capable of it can be defined. |
| A delta chip on the dashboard | No history to compare against. A fabricated percentage on an operations screen is a lie with a percent sign on it. |

---

## Honest caveats

Worth stating plainly, because a green test suite can flatter.

- **There is no database.** Both stores are in memory and lost on restart.
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
