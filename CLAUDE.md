# Sanad / Wasl — Build Instructions

Shariah-compliant SME supply chain finance for the Kingdom of Saudi Arabia.
**Sanad** is the origination platform. **Wasl** is its first product.

Read `docs/Sanad-Wasl-Solution-Design-v0.2.pdf` before non-trivial work. This file is
the operative summary; the SDD is the specification. Where they disagree, the SDD wins
and this file gets fixed.

---

## 1. The non-negotiables

This product exists to make non-compliant transactions **structurally impossible**, not
merely discouraged. The rules below are not style preferences. Violating one is a defect
of the same severity as a data loss bug, and several are regulatory incidents.

### 1.1 There is no interest anywhere

Never introduce a column, field, type, variable, DTO or API parameter named or meaning:
`interest_rate`, `profit_rate`, `apr`, `accrued_interest`, `compounding`, `penalty_rate`,
`rate_index`, `margin`, or any synonym.

Return is expressed **only** as a profit *amount*:

```
sale_price_amount = cost_amount + profit_amount
```

fixed once at inception and immutable thereafter. A benchmark may inform how
`profit_amount` is calculated **at quotation time**; no rate is ever persisted against a
transaction and nothing recomputes an amount after execution.

**The absence is the control.** If the field does not exist, it cannot be misused.

### 1.2 The total never increases

No code path may increase an executed obligation's total. Reschedule endpoints accept new
dates and new instalment splits and **must reject any payload whose instalment sum differs
from the original total**. Enforce in the service layer *and* with a database constraint.

### 1.3 The sequencing gates cannot be bypassed

A Murabaha is only valid if the institution genuinely owned and possessed the goods, at its
own risk, before selling them. The state machine enforces this:

```
PURCHASE_EXECUTED
  → GATE 1  ownership evidence valid
OWNERSHIP_ACQUIRED
  → GATE 2  possession evidence valid
POSSESSION_CONFIRMED
  → GATE 3  risk period elapsed (external TSA clock, not server clock)
SALE_OFFERED
```

Rules:

- **No transition exists** from `PURCHASE_EXECUTED` or earlier directly to `SALE_OFFERED`.
  Model states as a discriminated union so the transition is not callable — a compile-time
  guarantee, not a runtime check.
- **No override role exists.** Not for underwriters, operations, admins or support. If you
  are adding an entitlement, it must not be capable of advancing a transaction past an
  unsatisfied gate. There is a test asserting no such entitlement can be defined.
- Gate evaluation is a **pure function** of (transaction, evidence set). No I/O, no clock
  reads inside it. This is what makes it replayable by the Shariah audit process.
- Risk-period elapse is measured against the **timestamping authority**, never
  `new Date()`, never a client-supplied value.

### 1.4 One leg, one document

Each contractual leg is a separate instrument, separately executed, separately timestamped,
hash-chained to its predecessor. The document service **must refuse** to render two legs
into one file. Enforce with a DB constraint: a document references exactly one leg.

### 1.5 Duplicate financing is impossible

`config.financed_invoice_registry` has a unique constraint on `(tenant_id, invoice_uuid)`.
Never add an `ON CONFLICT DO NOTHING` or a soft-delete that would let the same invoice be
financed twice. Records are never purged, including after settlement.

### 1.6 Late charges are never income

Late payment amounts post only to the segregated charity liability ledger. There must be no
code path, accounting mapping or report that routes them to revenue.

### 1.7 Anything a Shariah Board can rule on is configuration

Two client institutions, two sitting Shariah Supervisory Boards, and **they may rule
differently**. Risk-holding periods, evidence types, structure sequences, screening
registers, the *ibra'* basis, charity and purification treatment are all **tenant-scoped,
effective-dated configuration**.

If a difference between the two Boards would require a code change, the design is wrong at
that point. Parameterise it. See SDD §3.11.

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Frontend | **Next.js** (App Router) + TypeScript | RTL-first. See §6. |
| API gateway | **IBM API Connect** / DataPower | The integration layer. Services stay independent of it — see §5. |
| Cache | **Redis** | Freshness windows, limit reservation coordination, idempotency keys. |
| Database | **Supabase** (PostgreSQL) | See §3 — important constraints. |
| Services | **Node + TypeScript** | One language across the stack. |
| Secrets | **Supabase Vault** | Never a plain table. See §4. |

