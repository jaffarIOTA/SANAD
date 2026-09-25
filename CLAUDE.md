# Sanad — Build Instructions

**Sanad** (سند) is IOTA Technologies' Loan Origination Platform for the Kingdom of Saudi
Arabia. It is built to fit most SAMA-regulated banks, finance companies and fintechs, for
**BNPL, embedded lending, consumer and SME finance, Islamic and conventional**, as a
product-agnostic origination engine with pluggable product modules and a complete set of
Saudi integration rails.

**Wasl** (وصل), the Shariah-compliant SME supply-chain-finance product, is the first product
module. It is no longer the platform.

> **Re-chartered 25 September 2026.** The previous charter (archived at
> `docs/archive/CLAUDE-v1-wasl-charter-2026-09-21.md`, decision in `docs/adr/0002`) scoped
> Sanad as a Murabaha-only platform with no amounts, no rates and no Tawarruq anywhere.
> Those three platform-wide bans are **reversed** by explicit decision of the product owner.
> Do not relitigate them. Do not reintroduce them "for safety". A session that refuses to
> build BNPL, Tawarruq or rate-priced products is working against the charter.

This file is the operative summary. Where it disagrees with an older document in `docs/`,
this file wins and the older document gets a superseded banner.

---

## 1. What Sanad is

```
                        ┌──────────────────────────────────────────┐
   channels ──────────▶ │  ORIGINATION ENGINE (core/)              │ ──▶ core banking
   branch · digital ·   │  application · applicant · decisioning · │     (Tuum or the
   partner API ·        │  workflow · maker-checker · documents ·  │      bank's own)
   embedded · agent     │  consent · exceptions · SLA · audit      │
                        └───────────────┬──────────────────────────┘
                                        │ product modules (products/)
          ┌──────────────┬──────────────┼──────────────┬──────────────┐
      Murabaha SCF    Tawarruq      BNPL           Embedded        Conventional
       (Wasl, built)  personal      instalment     lending         term loan
                                        │ KSA rails (adapters/ksa/)
   Nafath · Yakeen · Tahaqoq · SIMAH · Bayan · Wathq · GOSI · ZATCA · Open Banking ·
   SADAD · Payments Hub · Rate Publisher · Notifications
```

- **The engine is product-agnostic.** It knows applications, applicants, products,
  decisions, workflow, documents and money. It does not know whether a product is a
  Murabaha or a term loan; the product module does.
- **A product module owns its contract logic.** Pricing method, disclosure, schedule
  shape, execution sequence, and its own invariants. Modules are isolated from each other.
- **Every institution-specific ruling is configuration**, tenant-scoped and effective-dated:
  credit policy, product catalogue, Shariah board positions, document checklists, approval
  tiers, partner entitlements, SLAs.
- **Adapters own vendor vocabulary.** No rail's DTO crosses into `core/` or `products/`.

**The second-client test still governs every PR:** would the next bank or fintech want this
exact behaviour? If not, it belongs in `config/`, a product module, or an adapter.

---

## 2. The decisions that changed on 25 September 2026

| Was | Now | Why |
|---|---|---|
| No free-text amount; a request starts from a cleared invoice | **Amount-first applications are allowed.** The product module declares whether the journey starts from an amount (BNPL, personal finance, term loan) or from a trade (Murabaha SCF) | A BNPL application *is* a basket amount at checkout. Refusing it refuses the market. |
| No rate construct anywhere, enforced by hook, type system and 113 tests | **Rates exist, as first-class typed values, in `core/pricing` and in rate-priced product modules.** APR is computed and disclosed on every consumer offer. The no-rate invariant is **scoped to `products/murabaha/`** | SAMA's consumer finance and BNPL rules require APR disclosure. A platform that cannot hold a rate cannot produce a compliant Saudi offer. |
| Tawarruq excluded by specification | **Tawarruq is a product module, enabled per tenant by that tenant's Shariah board configuration.** | Most Saudi institutions originate personal finance through commodity Murabaha with board approval. The old rule also broke the platform's own principle: anything a board can rule on is configuration, not code. |
| Embedded lending "deliberately not built" | **Embedded lending is a product module** with partner-originated applications and revenue-linked collection where the tenant's policy permits it | It is the fastest-growing origination channel in the Kingdom. |

