# BRD gap analysis — Loan Origination System BRD v1.0 against the Sanad design

**As at 25 September 2026.** Source: `docs/Loan_Origination_System_BRD_v1.0.docx` (34 sections)
compared with the SDD v0.2, CLAUDE.md, and what is built.

> **Partly superseded 2026-09-25 by ADR 0002.** Section A's deviations for the *amount*, *products with pricing references*, *interest/rates* and *disbursement* no longer apply platform-wide: they remain true only inside the Murabaha product module. Those BRD items are now ordinary backlog for the Tawarruq, BNPL, embedded-lending and conventional modules. See `CLAUDE.md` §2.

---

## The one-paragraph answer

The BRD describes a **conventional, product-agnostic Loan Origination System**: a front door
that captures an amount, validates the applicant, and hands an approved application to a Loan
Processing System that books, disburses and services a loan. Sanad is a **Murabaha origination
platform**: a trading system that produces a financing outcome, in which the institution buys
identified goods, holds them at its own risk, and sells them at a disclosed profit — and in
which the sequencing that makes that valid happens *inside* the platform, not downstream.

So the comparison splits three ways. About **60% of the BRD is valid for us and largely
designed or built** (channels, maker–checker, decisioning, partner APIs, audit, idempotency).
About **25% is valid and genuinely missing** — these are the gaps, listed below, and they are
being filled. The remaining **~15% conflicts with the Shariah structure** and must not be
filled as written; those are named explicitly so nobody fills them by accident.

**Legend:** ✅ built · 🟡 designed or partial · ❌ gap, valid, to fill · ⛔ conflicts with the
design, do not fill as written · ➖ out of our scope or the BRD's own out-of-scope

---

## A. Deliberate deviations — do not "fix" these

| BRD says | Sanad does | Why the deviation is the design |
|---|---|---|
| §10 Application header carries an **amount** the maker captures; §29 step 4 "capture loan amount" | The journey starts by **selecting a cleared invoice**; the amount is a property of the trade and is never typed | §6. A Murabaha finances identified goods. An amount typed into a box is a loan with extra steps. This is the Shariah structure made visible. |
| §9 products: Personal, Auto, Mortgage, Salary-backed, POS… with "pricing references" | Products are **structures** (Murabaha variants) with a profit *amount* fixed at quotation; no rate is ever persisted | §1.1. A benchmark may inform the profit amount at quotation; nothing rate-shaped exists after. The absence is the control. |
| §3.2 "Interest accrual … out of scope" (i.e. exists downstream) | There is **no interest anywhere**, in any system Sanad writes to | §1.1, SH-01. Not a scope boundary — a prohibition. This is also why R-01 (Tuum as system of record) is open: Tuum's own accepted-offer response carries rate-shaped fields. |
| §4, §20, §31 LOS hands an **approved application** to the LPS, which processes, books, disburses, services | Approval opens a transaction in **DRAFT**; purchase, ownership, possession, risk-holding and sale are sequenced **in Sanad**; the core banking platform holds accounts, ledger and payments | §1.3. The gates cannot live downstream because no downstream system enforces them. "Approved" here means a file was opened, not that credit exists. |
| §31 "Disbursement" to the customer | The institution **pays the seller for goods**; the customer owes the sale price | Murabaha vocabulary. There is no disbursement to the customer. |
| §7 MC-010 approval hierarchy; §6 Credit Officer "within delegated authority" | Both are welcome for the **request** (who may approve raising a transaction) and are being added — but **no authority level, hierarchy or role may advance a transaction past an unsatisfied gate** | §1.3, §10. There is a test asserting no such entitlement can be defined. Filled below with that guard intact. |
| §12 eligibility: age, nationality, salary, employer, DBR | The decisioning engine is a **closed configurable rules DSL** over a snapshot; the criteria are SME/trade-shaped (CR, programme, exposure, invoice) | The *mechanism* matches the BRD exactly ("configurable, not hard-coded"). The retail criteria are not our product's. |

---

## B. Section by section