> **SDD deviation:** SDD §4.11 proposed JVM/.NET "aligned to the client's operational
> capability". TypeScript/Node is IOTA's build choice and is fine for the fintech client.
> A Tier-1 bank's infrastructure function may require a JVM runtime — flag at that point
> rather than relitigating now. The three-layer separation (§7) makes it survivable.

---

## 3. Supabase — read this before writing any table

Supabase is used as **PostgreSQL + Auth + transient storage**. It is not used as the
application backend.

### 3.1 PostgREST must never expose domain tables

This is the single most dangerous thing about this stack.

Supabase auto-generates a REST API over the `public` schema. If `transactions` or
`contract_legs` are reachable that way, a client can write directly to them — which is
exactly the gate-bypass path that §1.3 says must not exist. RLS is not sufficient: RLS
controls *who* can write a row, not *whether the state machine ran*.

**Therefore:**

- **No domain table lives in `public`.** Use schemas `core`, `config`, `evidence`, `audit`.
- Supabase's exposed-schema setting stays as `public` only. Never add `core` or `config`.
- `public` contains views and RPCs deliberately published, nothing else.
- All domain writes go through the Node service layer using the service role, server-side.
- The `anon` and `authenticated` roles have **no** grants on domain schemas.

### 3.2 Every table

- `tenant_id uuid not null` — every row, no exceptions.
- RLS enabled on every table, with a tenant-scoping policy.
- `created_at`, `created_by`, `correlation_id`.
- Executed records (`contract_leg`, `obligation`, `evidence`) carry an immutability flag
  with an `UPDATE`/`DELETE` trigger that raises. Corrections create superseding rows.
- Evidence and audit tables are **append-only**. No `UPDATE` grant at all.

### 3.3 Storage

Supabase Storage is acceptable for **transient uploads only**. Executed documents and
evidence artefacts go to S3-compatible in-Kingdom storage **with object lock** — Supabase
Storage does not provide write-once retention and the retention obligation is statutory.

### 3.4 Edge Functions

Not for the sequencing engine. Sequencing spans hours to days across external systems and
needs a durable workflow. Edge Functions are fine for webhooks and small stateless tasks.

---

## 4. Secrets and integration credentials

**Never** commit a key, never log one, never return one from an API, never put one in a
`.env` that is tracked, and never write one into a chat or an issue.

Tuum and Nutrient credentials are stored in `config.integration_credential`, which holds
**metadata plus a reference into Supabase Vault**. The plaintext lives only in Vault,
encrypted at rest. See `supabase/migrations/0001_integration_credentials.sql`.

To save a key:

```sql
select config.set_integration_credential(
  p_tenant      => '<tenant uuid>',
  p_provider    => 'TUUM',            -- or 'NUTRIENT'
  p_environment => 'sandbox',         -- sandbox | uat | production
  p_key_name    => 'api_key',
  p_secret      => '<the key>'
);
```

Run it from the Supabase SQL editor or a service-role connection. Never from the browser,
never from client code.

To read one, server-side only:

```sql
select config.get_integration_credential('<tenant>', 'TUUM', 'sandbox', 'api_key');
```

Every read is written to `audit.credential_access`. If you find yourself wanting to bypass
that, stop and ask why.

**Rules for code:**

- Credentials are fetched at adapter construction, cached in memory for a bounded TTL, and
  never held in a global.
- No credential value is ever interpolated into a log line, an error message, a trace span
  or a metric label. Redact at source.
- `config.integration_credential` has no `SELECT` grant for `anon` or `authenticated`.

---

## 5. Gateway — IBM API Connect, and independence from it

**IBM API Connect is the integration layer**, with DataPower as the gateway, for partner
integration, bank and vendor integration, and the platform's own APIs. The client runs
DataPower on its own OpenShift; we run API Connect for development and for the product's
own deployment.

Kong was carried as the development gateway while the client's choice was unknown, and has
been removed. A gateway configuration that nothing applies rots, and implies a tested
capability that is not tested.

The *independence* stays, and for a reason that outlives the choice: Sanad is a product,
deployed to each buying institution's own cluster under its own policy, and the second
institution may not run API Connect.

- **No gateway-specific behaviour in application code.** No gateway header read in a
  handler, no policy assumed to have run, no gateway admin API called from a service.
- Gateway concerns — rate limiting, routing, mTLS, request size, CORS — are declared in
  `gateway/ibm/` as configuration. A second implementation gets its own directory beside
  it; it does not get a branch.