What did **not** change, and must not:

- No floating point anywhere in the financial path. Money is minor-unit `bigint`; rates
  are integer basis points (`bp`, 1 bp = 0.01%). APR is stored as basis points too.
- No secret outside the vault. No credential, national identifier or CR-linked personal
  datum in any log, trace, metric or error body.
- No domain table in a PostgREST-exposed schema. Every table carries `tenant_id` and RLS.
- Tenant and channel are derived from the authenticated principal, never from the body.
- `Idempotency-Key` on every state-changing request; transactional outbox for every
  external side effect.
- No client or institution name in `core/` or `products/`.
- Inside `products/murabaha/`: no rate, no gate override, no clock read in sequencing,
  one leg one document, total never increases, late charges never income. Unchanged.

---

## 3. Product modules — `products/`

Each module is a directory with the same shape:

```
products/<module>/
  README.md          what it is, which regulation governs it, which board rulings it needs
  INVARIANTS.md      the module's own non-negotiables (may be stricter than the platform's)
  terms.ts           the product term sheet type (what a tenant configures)
  pricing.ts         quote → offer: amounts, schedule, and disclosure fields
  execution.ts       what happens between approval and booking (may be a state machine)
  disclosure.ts      the customer-facing figures SAMA requires for this product class
  index.ts           the ProductModule implementation registered with the engine
```

The engine talks to a module only through the `ProductModule` interface in
`core/products/module.ts`: `journeyShape` (`AMOUNT_FIRST` | `TRADE_FIRST`), `quote()`,
`validateTerms()`, `execute()`, `disclose()`. Nothing else. If a module needs something the
interface does not offer, extend the interface for every module, not with a special case.

| Module | Status | Governing rules to read first |
|---|---|---|
| `murabaha-scf` (Wasl) | **built** — moves from `core/sequencing`, `core/pricing`, `core/legs`, `core/obligation`, `core/ledger`, `core/trade`, `core/structures` into this directory with its invariants intact | Its own `INVARIANTS.md` (the former CLAUDE.md §1), AAOIFI SS 8 |
| `tawarruq-personal` | to build | SAMA Rules Regulating Consumer Finance; Responsible Lending Principles for Individual Customers (deduction ratios); the tenant board's tawarruq ruling; AAOIFI SS 30 |
| `bnpl` | to build | SAMA Rules for Regulating Buy Now Pay Later Companies (2023); credit-bureau query and reporting duty; consumer limits and affordability |
| `embedded-lending` | to build | Partner/aggregator entitlements (already in `config/tenants/*/origination/policy.json`); Responsible Lending Principles; board ruling OI-22/OI-23 where the tenant is Islamic |
| `conventional-term` | to build | SAMA Rules Regulating Consumer Finance; Finance Companies Control Law implementing regulations |

Regulation names above are the working titles; **confirm the current version and article
numbers against SAMA's rulebook before encoding a threshold**, and record the citation in
the module README. A threshold with no citation is a guess.

---

## 4. Rates, APR and the Rate Publisher

This is the section the old charter did not have. Read it carefully, because a rate is easy
to get subtly wrong and a wrong APR is a regulatory finding.

### 4.1 Representation

- A rate is `Rate = { bp: bigint; basis: 'FLAT' | 'REDUCING' | 'APR'; period: 'ANNUAL' | 'MONTHLY' }`
  in `core/pricing/rate.ts`. Never a `number`. Never a percentage string in the domain.
- Every rate is **effective-dated** and carries its **source**: `TENANT_CATALOGUE`,
  `RATE_PUBLISHER`, or `MANUAL_OVERRIDE` (which requires an approval tier and an audit
  event). No anonymous rate.
- A rate on an executed contract is a **snapshot**: copied at offer, immutable after.
  Repricing a live contract creates a superseding record, never an update.

### 4.2 APR

- **One function computes APR for the whole platform:** `core/pricing/apr.ts`. It implements
  the SAMA consumer-finance formula (the effective annual rate that equates the present value
  of disbursements and repayments, fees included). It is pure, integer-arithmetic, and
  tested against the worked examples in the SAMA annex plus edge cases (irregular first
  period, upfront fees, zero-rate BNPL with a merchant discount).