### §5 Origination channels
| | Status | Note |
|---|---|---|
| 5.1 Walk-in / branch, maker keys | ✅ | `MAKER_CHECKER`, three-step journey, four eyes enforced in the domain |
| 5.2 Embedded via partners/aggregators, secure API, retain partner identity + reference + channel | ✅ | `PARTNER_API`, `EMBEDDED_AGGREGATOR`; identification, `partnerReference`, channel retained; channel derived from the credential, never the body |
| 5.3 **Agent-induced** — agents/RMs/field officers initiate; agent auth; product entitlement, geographic restrictions, application limits configurable; maker/checker where required | ✅ **built** | A fourth door. New `AGENT_ASSISTED` channel with `AGENT` identification (agent id, licence/branch), tenant-configured entitlement (products, limits), four eyes required |
| Digital / direct | ✅ | `COUNTERPARTY_SELF` — the Wasl portal |

### §6 User roles
| | Status |
|---|---|
| Maker, Checker | ✅ |
| **Supervisor** — monitor queues, reassign, exceptions, SLA, escalate | ❌ → filling (SLA + breach view now; reassignment with the exception model) |
| **Credit Officer** — review referrals, manual assessment within delegated authority | 🟡 REFER exists in decisioning; no review role/screen. Delegated authority → filling as approval tiers |
| LOS Administrator — configure products, rules, workflows, users | 🟡 configuration is data in `config/`; admin screens `NOT_BUILT` |

### §7 Maker / Checker
| ID | Status | Note |
|---|---|---|
| MC-001 configurable roles | 🟡 | entitlement catalogue exists (`core/authz`) |
| MC-002 maker ≠ checker | ✅ | `FOUR_EYES_VIOLATED`, enforced in `approve()` not by a hidden button |
| MC-003 full action history | 🟡 | transitions retained; no consolidated action log on screen |
| MC-004 checker sees everything | ✅ | |
| MC-005 approve / reject / return | ✅ | |
| MC-006 return requires reason | ✅ | `RETURN_WITHOUT_REASON` |
| MC-007 returned keeps original ID | ✅ | `reopen()` preserves `requestId` |
| **MC-008 changes after return highlighted** | ❌ → filling | snapshot at return; diff on resubmit; checker sees what changed |
| **MC-009 material change triggers re-validation** | ❌ → filling | a material change (trade, amount-bearing fields, counterparty) re-runs `raise()` validation and resets servicing where the channel consults it |
| **MC-010 approval hierarchy configurable** | ✅ **built** | tenant-configured tiers by amount; a checker's authority must cover the request. Never a gate override. |

### §8 Customer management
| | Status | Note |
|---|---|---|
| Existing-customer retrieval from CIF; new-customer KYC | 🟡 designed (BR-B01, B03, B04, B08), `NOT_BUILT`; no CIF port yet | ❌ → **port to add**: `core/ports/counterparty-registry.ts`. Fields are SME (CR, legal form, signatories) not retail |

### §9 Product management
| | Status |
|---|---|
| Multiple products, each with configurable eligibility, workflow, documents, limits, approval | 🟡 structures + credit policy per tenant exist; one product (Wasl). **Document checklist per product** ❌ → filling. Approval authorities ❌ → filling (MC-010) |

### §11 Application status & lifecycle
BRD statuses mapped to ours:

| BRD | Sanad | Status |
|---|---|---|
| Draft, Submitted | `KEYING`, submitted → `AWAITING_*` | ✅ |
| Validation / Failed Validation | refused at `raise()` with a control code | 🟡 (no persisted "failed validation" state — refusal is immediate, which is stronger) |
| **Pending Documents** | `PENDING_INFORMATION` from `DOCUMENTS` | ✅ **built** |
| Maker Review / Checker Review / Returned to Maker | `KEYING` / `AWAITING_REVIEW` / `RETURNED_TO_MAKER` | ✅ |
| Credit Assessment | decisioning `REFER`, surfaced to the checker | 🟡 no separate state; a `REFER` is decided by a person holding the authority the tiers require |
| Approved for Processing / Rejected | `APPROVED` (→ transaction `DRAFT`) / `REJECTED` | ✅ |
| Submitted to LPS / LPS Accepted / Processing | transaction sequencing states (`DRAFT` … `SALE_OFFERED`) | ✅ different boundary, see A |
| **Pending Customer / Pending Partner** | `PENDING_INFORMATION` from `COUNTERPARTY` / `PARTNER` | ✅ **built** |
| **Integration Failure** | `SERVICING_UNAVAILABLE` with the attempt ledger | ✅ **built** — see §21 |
| Cancelled | `WITHDRAWN` | ✅ |
| **Expired** | `EXPIRED` | ✅ **built** (`EXPIRED`; tenant-configured TTL; evaluated against an attested instant, never `new Date()`) |