- Every service **re-validates** the caller's identity and tenant independently. Never trust
  a gateway-injected header as the sole source of truth. This is both defence in depth and
  what keeps the gateway swappable.
- Contract tests run against the service directly, not through the gateway, so they stay
  valid across a gateway change.
- **The gateway transforms nothing.** DataPower is a transformation engine, so this is
  stated rather than assumed: a gateway that normalises JSON disables SH-01 by stripping
  the unknown property the service exists to reject; one that rewrites an error strips the
  control code a compliance rejection carries; one that transforms a body can change an
  amount.

---

## 6. Frontend

- **Arabic-first.** Compose RTL first, mirror to LTR. Use CSS logical properties
  (`margin-inline-start`, never `margin-left`). A component not reviewed in RTL is not done.
- **Never render a rate.** The `<Money>` component takes cost, profit and total. It has no
  prop for a rate and must not gain one.
- **Both calendars** wherever a date has contractual effect. Hijri and Gregorian are both
  stored; never convert at render time.
- **Start from the trade, not the amount.** The drawdown journey begins by selecting a real
  invoice or purchase order. There is no free-text amount input. This is the Shariah
  structure made visible — do not "simplify" it.
- Compliance rejections render the specific control code (`SH-10`, `SH-05`…) into a
  respectful Arabic explanation. Never a generic decline.
- Server state via a query library; transaction state always originates from the server.
  **The frontend never infers a gate result.**

---

## 7. Repo layout and the three-layer rule

```
core/        domain, structures, sequencing, decisioning, document orchestration
             NO client-specific code. NO vendor names. Ever.
adapters/    one per external system (tuum, nutrient, zatca, nafath, …)
             uniform capability-named interfaces, recorded fixtures, circuit breakers
config/      products, policies, templates, registers, workflows — data, not code
apps/        next.js surfaces (sme, anchor, ops, shariah, admin)
gateway/     ibm/ — API Connect definitions, Products, assembly
supabase/    migrations, RLS policies, functions
```

- **No client or institution name appears in `core/`.** CI greps for this.
- **The second-client test**, on every PR: *would the next client want this exact
  behaviour?* If no, it belongs in `config/` or an `adapter/`.
- No vendor DTO crosses out of `adapters/`. If Tuum's API needs a rate field, the adapter
  supplies a structural equivalent and records it as a known deviation — the concept does
  not enter `core/`.

---

## 8. API conventions

- REST, OpenAPI 3.1 authored **first**, implementation verified by contract test.
- `Idempotency-Key` header required on every state-changing request. Persist the response;
  replays return the original result.
- Money as minor-unit integers plus explicit currency. **No floating point in the financial
  path, ever.**
- Errors as RFC 9457 problem details with a machine code and bilingual message. Compliance
  rejections name the control that blocked the request.
- Tenant scope derived from the authenticated principal, **never accepted from the client**.
- Transactional outbox for every external side effect. Nothing lost, nothing duplicated.

---

## 9. Testing

Standard unit/integration/e2e, plus one suite that matters more than the rest:

**The adversarial compliance suite** (`test/compliance/`). Each test *attempts* a prohibited
outcome and **passes only when the attempt fails**:

- advance past an unsatisfied gate, as every role including admin
- finance an already-financed invoice
- execute a sale before possession is evidenced
- increase a total via reschedule
- post a late charge to income
- render two legs into one document
- transact with the same legal entity on both sides
- persist a rate against an executed transaction

This suite is **parameterised per tenant configuration** and runs against each institution's
own Board parameters. Never hardcode one Board's rulings into a test.

---

## 10. Never do these

- Expose a domain table through PostgREST.
- Add an override, force, or admin-bypass path around a sequencing gate.
- Store a secret anywhere but Vault.
- Log, trace, or error-message a credential, national identifier, or CR-linked personal data.
- Use `new Date()` to evaluate the risk period.
- Put production data in a non-production environment.
- Introduce a rate.
- Add a client's name to `core/`.

---

## 11. Definition of done

A change is done when: the adversarial suite passes; RLS policies exist and are tested;
the OpenAPI spec is updated and contract tests pass; the UI is reviewed in RTL **and** LTR;
no secret, identifier or personal datum appears in any log; and the second-client test has
been asked and answered in the PR description.