- A product module **does not** compute APR itself. It supplies the cash-flow schedule and
  fee list; the platform computes and stores APR next to the offer.
- `disclose()` on every consumer module must return, at minimum: financing amount, term,
  instalment amount, total cost of credit, total amount payable, APR, and every fee. The UI
  renders exactly these fields, in Arabic and English, before the customer accepts.

### 4.3 The Rate Publisher

Assumed as an external organisation's API that publishes benchmark rates and the market's
APRs by product class (other institutions' published consumer rates, SAIBOR, and policy
rates). It is consumed through the port `core/ports/rate-publisher.ts`:

- `benchmark(code, asOf)` — a reference rate at a date, for pricing formulas.
- `marketRates(productClass, asOf)` — the published APR range for a product class, for
  pricing guardrails and the comparison shown to the customer where the tenant enables it.
- Every response carries the publisher's `referenceId`, which is stored on the offer so the
  pricing can be reproduced. The adapter is `adapters/ksa/rate-publisher/`.
- The Rate Publisher **informs** pricing; it never sets the customer's rate directly. The
  tenant catalogue defines the rule (for example `benchmark + margin_bp`, bounded by the
  market range) and the platform applies it.
- If the publisher is unavailable, quotation for benchmark-linked products is refused with
  a typed `UNAVAILABLE` outcome. A stale rate is never used silently.

---

## 5. KSA integration rails — `adapters/ksa/`

All of these are to be built. Each adapter has the same anatomy, inherited from
`adapters/kernel/`: a capability-named port in `core/ports/`, a fixture transport for tests,
a live transport honouring the institution's forward proxy, a circuit breaker, credential
retrieval from the vault, and a `README.md` naming its verification item (the unknown that
only a sandbox call can answer).

| Rail | Port | What Sanad uses it for | Notes |
|---|---|---|---|
| **Nafath** | `identity-authentication` | National digital identity login and step-up authentication of the applicant; binding the applicant to a verified Iqama/National ID | NIC service. Also the anchor for e-signature intent. |
| **Yakeen** | `identity-verification` | Verification of identity attributes and address against national records | Elm service. Consent-gated. Never store more than the verification result and reference. |
| **Tahaqoq** | `document-verification` | Authenticity check of national digital documents and certificates presented by the applicant | Confirm the exact service scope with the provider before designing the adapter. |
| **SIMAH** | `credit-bureau` (existing port) | Consumer and commercial credit report, score, existing obligations for DBR; **mandatory reporting** of new facilities back to the bureau | Consent id required on every call. Reporting is an outbox job, never fire-and-forget. |
| **Bayan** | `credit-bureau` (second implementation) | Alternative licensed bureau; tenant chooses primary and fallback | Same port, adapter selected by tenant configuration. |
| **Wathq** | `counterparty-registry` (existing port) | Commercial registration, legal form, signatories, CR status for SME applicants | Ministry of Commerce data. |
| **GOSI** | `employment-verification` | Employment status, employer, registered salary for affordability and salary-assignment products | Consent-gated. Salary is stored as a snapshot with the GOSI reference. |
| **ZATCA** | `e-invoicing` (existing) + `tax-compliance` | FATOORA invoice clearance for trade products; Zakat/tax certificate status for SME eligibility | |
| **Open Banking** | `account-information`, `payment-initiation` | Affordability from transaction history (AIS); collection and disbursement instructions (PIS) under the SAMA Open Banking Framework | Through a licensed TPP or the institution's own OB connection; tenant-configured. |
| **SADAD** | `bill-collection` | Instalment presentment and collection through SADAD billers; reconciliation of paid bills | The institution's SADAD biller credentials; Sanad never becomes the biller. |
| **Payments Hub** | `payments` | Disbursement to the customer or the seller and collection sweeps via the institution's payments hub (SARIE instant payments, mada, internal transfer) | One port; the hub decides the rail. Every instruction is idempotent and outbox-driven. |
| **Rate Publisher** | `rate-publisher` | Benchmarks and market APRs — see §4.3 | |
| **Notifications** | `notifications` (existing) | SMS, email, push, by party reference | |

Rules for every rail:

- **Consent first.** Bureau, GOSI, Yakeen, Open Banking and Tahaqoq calls refuse a request
  without a `consentId` for that purpose (`core/consent/`). PDPL purpose limitation is a
  code path, not a policy document.
- **Snapshots, not copies.** Store the decision-relevant result and the provider's reference
  id. Do not mirror a bureau file or a bank statement into our tables.
- **Unavailability is a typed outcome**, surfaced as `SERVICING_UNAVAILABLE` with the attempt
  ledger the engine already has. A rail being down never approves anything.
- **No rail is called from the browser.** Server-side only, through the adapter, through the
  gateway where the institution requires it.
- **A fixture transport is not an integration.** An adapter's module entry stays `BLOCKED`
  until its live transport has made a verified call in a sandbox and the README records what
  was learned.

---

## 6. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | Next.js (App Router) + TypeScript | Arabic-first, RTL-first. See §9. |
| API gateway | IBM API Connect / DataPower | Integration layer; services stay independent of it. See §8. |
| Services | Node + TypeScript | One language across the stack. |
| Cache | Redis | Freshness windows, limit reservations, idempotency keys. |
| Database | PostgreSQL | Supabase for development only; in-Kingdom PostgreSQL from UAT (ADR 0001). **The in-memory stores are to be replaced now**, not later. |
| Workflow | Durable workflow engine, **to be selected in the first week** (Temporal or equivalent) | Multi-day origination and Murabaha sequencing both need it. |
| Secrets | Vault (Supabase Vault in development, in-Kingdom HSM-backed store in production) | See §7. |

---

## 7. Data, secrets and residency

- Domain tables live in `core`, `config`, `evidence`, `audit`, `products` schemas, never
  `public`. Supabase's exposed schema stays `public` only.
- Every table: `tenant_id uuid not null`, RLS with a tenant policy, `created_at`,
  `created_by`, `correlation_id`. Executed records are immutable; corrections supersede.
- Evidence and audit are append-only. No `UPDATE` grant.
- Credentials are stored via `config.set_integration_credential()` and read server-side
  via `config.get_integration_credential()`; every read is audited. Never commit, log,
  or return a key. See `docs/SAVING-CREDENTIALS.md`.
- All customer data is processed and stored in-Kingdom in every non-development
  environment (SAMA cloud and outsourcing rules, PDPL, NDMO). Residency is a
  `config.deployment_profile` property, asserted by a test.

---

## 8. Gateway — IBM API Connect, and independence from it

- No gateway-specific behaviour in application code. No gateway header is the sole source
  of identity; every service re-validates the caller and tenant.
- Gateway concerns live in `gateway/ibm/` as configuration. A second gateway gets its own
  directory, not a branch.
- Contract tests run against the service directly.
- The gateway transforms nothing. A gateway that normalises a body can change an amount or
  strip a control code.
- OpenAPI 3.1 is the source of truth; the 3.0 artefact for API Connect is generated by
  `npm run build:apic` and the non-expressible constraints are listed inside it.

---

## 9. Frontend

- **Arabic-first.** Compose RTL first, mirror to LTR. CSS logical properties only. A
  component not reviewed in RTL is not done.
- `<Money>` renders amounts. `<Rate>` renders rates and APR, in basis points converted for
  display only, never for arithmetic. They are separate components on purpose.
- **Journey shape comes from the product module.** An amount-first product opens with the
  amount; a trade-first product opens with the invoice. The wizard never assumes either.
- The consumer disclosure screen renders exactly the fields `disclose()` returns, in both
  languages, before acceptance, and the acceptance event records which disclosure version
  was shown.
- Both calendars wherever a date has contractual effect.
- Compliance and policy rejections render the control code into a respectful Arabic
  explanation. Never a generic decline.
- The frontend never infers a decision, a gate result or a price. All originate server-side.

---

## 10. Repo layout and the three-layer rule

```
core/          the engine: application, applicant, decisioning, workflow, documents,
               consent, exceptions, pricing (rate + apr), money, ports.
               NO product-specific contract logic. NO vendor names. NO client names.
products/      one directory per product module (§3). Owns its contract logic and invariants.
adapters/      kernel/ (shared) · tuum/ · nutrient/ · ksa/<rail>/ (§5)
config/        tenants/<tenant>/ product catalogue, credit policy, board positions,
               documents, origination policy, rate rules — data, not code, effective-dated.
apps/          Next.js surfaces: ops (workbench), sme (Wasl portal), consumer, admin
services/      origination API and the review API
gateway/       ibm/ API Connect definitions and Products
supabase/      migrations, RLS, functions (portable PostgreSQL)
test/          compliance/ · architecture/ · contract/ · adapters/ · unit/ · ui/
```