### §12 Eligibility · §16 Decision engine
| | Status |
|---|---|
| Configurable rules, not hard-coded | ✅ closed DSL, tenant policy versions |
| Outcomes Approve / Reject / Refer | ✅ `APPROVE` / `DECLINE` / `REFER`; failure mode is REFER |
| **Outcome: Additional Information** | ✅ **built** as `PENDING_INFORMATION`, requested by the checker. Deliberately not a fourth engine outcome: the engine says what it could not read (`REFER` + reason), a person decides what to ask for |

### §13 Credit bureau · §14 KYC / AML / sanctions / fraud
| | Status | Note |
|---|---|---|
| Bureau request after consent; store reference; controlled exception when unavailable | ✅ **port built** `core/ports/credit-bureau.ts`: `consentId` required on the request, `UNAVAILABLE` a typed outcome | adapter needs vendor access |
| Identity, KYC status, AML/sanctions/PEP, fraud screening | ✅ **port built** `core/ports/screening.ts`, consent-gated | adapter needs vendor access |
| **Duplicate application detection** | ✅ stronger: duplicate *financing* is structurally impossible (SH-10 registry, never purged) | |
| Identity mismatch, channel/agent risk | ❌ | with the screening port |
| Outcomes Clear / Refer / Reject / **Pending Investigation** | ✅ Pending Investigation is an open `CaseException` in `core/exceptions/` | |

### §15 Document management
| | Status |
|---|---|
| Upload, preview, versions (corrections supersede), validation, audit | 🟡 designed; Nutrient adapter with extraction confidence floor (BR-G08) |
| **Mandatory/optional checklist per product** | ✅ **built** — `config/tenants/*/documents/<programme>.json`, shown on the request |
| **Expiry tracking** | ✅ **built** — validity window per item, `EvidenceRecord.validUntil`, `EXPIRED` in the report |
| OCR / document intelligence, name/ID matching | 🟡 adapter exists; blocked on licence scope (R-02) |

### §17 Exception management
| | Status |
|---|---|
| Typed exceptions with severity, owner, SLA, resolution, resolver, audit | ✅ **built** — `core/exceptions/exception.ts`, append-only events; the "Verification exceptions" and "Matching exceptions" modules become views over it (screens not yet built) |

### §18 Partner & aggregator management
| | Status |
|---|---|
| Partner ID, **status**, credentials | ✅ status (active/suspended) in the tenant policy, enforced in the domain |
| **Products enabled, segments, geography, transaction limits** | ✅ programmes and per-request limit as tenant config, enforced in `raise()`; refused with `PARTNER_*` control codes |
| SLA configuration | ❌ → with §23 |
| Transaction/reference tracking | ✅ `partnerReference`, correlation id |

### §19 API requirements
| API group | Status |
|---|---|
| Application create / get / cancel | ✅ (cancel = withdrawal) |
| Application **update** | ⛔ partly — a submitted request is not editable by the partner; a returned one is. Scoped: update allowed only in `RETURNED_TO_MAKER` → filling |
| Status get | ✅ + webhooks designed in the 3.1 contract |
| **Eligibility check** (pre-check before raising) | ❌ → filling (`POST /eligibility` — runs the decisioning engine on a snapshot, returns outcome, persists nothing) |
| **Document upload / status** | ❌ → with document checklist |
| Customer lookup / validation / creation | ❌ with the counterparty-registry port |
| Partner validation / reference validation | ❌ → filling with partner config |