**Migration of the existing code is a real task, first on the list:** move the Murabaha
modules out of `core/` into `products/murabaha-scf/`, keep every one of their tests green,
and re-scope the SH-01 architecture test and the pre-tool hook to that directory. Nothing
is deleted; it is relocated and the ban is narrowed.

---

## 11. Testing

- **The adversarial compliance suite** (`test/compliance/`) stays and grows. Each test
  attempts a prohibited outcome and passes only when the attempt fails. It is parameterised
  per tenant configuration. The Murabaha cases move with the module. New cases:
  - approve without a bureau result, or with an expired consent
  - quote a benchmark-linked product with a stale or missing publisher rate
  - present an offer whose APR was not computed by `core/pricing/apr.ts`
  - exceed a tenant's deduction ratio or a BNPL consumer limit
  - book a facility without the bureau-reporting outbox event
  - disburse twice on one idempotency key
- **The architecture suite** asserts the absences: no vendor in `core/` or `products/`, no
  clock in Murabaha sequencing, no rate in `products/murabaha-scf/`, no float in
  `core/pricing`, no secret anywhere, no gateway dependency.
- **APR golden tests**: the SAMA worked examples, reproduced to the riyal.
- **Adapter tests** run against recorded fixtures; a live sandbox run is a separate,
  explicitly-invoked verification with its findings written to the adapter README.

---

## 12. Never do these

- Expose a domain table through PostgREST.
- Put a `number` in the financial path. Money and rates are `bigint`.
- Compute APR anywhere but `core/pricing/apr.ts`.
- Present a consumer offer without the full disclosure set.
- Call a bureau, GOSI, Yakeen, Open Banking or Tahaqoq without a consent id.
- Approve, quote or book when a required rail is unavailable.
- Store a secret anywhere but the vault; log or return one anywhere.
- Log, trace or error-message a national identifier, CR-linked datum or personal datum.
- Add a client's or vendor's name to `core/` or `products/`.
- Reintroduce a platform-wide ban on amounts, rates or Tawarruq. Those are module-scoped
  or tenant-scoped, by decision.
- Add an override path around a Murabaha sequencing gate.

---

## 13. Build order

1. **Relocate** the Murabaha modules into `products/murabaha-scf/`; narrow SH-01 and the
   hook; all 570 tests still green. Select the workflow engine. Replace the in-memory
   stores with PostgreSQL.
2. **Product engine**: `ProductModule` interface, product catalogue and term sheets in
   `config/`, `core/pricing/rate.ts` and `apr.ts` with golden tests, `<Rate>` and the
   disclosure screen.
3. **Rails, in the order decisions need them**: Nafath → Yakeen → SIMAH (query + reporting)
   → GOSI → Rate Publisher → Open Banking AIS → Bayan → Wathq → Tahaqoq → ZATCA tax status.
   Each: port, fixture transport, live transport, README with verification item.
4. **`tawarruq-personal`** end to end on a tenant whose board permits it, including the
   commodity broker port. Then **`bnpl`** with merchant onboarding and checkout API.
5. **Collections and money movement**: SADAD, Payments Hub, Open Banking PIS.
6. **`embedded-lending`** on top of the partner channel, then `conventional-term`.

Keep `apps/ops/src/server/modules.ts` truthful at every step: `LIVE`, `NOT_BUILT`, `BLOCKED`
with the reason. A navigation that lists only what works hides the product; one that lists
everything as if it worked is worse.

---

## 14. Definition of done

A change is done when: the compliance and architecture suites pass; RLS exists and is
tested for any new table; the OpenAPI spec is updated and contract tests pass; any new
consumer-facing figure goes through `disclose()` and the disclosure screen; the UI is
reviewed in RTL and LTR; no secret, identifier or personal datum appears in any log; every
regulatory threshold cites its source; and the second-client test has been asked and
answered in the PR description.