### §20 LPS integration · §21 Integration failure handling
| | Status | Note |
|---|---|---|
| Standardised interface, idempotent submission, returned reference | ✅ ports; `IdempotencyKey`; Tuum adapter maps `x-request-id` | boundary differs — see A |
| Pending state on failure | ✅ **built** (`SERVICING_UNAVAILABLE`) |
| **Retry count and timestamps recorded; failures visible to operations; manual resubmission controlled and auditable** | ✅ **built** — attempt ledger on the request, automatic retry within tenant policy, manual resubmission by a named person with a recorded note, *Integration failures* queue view |
| Idempotency prevents duplicates | ✅ | |

### §22 Notifications & consent
| | Status |
|---|---|
| Notifications (SMS/email/push) | ✅ port built `core/ports/notifications.ts` (by reference to a party, never an address); adapter and templates not built |
| Partner callbacks | ✅ webhooks in the contract |
| **Consent records** (type, version, datetime, channel, customer) | ✅ **built** — `core/consent/consent.ts`; bureau and screening ports refuse a request without a `consentId` |

### §23 SLA & queue management
| | Status |
|---|---|
| Configurable SLA per stage; breach alerts and escalation | ✅ **built** (breach shown in the queue, supervisor view; alerts/escalation need the notification port) — tenant-configured SLA per state; queue shows breach; Supervisor view |

### §24 Dashboards
| | Status |
|---|---|
| By channel · pending/aging | ✅ |
| By product/branch/partner/agent · approval/rejection/referral rates | 🟡 |
| Avg processing time · **SLA breaches** · maker/checker productivity · exception & integration-failure queues | 🟡 SLA breaches and the integration-failure queue ✅; exception queue and productivity later |

### §25 Audit & security
| | Status |
|---|---|
| Immutable audit trail | ✅ append-only, no `UPDATE` grant (designed in SQL) |
| Old/new values for material changes | ❌ → with MC-008 (the diff *is* this) |
| Integration request/response logging as permitted | 🟡 correlation everywhere; bodies never logged (may carry PII/credentials) |
| SSO / MFA | ❌ dev principals; enterprise SSO designed (SDD §4.7) |
| RBAC, least privilege, SoD | ✅ entitlements, four eyes |
| Encryption, API auth | ✅ designed / ✅ |
| Data masking | 🟡 stronger rule applies: identifiers and CR-linked data never reach a log or a problem body |

### §26 PDPL / SAMA / NDMO
✅ residency as a per-deployment property (`config.deployment_profile`, ADR 0001). PDPL purpose/consent → with consent records.

### §27 NFRs
Availability/performance targets ➖ agreed at design. Resilience 🟡 (circuit breaker, drain, health). Observability 🟡 (health; no tracing yet).

### §28 Requirements catalogue — rollup
✅ 001 002 009 012 013 018 · 🟡 003 008 010 011 017 019 · ❌ **004 005 006 007 014 015 016** · ➖ 020

### §32 Future enhancements
Digital signature and document intelligence are **core** for us, not future (one leg, one document, LTV signature — SH-07). The rest ➖.

---

## C. The gaps, prioritised — what is being filled and in what order

Ordered by: valid for a Murabaha platform · buildable in domain/config without an external system · value to the officer and the partner.

| # | Gap | BRD | Where it lands | Status |
|---|---|---|---|---|
| 1 | Agent-induced channel with agent identification and tenant-configured entitlement | §5.3, BR-014 | `core/origination/channel.ts`, `config/`, ops journey | **done** — `core/origination/policy.ts`, `config/tenants/*/origination/policy.json`, tests in `test/compliance/origination-policy.test.ts` |
| 2 | Request expiry — TTL per tenant, `EXPIRED` state, evaluated against an attested instant | §11 | `core/origination/request.ts`, `config/` | **done** — `core/origination/policy.ts`, `config/tenants/*/origination/policy.json`, tests in `test/compliance/origination-policy.test.ts` |
| 3 | Approval tiers by amount — a checker's delegated authority must cover the request; never a gate override | MC-010, §6 | `core/origination/request.ts`, `config/` | **done** — `core/origination/policy.ts`, `config/tenants/*/origination/policy.json`, tests in `test/compliance/origination-policy.test.ts` |
| 4 | SLA per stage, breach shown in the queue, Supervisor view | §23, §24 | `config/`, queue | **done** — `core/origination/policy.ts`, `config/tenants/*/origination/policy.json`, tests in `test/compliance/origination-policy.test.ts` |
| 5 | Partner status + entitlement (products, limits), enforced at the API | §18, §19 | `config/`, API | **done** — `core/origination/policy.ts`, `config/tenants/*/origination/policy.json`, tests in `test/compliance/origination-policy.test.ts` |
| 6 | Exception aggregate: type, severity, owner, SLA, resolution, resolver, audit | §17, §14 | `core/exceptions/` | **done** — `core/exceptions/exception.ts`: append-only events, `open/assign/note/escalate/resolve`, SLA breach against an attested instant, resolution mandatory; `test/unit/exceptions.test.ts` |
| 7 | Return with diff + re-validation on material change | MC-008/009, §25 | `core/origination/request.ts` | **done** — `resubmit()` in `core/origination/request.ts` keeps the identifier, diffs the fields, marks the change material if it touches a tenant-listed field (`revalidateOn` in `policy.json`), re-runs `raise()` and discards any earlier servicing answer; the diff is shown to the checker; `test/compliance/request-lifecycle.test.ts` |
| 8 | `PENDING_INFORMATION` (documents / customer / partner) + `NEEDS_INFORMATION` decision outcome | §11, §16 | domain | **done** — `PENDING_INFORMATION` (from COUNTERPARTY / PARTNER / DOCUMENTS, items, who asked, when); requested by the checker from review; returns to review when it arrives; withdrawable, expires; queue view *Awaiting information*. Not an engine outcome: the engine still has three, and a person asks for information — see §12 |
| 9 | `SERVICING_UNAVAILABLE` + retry ledger + integration-failure queue | §21, §11 | domain, outbox | **done** — `SERVICING_UNAVAILABLE` with an attempt ledger (`at`, `reason`, manual by/whom/note); automatic retry within `servicingRetry` (max attempts, backoff) per tenant; beyond that a named person resubmits with a recorded note; queue view *Integration failures*; `test/compliance/request-lifecycle.test.ts` |
| 10 | Document checklist per product + expiry | §15, §9 | `config/`, evidence | **done** — `core/documents/checklist.ts` + `config/tenants/*/documents/wasl-distributor.json`; per-item required/optional, validity window, `EvidenceRecord.validUntil`; report PRESENT / MISSING / EXPIRED / INVALID / PENDING shown on the request; `test/unit/checklist.test.ts` |
| 11 | Eligibility pre-check API (`POST /eligibility`) | §19 | contract + service | **done** — `POST /origination/v1/eligibility` in the 3.1 contract and the 3.0 artefact; `core/decisioning/eligibility.ts` runs the policy version in force over a snapshot; `persisted: false` in the type and on the wire; approve-for-less refers with `R_ELIGIBLE_BELOW_REQUESTED_AMOUNT`; `test/unit/eligibility.test.ts`. Development snapshot source until the adapters exist |
| 12 | Consent records + gate before bureau/screening | §22, §13 | domain | **done** — `core/consent/consent.ts`: typed, versioned, channel-bearing consent; withdrawal is a new record; `requireConsent()` refuses `CONSENT_MISSING`; the bureau and screening ports require a `consentId` on every request; `test/unit/consent.test.ts` |
| 13 | Ports for counterparty registry (CIF), credit bureau, screening, notifications | §8, §13, §14, §22 | `core/ports/` | **done — ports only** — `core/ports/{counterparty-registry,credit-bureau,screening,notifications,applicant-snapshot}.ts`; unavailable is a typed outcome, never a throw; `test/architecture/ports.test.ts` proves no rate-shaped or personal-identifier field. Adapters need vendor access |

Items 1–5 are built and tested; 6–13 follow. None of them touches a sequencing gate: `test/compliance/origination-policy.test.ts` asserts the sequencing modules use none of the policy's exports, and `openTransaction` still returns `Draft` and nothing later.

---

## D. Not gaps — explicitly out of scope on both sides

Loan servicing, repayment processing, collections, closure, GL accounting, post-disbursement servicing (BRD §3.2). For Sanad these are the obligation/lifecycle modules and the charity ledger, which exist in the domain but are outside *origination* in both documents.
