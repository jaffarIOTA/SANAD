---
title: Pre-sales and Technical Pack
subtitle: What SANAD is today, what it is not yet, every decision taken and pending, and how to present, scope and deliver it in the Kingdom.
edition: Kingdom of Saudi Arabia
classification: Internal — IOTA pre-sales and delivery only
version: 1.0
date: 27 October 2026
---

## How to use this pack

:::internal Handling
This pack is for IOTA's pre-sales, solution architecture and delivery teams. Do not send it, or extracts of it, to a client or partner. Client-facing material is the Product Guide (KSA), the API Catalogue and the Datasheet. This pack names open security items, placeholder configuration, unverified integrations and unmerged work. That candour is the point of it, and it must not travel.
:::

It answers four questions:

1. **What exactly works today, and on what?** The status of every function, in the precise vocabulary engineering uses.
2. **What has been decided, what is waiting on someone, and what still needs a decision?** The full register, for KSA and platform-wide items.
3. **What does the institution have to bring?** Configuration, rulings, credentials and infrastructure.
4. **How do we present, scope and deliver it?** The RFP matrix, demo script, objections and the implementation plan.

The facts come from the product repository as at 27 October 2026: the module readiness map, `pending.md`, the ADRs, the security register and the adapter READMEs. Where they disagree, this pack says so.

## The status vocabulary

The Product Guide uses three client-facing words. Engineering uses four. This is how they map.

| Engineering status | Meaning | Client-facing word |
|---|---|---|
| **LIVE** | Built, works end to end against PostgreSQL, no external rail involved | Available |
| **LIVE on fixture rail** | Built and works, but the external rail answers from a labelled demonstration transport. Allowed only where the data class is synthetic; a real-data deployment returns `RAIL_UNAVAILABLE` and approves nothing | Available (rail integration-ready) |
| **BLOCKED** | Waiting on something outside engineering: a sandbox call, a licence, a board ruling, a provider | Integration-ready, or "on implementation of …" |
| **NOT BUILT** | Specified, not built | Planned |

:::warn Three facts to keep straight in every conversation
1. **No Saudi rail has made a verified live call.** All 13 KSA rail adapters run on fixtures. "Integration-ready" is accurate; "integrated" is not.
2. **Nothing runs in production for a real institution.** The hosted site (`sanad.iotatechnologies.io`, with `ops.` and `admin.`) is synthetic-only, on Azure UAE North. Development and UAT run on Supabase with synthetic data (ADR 0004).
3. **Most of October's work is in stacked pull requests #35–#73, awaiting the product owner's merge.** It runs on the development branch and the hosted site. It is not on `main`.
:::

## What works today in the Kingdom

### Products

| Product | Status | Notes for pre-sales |
|---|---|---|
| Wasl — Murabaha SCF | LIVE (rails on fixture) | The most complete module (W1–W6c). Trade-first. Booking account-shaped in Tuum (fixture until TUUM-ACCT-01) |
| Personal finance (Tawarruq) | LIVE (module); broker fixture | Deduction-ratio cap carries a **placeholder citation** (R-16). Consumer booking in Tuum needs the institution's own monthly-schedule product |
| BNPL | LIVE | The strongest-cited area (SAMA BNPL Rules, Nov 2023, Articles 19–27). Not modelled: the 20× capital portfolio limit (Article 22(4)) |
| Embedded lending | LIVE (module + partner reconciliation) | The partner settlement feed adapter is not built. Islamic embedded waits on board rulings OI-22/OI-23 |
| Conventional consumer term | LIVE | Deduction-ratio cap is a placeholder citation |
| SME term (conventional) | LIVE | SAMA SME definition cited. All credit policy ILLUSTRATIVE. Kafalah coverage placeholder |
| SME Tawarruq | LIVE module, disabled in config | BLOCKED: board ruling, ADR 0007 board view, commodity broker on fixture (KSA-RAIL-BROKER-01) |

### Journey functions

| Area | LIVE | LIVE on fixture rail | BLOCKED | NOT BUILT |
|---|---|---|---|---|
| Origination | Dashboard, key a request, review queue, partner API, embedded nomination, eligibility, decision engine, approval tiers, exceptions, consent | Bureau, affordability facts | — | Decision traces screen, credit policy screen, decisioning facilities/concentration screens |
| Counterparty | — | — | — | Onboarding, verification exceptions, screening hits, consents screen |
| SME (K1–K4) | Intake, pipeline, assessment, security, decision pack, offer letter, servicing | KYB checks; signing, disbursement and booking | Islamic SME (K4) | Contact-channel capture at intake (`OFFER_NOTICE_NO_CHANNEL`) |
| Documents | Upload, checklists, D1/D2/D4/D5 reading, viewer (evaluation mode) | D3 Tahaqoq authenticity | Generated documents (production Nutrient licence); signature and seal (OI-06) | Templates and versions; template drift screen (Wasl drift *check* is LIVE) |
| Wasl (W1–W6c) | Transaction book, facilities, concentration, programmes, goods register, obligations, returns, Shariah governance | Sequencing gates (ZATCA, TSA stand-in), acceptance (Nafath), booking (Tuum), seller payment, SADAD collection, reconciliation, late amounts, purification | — | Drawdowns, evidence workspace, financed-invoice registry screen, matching exceptions, reschedule, Wasl hardship, commodity brokers screen, Wasl bureau reporting |
| Servicing (S1–S4) | Position, manual receipts, late charges, hardship hold, restructuring, daily cycle | Collections (SADAD), bureau reporting | Temporal production cluster | Embedded revenue-linked collection |
| Shariah (W6a–W6c) | Approvals register, daily review and incidents, purification (ledger), audit workspace, Board report | Purification posting to core (fixture core) | — | Sealed PDF audit pack; refusal events counted in the report |
| Administration | Products, rails, credentials, partners, jurisdiction, concentration, programmes, goods | — | Staff SSO (OIDC built, live provider unverified); installation licence (issuer key at provisioning) | SAML; users and entitlements; configuration; tenants |

### Known discrepancies to handle carefully

- **Wathq.** The module map says NOT_BUILT; its adapter README says BLOCKED (fixture), and it runs in the KYB fixture flow. Present it as integration-ready, and expect the module map to be corrected.
- **`docs/STATUS.md` is stale** (25 September, partly updated about 8 October; it still quotes 679 tests). Use the module map and `pending.md`.
- **A real brand name appears as a partner id** in the illustrative Bank A origination policy. Never show that configuration file in a demo or screenshot.
- **Bank A and Fintech B are invented tenants.** Never call them clients.

## Go-live blockers for a Saudi institution

Each must be cleared before real customer data:

1. **Hosting in the Kingdom.** The IOTA Azure subscription has no Saudi region. Real KSA data needs the bank's in-Kingdom OpenShift, an in-Kingdom cloud the bank has SAMA approval for, or Azure Saudi Arabia East when it opens (announced for November 2026).
2. **Timestamping authority (E-04).** Without an accredited RFC 3161 TSA there is no Murabaha sale leg in production, and real-data deployments refuse to run on the host-clock stand-in (SR-006).
3. **Rail verification.** Each KSA-RAIL item against the provider sandbox with the institution's credentials.
4. **Shariah approvals recorded** in the W6a register by the institution's reviewers; board rulings for Tawarruq, late amounts, purification and ADR 0007.
5. **Regulatory placeholders (R-16).** The deduction-ratio cap and the SAMA APR annex worked examples, transcribed with citations.
6. **Security.**
   - No open High findings. SR-003 must close, and the expired SR-049 exception must be resolved.
   - Penetration test by an NCA-licensed provider.
   - SAMA outsourcing notification where IOTA hosts.
7. **Institution infrastructure.**
   - SSO live (IdP).
   - Production Nutrient licence, and a CSP signing certificate behind the HSM.
   - Tuum products and posting codes.
   - Production licence keys.
   - Temporal cluster.

## Decisions taken

Platform-wide decisions apply to both jurisdictions. KSA-specific ones are marked. **PO** is the product owner.

### Platform and architecture

| ID | Decision | Date | By | Effect |
|---|---|---|---|---|
| DT-01 | Re-charter: a product-agnostic origination engine with product modules and adapters; Wasl is the first module, not the platform | 25 Sep 2026 | PO (ADR 0002) | The second-client test governs every change |
| DT-02 | Amount-first applications allowed; each module declares its journey shape | 25 Sep 2026 | PO (ADR 0002) | BNPL, personal and term loans open with an amount; Murabaha with a trade |
| DT-03 | Rates are typed (`bp`, basis, period), effective-dated and sourced; snapshotted at offer. The no-rate rule is scoped to the Murabaha module | 25 Sep 2026 | PO (ADR 0002) | Rate-priced products possible and disclosed |
| DT-04 | One APR function for the platform; modules supply cash flows; full disclosure before acceptance | 25 Sep 2026 | PO (ADR 0002) | Every offer stamps which function computed its APR |
| DT-05 | Murabaha engine relocated into its module with every invariant and test intact | 25 Sep 2026 | PO (ADR 0002) | The rate ban and the hook are narrowed to the module |
| DT-06 | Unchanged invariants: no float in money; no secret outside the vault; no domain table in the exposed schema; `tenant_id` and RLS everywhere; tenant from the principal; Idempotency-Key and outbox; no client or vendor name in the engine or modules | 25 Sep 2026 | PO | Enforced by tests, Semgrep, a pre-edit hook and CI |
| DT-07 | Temporal as the durable workflow engine, self-hosted on the institution's OpenShift | 26 Sep 2026 | Engineering (ADR 0003) | Multi-day origination and Murabaha sequencing survive restarts |
| DT-08 | Supabase for development only; production is in-Kingdom PostgreSQL | 21 Sep 2026 | ADR 0001 | Schema stays portable; PostgREST is not used for domain data |
| DT-09 | Supabase also for UAT, on condition of synthetic data only | 5 Oct, confirmed 8 Oct 2026 | PO (ADR 0004) | A real-data pilot needs an in-Kingdom deployment |
| DT-10 | Two jurisdictions (KSA and UAE), chosen per deployment under four eyes and locked in production once there is business | 8 Oct 2026 | PO (ADR 0005) | Profiles set currency, regulator, calendars and permitted rails |
| DT-11 | Regulatory definitions held per jurisdiction as cited configuration | 8 Oct 2026 | PO (ADR 0005) | A threshold without a citation does not parse |
| DT-12 | Finish one journey end to end before other work: UAE SME first, then KSA | 12 Oct 2026 | PO | UAE M1–M6, then KSA K1–K4 |
| DT-13 | Business stages 1–4: both SANAD intake and the customer-record hand-over API | 12 Oct 2026 | PO | Institutions choose |
| DT-14 | Fixture transports allowed on the synthetic hosted site, labelled on screen; refused with real data | 12 Oct 2026 | PO | Full demonstrations without live rails |
| DT-17 | IBM API Connect and DataPower as the gateway; Kong removed; the bank's own DataPower in production; no gateway behaviour in code | Before 25 Sep 2026 | PO and client answers | OpenAPI 3.1 is the source; 3.0 generated for API Connect |
| DT-18 | Two deployment targets: IOTA's cloud first, then each institution's own in-Kingdom OpenShift | Before 25 Sep 2026 | PO and client answers | Nothing may depend on what cannot be reproduced on-premises |
| DT-19 | Wasl on real tables (`core.transaction` and its event log), state rebuilt from events | 17 Oct 2026 | PO | Migration 0027 |
| DT-20 | Everything waiting on someone kept in `pending.md` | 18 Oct 2026 | PO | Single source of open items |

### Regulatory and Shariah

| ID | Decision | Date | By | Effect |
|---|---|---|---|---|
| DT-21 | Tawarruq is a product module, enabled per institution by its board | 25 Sep 2026 | PO (ADR 0002) | No Islamic product enabled without a board ruling |
| DT-22 | No platform-wide ban on amounts, rates or Tawarruq; anything a board rules on is configuration | 25 Sep 2026 | PO | Boards that differ are named configuration keys |
| DT-23 | OI-22, OI-23, OI-24 open for Islamic institutions only, answered by configuration | 25 Sep 2026 | PO (ADR 0002) | They no longer block the platform |
| DT-24 | Shariah parameters under four eyes: structures and board positions as revision areas; excluded-goods register; approved template versions; risk-period floor (SR-025) | 9–10 Oct 2026 | Engineering | Murabaha refuses excluded goods and short intervals |
| DT-25 | Late amounts are a fixed amount per instalment (the module holds no rate); purification and late-amount rulings are per-institution board positions | 21 and 26 Oct 2026 | PO | `lateAmounts` and `purification` positions |
| DT-26 | Islamic late charges are charity, never income; Islamic restructuring keeps the total unchanged | 16 Oct 2026 | Charter (S3) | Conventional gets a fee, Islamic gets charity |
| DT-27 | BNPL follows the SAMA BNPL Rules (Nov 2023) and stays riyal-only | 2 and 8 Oct 2026 | Engineering, ADR 0005 | Articles 19–27 cited |
| DT-28 | **No approval in force, no new Islamic business** (SH-17); approvals recorded in the workbench by a Shariah reviewer, confirmed by a second | 26 Oct 2026 | PO (W6a) | A lapse is a date; executed transactions keep their approval |
| DT-29 | Two staff authorities: Shariah reviewer (acts) and Shariah auditor (read-only) | 26 Oct 2026 | PO | Mapped from the institution's IdP groups |
| DT-30 | Incident severities LOW/MEDIUM/HIGH/MATERIAL; an open MATERIAL incident before the sale stops the wa'd, purchase and sale offer | 26 Oct 2026 | PO (W6b) | Unwinding never stopped |
| DT-31 | Purification method is a board ruling (whole profit or assessed); confirmed by a second reviewer; raised as the profit is collected | 26 Oct 2026 | PO (W6b-2) | The incident closes only when purified in full, checked by the database |
| DT-32 | The audit workspace is read-only; the audit pack is JSON with a SHA-256 manifest; the Board report is printable and in JSON | 26 Oct 2026 | PO (W6c) | Defaults where the SDD is silent |
| DT-33 | Gregorian and Hijri (Umm al-Qura) dates wherever a date has contractual effect in KSA | Charter; 26 Oct 2026 | Charter, W6a | Approval dates stored Gregorian, Hijri displayed |

### Wasl — Murabaha SCF (KSA)

| ID | Decision | Date | By | Effect |
|---|---|---|---|---|
| DT-34 | Wasl workbench delivered as W1–W6, each its own PR | 17 Oct 2026 | PO | PRs #56–#73 |
| DT-35 | SME portal sign-in is Nafath bound to a configured signatory | 18 Oct 2026 | PO (W3) | Signatories later from Wathq |
| DT-36 | Booking is a SANAD obligation plus an account-shaped Tuum hand-over, never a loan contract | 18 Oct 2026 | PO (W3) | A Murabaha mapping to a loan product is refused |
| DT-37 | Late amounts: the cycle proposes, an officer assesses, a second person confirms; billed on its own SADAD bill; charity raised when collected; disbursed by two people | 21 Oct 2026 | PO (W4b) | Charity ledger write-once |
| DT-38 | Facilities proposed by credit, approved by a second person; no facility, no trade | 22 Oct 2026 | PO (W5) | Existing demo requests refused `NO_FACILITY` until approved |
| DT-39 | Three concentration rules; each institution chooses which apply and their values in Admin | 22 Oct 2026 | PO (W5) | Shares measured against limits |
| DT-40 | Programmes, anchors and the goods register editable in Admin under four eyes | 22 Oct 2026 | PO (W5b) | A goods change binds new transactions only |
| DT-41 | W6 split into W6a register, W6b checks/incidents/purification, W6c audit workspace/report | 26 Oct 2026 | PO | All built (#70–#73) |
| DT-42 | Shariah checks run daily and on demand; template drift by rebuilding each leg and comparing the hash | 26 Oct 2026 | PO (W6b-1) | Tenant task `SHARIAH_REVIEW` |
| DT-43 | Duplicate financing structurally impossible: the financed-invoice registry | Design Sep; DB 22 Oct 2026 | Charter, W5a | Unique in the database |
| DT-44 | Distributor finance must not use a commodity platform (a synthetic trade would be *hiyal*) | 22 Sep 2026 | IOTA solution architecture | Advice to boards regardless of ruling |

### Products — Tawarruq, BNPL, consumer, SME

| ID | Decision | Date | By | Effect |
|---|---|---|---|---|
| DT-45 | Consumer and embedded modules built and quoting end to end; none approves without a bureau enquiry; disbursement and bureau report queued once | From 25 Sep 2026 | Charter | — |
| DT-46 | SME modules built at the core banking partner's request; conventional enabled, Islamic disabled | 8 Oct 2026 | PO | Enabled through Admin with a second approval |
| DT-47 | KSA SME journey for both a bank (Islamic, once ruled) and a finance company (conventional); KYB via Wathq, Nafath, Yakeen, SIMAH, ZATCA; Nafath signing; payments hub; SIMAH at booking; SAIBOR pricing | 15 Oct 2026 | PO | K1–K4 (#41–#44) |
| DT-48 | ADR 0007: SME Tawarruq booked in Tuum as a loan contract; the deferred price stays authoritative in SANAD; reconcile or refuse; **board view required before go-live** | 15 Oct 2026 | PO (ADR 0007) | Fixture until the board's view |
| DT-49 | `sme-term-islamic` stays disabled in checked-in configuration until the ruling is recorded | 15 Oct 2026 | PO | Enabled only in tests |
| DT-51 | DSCR, revenue share and the new-enterprise ceiling are the institution's own policy, labelled; Kafalah as configuration | 8 Oct 2026 | Charter | ILLUSTRATIVE values shipped |
| DT-52 | Servicing S1–S4 next after UAE and KSA journeys | 16 Oct 2026 | PO | #45–#47, #55 |
| DT-53 | Saudi demonstration books for the two invented tenants | 17 Oct 2026 | PO | #54 |
| DT-54 | BNPL merchants: maker onboards, a different checker verifies on a store contract; one CR, one merchant | 6 Oct 2026 | Charter | Suspended merchants refused at checkout |

### Rails, Tuum and Nutrient

| ID | Decision | Date | By | Effect |
|---|---|---|---|---|
| DT-55 | Every rail is a port, a fixture, a live transport, a breaker, vault credentials and a README; **a fixture is not an integration** | 25 Sep 2026 | Charter | BLOCKED until a verified call |
| DT-56 | Consent first; adapters verify consent themselves (SR-026) | 25 Sep / 9 Oct 2026 | Charter | PDPL purpose limitation in code |
| DT-57 | Snapshots not copies; unavailability is typed; no rail from the browser; a rail down never approves | 25 Sep 2026 | Charter | — |
| DT-58 | KSA rail build order Nafath → Yakeen → SIMAH → GOSI → Rate publisher → Open Banking → Bayan → Wathq → Tahaqoq → ZATCA tax; then SADAD, payments hub, PIS | 25 Sep 2026 | Charter | All built on fixtures |
| DT-59 | The rate publisher informs pricing under the institution's rule; stale or missing refuses the quote | 25 Sep 2026 | PO (ADR 0002) | Reference stored on the offer |
| DT-60 | Bayan as a second bureau implementation; the institution chooses primary and fallback | 25 Sep 2026 | Charter | — |
| DT-61 | SADAD: the institution remains the biller. Payments hub: one port, the hub decides the rail | 25 Sep 2026 | Charter | — |
| DT-63 | Rails parsed against the catalogue narrowed to the institution's jurisdiction | 5 / 8 Oct 2026 | Engineering | A Saudi tenant cannot use a UAE rail |
| DT-64 | A rejected or returned payment is a dead letter, never delivered; re-release only after the payee is reconfirmed | 15 Oct 2026 | Engineering | SR-050 |
| DT-65 | Tahaqoq authenticity under a document-verification consent at Saudi intake | 19 Oct 2026 | PO (D3) | Unconfirmed documents need a written resolution |
| DT-66 | Tuum is the system of record after booking; SANAD for origination; reconciliation is a standing control | 8 Oct 2026 | PO (R-01) | — |
| DT-67 | Booking shape: Murabaha by account postings; rate-priced by the Tuum loan module with SANAD's rate reconciled | 8 Oct 2026 | PO, sandbox finding | Tuum derived rate 25 / APR 27.91 on an unrated offer |
| DT-68 | Tuum's product catalogue read-only in Admin | 8 Oct 2026 | Engineering | Mapping to core products |
| DT-69 | Document intelligence by rules over Document Engine text now; an LLM adapter later | 19 Oct 2026 | PO | D1–D5 (#60–#64) |
| DT-70 | **Always four eyes on documents**; findings assist the checker | 19 Oct 2026 | PO | No automatic acceptance |
| DT-71 | Document Engine in evaluation mode for development | 17 Oct 2026 | Engineering | Production licence open (R-02) |

### Deployment, security, licensing and brand

| ID | Decision | Date | By | Effect |
|---|---|---|---|---|
| DT-72 | Hosted on Azure Container Apps; Phase 1 synthetic; Phase 2 real data only after the go-live gate | 9 Oct 2026 | PO | Plan "Proposed"; Phase 1 built |
| DT-73 | Phase 1 in UAE North; three apps; no Application Gateway yet; Admin IP-allow-listed | 9 Oct 2026 | PO | Origination service and outbox worker deferred |
| DT-74 | No deployable Saudi Azure region in the IOTA subscription | 9 Oct 2026 | Recorded fact | KSA real data needs another path |
| DT-75 | Phase 2 edge is Application Gateway WAF v2 in-region; one deployment per jurisdiction | 9 Oct 2026 | Engineering | TLS ends in-region |
| DT-76 | `prod` branch protected by passing CI; PR with zero approvals for now | 9 Oct 2026 | PO | Differs from the plan's one review |
| DT-77 | Staff sign-in by generic OIDC, IOTA's Entra ID first; step-up before approvals | 9 Oct 2026 | PO | — |
| DT-78 | Installation licensing: signed, offline-verified, ANNUAL or POC; optional check-in | 9 Oct 2026 | PO (ADR 0006) | Implemented; ADR still "Proposed" |
| DT-79 | On expiry: grace, then no new business; servicing never refused | 9 Oct 2026 | PO (ADR 0006) | — |
| DT-80 | No cap on POC extensions; each is a new superseding licence | 9 Oct 2026 | PO | — |
| DT-81 | The licence issuer is internal tooling in a private repository | 9 Oct 2026 | ADR 0006 | Production key added at provisioning |
| DT-82 | Hosted jurisdiction changes only through Admin under four eyes | 12 Oct 2026 | PO | — |
| DT-83 | Security posture: NCA ECC-2:2024 (CSCC if critical), SAMA CSF, PDPL; ASVS L2, L3 for critical areas; CI gates block merge; finding SLAs | 8 Oct 2026 | PO, charter | Working assumptions: CSCC likely, CSF Level 3, no PCI |
| DT-84 | SR-049 (Nutrient viewer CVE) released under a time-boxed exception | 14 Oct 2026 (expired 21 Oct) | PO | See DP-37 |
| DT-85 | SR-001 rotated and closed | 10 Oct 2026 | PO | — |
| DT-86 | SME portal deployed only behind sign-in; deploying it is a separate decision | 9 / 18 Oct 2026 | PO | Behind sign-in since W3 |
| DT-87 | Interim brand mark from a purchased pack; not exclusive; licence unconfirmed | 10 Oct 2026 | PO | Use beyond the synthetic site is the product owner's call |
| DT-88 | Interim letterhead synthetic-only; institution letterhead marked OWNED | 10 / 17 Oct 2026 | PO | — |
| DT-89 | One typeface for both scripts (IBM Plex Sans Arabic); Arabic-first, RTL-first | 17 Oct 2026 | PO, charter | — |

## Decisions pending

Each item is waiting on someone. Items that block a Saudi go-live are in **bold**.

| ID | Item | Who must act | What is blocked |
|---|---|---|---|
| DP-01 | **Merge stacked PRs #35–#73** | Product owner | Everything since mid-October is off `main` |
| DP-02 | E-17: PostgreSQL on the bank's cluster, or the bank's Oracle/Db2 | Bank infrastructure | RLS, deferred and immutability triggers are PostgreSQL-specific |
| DP-03 | **ADR 0001 actions**: in-Kingdom region and managed services; production secret backend; in-Kingdom PostgreSQL; residency as a continuous control | Client infrastructure and security; IOTA platform | Production; any real-data pilot |
| DP-04 | E-01/E-02: five environments and DR RPO/RTO (RPO 0 recommended for evidence and audit) | Client and IOTA | Provisioning |
| DP-05 | E-22: API Connect on the bank's OpenShift or IBM Cloud SaaS | Client | Residency of integration flows |
| DP-06 | E-19: why is the SaaS core banking abroad if compute must be in-Kingdom? Same for documents | Client | Residency of accounts and contracts |
| DP-07 | Standalone Temporal worker; Temporal adapter on a server (KSA-WF-TEMPORAL-01) | Platform engineering | The cycle runs from the pipeline today |
| DP-08 | SME portal deployment | Product owner | Distributor self-service outside development |
| DP-09 | IBM API Connect dev instance "Plan limit reached" | IBM | Publishing to API Connect |
| DP-10 | **Record each institution's Shariah approvals in the W6a register** | Institution's reviewers and board | **No new Islamic business at all** |
| DP-11 | **Bank's SME Tawarruq board ruling** recorded in Admin | Board | `sme-term-islamic` disabled |
| DP-12 | **ADR 0007 board view** on servicing Tawarruq through a rate-carrying loan contract | Each Islamic board | Tawarruq booking fixture-only |
| DP-13 | Late-amount ruling: basis, grace, charities and accounts | Board | ILLUSTRATIVE `lateAmounts` |
| DP-14 | Purification ruling, including profit never collected | Board | ILLUSTRATIVE `purification`; incidents on hardship cannot close |
| DP-15 | OI-22: embedded Murabaha — who is the seller and what are the goods | Boards with the business | Islamic embedded nomination |
| DP-16 | OI-23: can a share-of-sales collection be determinate | Boards with credit risk | Islamic embedded collection |
| DP-17 | OI-24: commodity murabaha / organised Tawarruq conditions and caps | Boards | Commodity broker for merchant working capital |
| DP-18 | **R-16: placeholder citations** — deduction-ratio cap; SAMA APR annex examples; Kafalah coverage | IOTA and client compliance | Consumer Tawarruq and conventional cannot go live |
| DP-19 | Confirm revisions in force of cited regulations (SAMA SME definition, AML rules) | Compliance | Go-live |
| DP-21 | SEC-Q01–Q08 for the client CISO: CSCC classification, CSF level, PCI scope, NCA VAPT provider, SOC, regulator contacts, disclosure programme, who signs the clean chit | Client CISO | IR runbook, pen test, sign-off |
| DP-22 | SAMA outsourcing notification; IOTA meeting NCA CCC as a cloud provider | Institution; IOTA legal | Hosted real-data service |
| DP-23 | Approve at least one distributor facility per institution | Institution credit officers | Wasl trades refused `NO_FACILITY` |
| DP-24 | SADAD biller id; PAYMENTS_HUB and BILL_COLLECTION webhook secrets in the vault | Institution, operations | Wasl collections live |
| DP-25 | Shariah audit methodology and annual-report format | Institution's Shariah audit | Audit pack and report formats |
| DP-26 | **Sandbox credentials for every KSA rail** | Product owner / institution | Every rail BLOCKED |
| DP-28 | **E-04: accredited TSA** | Client / IOTA procurement | **No Murabaha sale leg in production** |
| DP-29 | Notification adapter and templates | Engineering and institution | Gap requests only recorded |
| DP-30 | TUUM-LEND-01: monthly-schedule products, rate override, reconciliation read-back | Tuum and institution | SME/Tawarruq booking fixture-only |
| DP-31 | TUUM-ACCT-01: posting codes and account types for Wasl | Tuum and the bank | Wasl booking live |
| DP-32 | Use of the Tuum loan module for Islamic products beyond SME Tawarruq | Product owner | Personal Tawarruq booking path |
| DP-33 | R-02: Nutrient licence scope and production key | Product owner, commercial | Generation, signature, reading beyond evaluation |
| DP-34 | V-04–V-08 and OI-06: a validated long-term signature from a licensed CSP | Product owner, engineering | Signature module |
| DP-35 | Live document reading on real Saudi samples; OCR for images | Engineering and institution | D1–D5 on live documents |
| DP-36 | **SR-040: the repository is public** — record as intended or make private | Product owner | Licence enforcement is removable in public source |
| DP-37 | **SR-049 exception expired 21 Oct 2026** — extend or remediate (High) | Product owner | Release gate |
| DP-38 | SR-047: who holds deployment-wide Admin authority | Product owner | Any institution's admin can act deployment-wide |
| DP-39 | SR-021: branch protection on `main` and signed commits | Product owner | Shariah structure files change through git alone |
| DP-40 | SR-003 (High), SR-006, SR-011, SR-024, SR-039, SR-022, SR-041 | Platform engineering; CISO for SR-039 | Real-data release |
| DP-41 | Renew the `APICAPIKEY` GitHub secret | Product owner | API Connect CI |
| DP-43 | Production licence issuer key at provisioning; the check-in server does not exist | IOTA | A production build starts no new business |
| DP-44 | ADR 0006 Q2: should the licence limit users or applications per month | Product owner | Commercial packaging |
| DP-45 | Azure plan approval; Phase 2 go-live gate items | Product owner | Hosted real-data service |
| DP-46 | Production OIDC with each institution's SSO | Institution IdP, engineering | Go-live |
| DP-47 | **An owned brand mark** to replace the interim one | Product owner | Marks in print, contracts and marketing |

## To be considered

| ID | Item | Why it matters |
|---|---|---|
| DC-01 | Re-run the Azure region check when Saudi Arabia East opens; record the KSA hosting choice as an ADR 0001 amendment | Earliest hosted KSA real-data date |
| DC-02 | E-16: confirm the bank's DataPower transforms nothing | An amount or control code could change |
| DC-03 | E-18: live transports must honour the bank's forward proxy | Every live rail and Tuum |
| DC-04 | E-05: executed documents cannot stay in Supabase Storage past development | Statutory retention |
| DC-05 | E-06: a UAT synthetic data generator | Realistic, lawful UAT |
| DC-06 | E-24: migrating a hash chain | Platform migration, DR |
| DC-08 | Should the stage SLA clock pause while a case waits on the applicant | SLA fairness |
| DC-09 | Capture contact channels at intake (`OFFER_NOTICE_NO_CHANNEL`) | Self-originated applications cannot be notified |
| DC-10 | Persistent exceptions queue for reconciliation; operations queues for late returns | Exceptions lost on restart |
| DC-11 | Move the charity liability posting to the outbox | Resilience |
| DC-12 | Record the payments hub's result for charity and purification disbursements | Evidence of payment |
| DC-13 | Make gate refusals events so the Board report can count them | Reporting completeness |
| DC-14 | Audit pack as a sealed PDF | Regulator-grade evidence |
| DC-15 | Browser review in RTL and LTR of the October screens (Definition of Done) | Not "done" until reviewed |
| DC-17 | Board answers become defaults (if all agree) or named keys (if they differ) | Avoid encoding one board in code |
| DC-18 | OI-12: early settlement relief (ibra') — automatic, on request, or not at all | Islamic early settlement |
| DC-19 | Purification of profit never collected | Incident lifecycle completeness |
| DC-20 | Boards accept "over-purified, never under" when a payment is returned after its share was raised | Ledger correctness |
| DC-21 | Wasl hardship: suspend collections, not only the late amount | SH-14 |
| DC-22 | **A release transition for a limit hold before the wa'd** (a transaction holding its limit when its approval lapses cannot move) | Operational lock-up; reviewed change in the Murabaha module |
| DC-23 | Facilities cannot be suspended; Wasl limits SAR only | Credit control |
| DC-24 | Version the institution's registration so a CR change does not read as template drift | False incidents |
| DC-25 | SIMAH reporting of Wasl facilities | Reporting duty |
| DC-26 | Murabaha contract legs as PDF; a viewer in the distributor portal | Customer-facing documents |
| DC-28 | Personal Tawarruq: agency by the institution; may the broker be the onward buyer | Product terms |
| DC-29 | Revisit "always four eyes" on documents once volume evidence exists | Throughput versus control |
| DC-30 | Production merchant credentials and distributor onboarding | Production onboarding |
| DC-31 | Each SME institution supplies its credit policy, board ruling, Kafalah agreement and a Tuum SME product | SME go-live |
| DC-32 | `prod` protection: one review and signed commits before real-data releases | Change control |
| DC-34 | DR geo-backups in-Kingdom | Residency |
| DC-35 | Key Vault re-implementation of the credential functions (largest Phase 2 item) | Hosted real data |

## Illustrative configuration

Every value below ships as a placeholder until the institution supplies its own. Each is labelled ILLUSTRATIVE or PLACEHOLDER in the repository.

| Area | What is illustrative |
|---|---|
| Wasl parties | Programmes, anchors and their IBANs, distributors, signatories, institution registration |
| Concentration | Single-trade cap SAR 5m (on), distributor share 25% (on), anchor share 70% (off) |
| Board positions | Approval references; risk-period floor (1 hour and 24 hours in the two tenants); excluded goods; approved template versions; late amounts (SAR 500 per instalment, 5 days' grace); purification (whole profit or assessed); invented charities with invented IBANs |
| Shariah approval references | SSB-A-2026-014, SSB-A-2026-021, SSB-B-2026-007, SSB-B-2026-003 |
| Core banking | Murabaha posting codes; Tuum loan product mappings (another partner's sandbox products) |
| Credit policy | SME assessment thresholds, scorecard, risk bands, security haircuts, decision-pack covenants, offer dates, servicing late charge (SAR 200 after 5 days), restructure ceiling, statement row labels |
| Documents | Document-type catalogues and content checks; letterhead (interim, synthetic only) |
| Product catalogues | **PLACEHOLDER** deduction-ratio citation; Kafalah coverage |
| APR golden tests | Analytically exact cases, not yet the SAMA annex worked examples |

## Rail verification plan

Each verification item is the unknown that only a sandbox call can answer. It is closed by a verified call and a written finding in the adapter's README.

| Item | Rail | What the sandbox must answer |
|---|---|---|
| KSA-RAIL-NAFATH-01 | Nafath | Request and callback shape; push or polling; whether it can anchor e-signature intent |
| KSA-RAIL-YAKEEN-01 | Yakeen | Request and response; consent artefact |
| KSA-RAIL-TAHAQOQ-01 | Tahaqoq | Service scope; what identifies a document to Tahaqoq |
| KSA-RAIL-SIMAH-01 | SIMAH | Purpose codes, consent reference format, reporting cadence and format |
| KSA-RAIL-BAYAN-01 | Bayan | As SIMAH |
| KSA-RAIL-WATHQ-01 | Wathq | Subscription scope, status codes, rate limits; signatories for Wasl |
| KSA-RAIL-GOSI-01 | GOSI | Consent artefact; salary figure or band; likely route through Wathq's MASDR service |
| KSA-RAIL-ZATCA-01 | ZATCA FATOORA | How a financier reads another taxpayer's cleared invoice (the demonstration stamp is waived on fixture only) |
| KSA-RAIL-ZATCA-02 | ZATCA tax | Zakat and tax certificate status by CR |
| KSA-RAIL-OB-01 / -02 | Open Banking | Which TPP; consent dashboard; aggregation; PIS shape |
| KSA-RAIL-SADAD-01 | SADAD | Biller registration; reconciliation feed format |
| KSA-RAIL-PAYHUB-01 | Payments hub | Hub API, purpose codes, idempotency |
| KSA-RAIL-RATEPUB-01 | Rate publisher | The publisher, its codes and references |
| KSA-RAIL-BROKER-01 | Commodity broker | Purchase, title and onward-sale evidence |
| TUUM-LEND-01 / TUUM-ACCT-01 | Tuum | See below |
| V-01 – V-08 | Nutrient | See below |
| KSA-WF-TEMPORAL-01 | Temporal | Sequences on a server; the institution's cluster |
| E-04 | TSA | An accredited RFC 3161 authority |

## Tuum integration — technical detail

**Ports.**
- `CoreBankingProvider`: party, accounts by purpose, `bookObligation` (fixed total, no rate), settlement, `postCharityLiability`, exposure, lifecycle.
- `LoanBookingPort`: `bookLoan` with SANAD's rate and APR in basis points.
- `CoreBankingProductCatalogue`: read-only.

The vendor name appears only in `adapters/tuum/`.

**Adapters.**
- `core-banking-adapter.ts` (accounts). It refuses a lending host, and an architecture test keeps any lending path out of the file. It re-checks total = cost + profit before posting the Murabaha receivable.
- `lending-adapter.ts`, the only lending path. It creates a legal person, then the contract with SANAD's rate and APR. It compares the echoed rate and refuses with `RATE_MISMATCH`. Decimals are written from bigint, never float.
- `product-catalogue.ts`: verified live on 8 October 2026 (76 products).
- `authentication.ts`: Tuum's own session scheme. A token in `x-auth-token`; a 200 response can carry errors.

**What has been verified.** Authentication and the product catalogue against Tuum's partner sandbox. Every booking runs on the demonstration transport.

**Sandbox finding 1** (8 October 2026). Tuum's loan module derives and stores a rate and APR even when none is supplied: an offer of 10,000 with a fixed profit of 500 came back at rate 25 and APR 27.91, totalling 10,433.93 rather than 10,500. This is why a Murabaha is booked account-shaped (DT-67).

**Open items.**
- **TUUM-LEND-01.**
  - The institution's own monthly-schedule products (no riyal sandbox product accepts one).
  - Whether a supplied rate overrides the price list.
  - How the servicing account is opened.
  - Whether `x-request-id` makes person and contract creation idempotent.
  - Whether accept, activate or initialise-disbursement calls are needed.
  - Reading back totals for the ADR 0007 reconciliation.
- **TUUM-ACCT-01.** The bank's posting codes for the receivable, settlement, inventory and charity; the collection account type; posting idempotency; that the receivable reconciles to SANAD's total.

**Not built.**
- The nightly reconciliation asserting booked total = cost + profit.
- Live wiring of the accounts adapter for Wasl.
- `instructSettlement`, `fetchExposure` and lifecycle events, which exist in the adapter but no feature calls.

**What the bank supplies.**
- Tuum tenant code and hosts.
- Employee credentials in the vault.
- Loan product codes with monthly schedules.
- Servicing account set-up.
- Posting codes and account ids for collection, charity liability and inventory.
- Back-office settings blocking top-up and amendment on Wasl contracts.
- Its board's ADR 0007 view.
- Commercial terms (OI-03).

## Nutrient integration — technical detail

**Ports.**
- `PdfGenerationPort.fromHtml`, used for offer letters.
- `DocumentSigningPort.sealPdf`, for the PAdES seal, returning its validation.
- `DocumentExtractionPort.extract`, for D1–D5 and statement figures.
- The document, signing and intelligence ports, which only `NutrientDocumentAdapter` implements, in tests.

**How the engine is reached.**
- Credentials come from the vault: engine URL, API token, JWT private key and Web SDK licence key, read on every call and never cached.
- HTTPS only, or HTTP on loopback.
- The viewer gets an RS256 JWT for one document, valid 300 seconds by default.

| Check | Question | Status |
|---|---|---|
| V-01 | Licence activates; licensed feature set | Viewer path proven; **demo key expired**; feature set unanswered |
| V-02 | Engine answers, server-only, token auth | Passed 17 Oct 2026 |
| V-03 | Round-trip fingerprint equality | Passed 17 Oct 2026 |
| V-04 | A validating signature (OI-06) | Plumbing passed at PAdES B-B with a self-signed development certificate; long-term validation needs a CSP timestamp and revocation |
| V-05 | Promissory note as a flattened form | Not run |
| V-06 | Extraction shape and confidence | English statement read correctly; **Arabic plain text garbled**; tables may merge |
| V-07 | The browser never holds a secret | Implemented and unit-tested; not run |
| V-08 | Redaction removes the bytes | Not run |

**Not built.**
- Leg rendering by template version.
- Drift comparison inside the engine.
- Archive, PAdES-LTV and redaction for external recipients.
- OCR of images.

**What the bank supplies.**
- A production licence (Web SDK and Document Engine) and an in-Kingdom deployment.
- A signing service in front of its HSM, with a licensed CSP certificate, timestamp and revocation.
- Its letterhead marked OWNED.
- Document catalogues tuned on real samples.
- Counsel's promissory-note form.

## Architecture for the technical team

| Element | Fact |
|---|---|
| Layers | `core/` engine; `products/` modules; `adapters/` vendors; `config/` data. The boundary is enforced by architecture tests |
| Apps | `apps/ops` workbench (hosts the origination and review APIs in development); `apps/admin`; `apps/sme` distributor portal; `apps/consumer` (with the checkout API) |
| Services | `services/origination` (partner API, eligibility, idempotency, tenant scope, audit verifier); `services/outbox` (dispatcher) |
| Ports | 36 capability ports in `core/ports/`, no vendor vocabulary, unavailability typed |
| Database | PostgreSQL. 35 migrations; 52 tables in `core`, `config`, `evidence` and `audit`, none in `public`. FORCE RLS; each transaction runs as `sanad_app` with the tenant set |
| Outbox | `core.outbox_event`, unique per tenant, kind and idempotency key; leased claims; DELIVERED, RETRY or DEAD |
| Audit | Per-tenant SHA-256 chain computed by a trigger; no runtime write grant; verified in SQL and in TypeScript (`npm run audit:verify`) |
| Time | `TsaInstant` built only from a verified RFC 3161 token; no TSA adapter yet; the host-clock stand-in is allowed only for synthetic data |
| Workflow | Temporal behind `core/ports/workflow.ts`; servicing schedule verified on a dev server |
| Gateway | IBM API Connect and DataPower as configuration (`gateway/ibm/`); OpenAPI 3.1 is the source; `npm run build:apic` generates 3.0 |
| Frontend | Next.js App Router, React, TypeScript; Arabic-first RTL; IBM Plex Sans Arabic; `<Money>`, `<Rate>` and `<Disclosure>` components |
| Containers | Multi-stage build running non-root; origination on UBI9; an OpenShift Deployment under `restricted-v2` |
| Tests | 183 test files: compliance 64, contract 31, unit 45, adapters 15, architecture 14, UI 14. As of 26 October 2026, about 2,275 tests passed against PostgreSQL and 2,186 in memory |

## Security posture and due-diligence answers

| Question | Answer | Open items to disclose only when asked, and accurately |
|---|---|---|
| Data residency | In the jurisdiction. Database constraint on the deployment profile. Development and UAT synthetic only | The IOTA Azure subscription has no Saudi region |
| Encryption in transit | TLS to the database; mTLS with SPKI pinning per rail; in-region TLS termination planned | A TLS version policy is not documented |
| Encryption at rest | Phase 2: customer-managed key in a managed HSM; sessions AES-256-GCM sealed | Current hosted disk encryption is the provider default |
| Tenant isolation | FORCE RLS, per-transaction role and tenant; BOLA and cross-tenant tests | **SR-003 (High) in remediation** until hosted apps connect as `sanad_runtime` |
| Audit | Hash chain, trigger-computed, dual verifier | Periodic scheduling outstanding (SR-011); external head anchoring for the Murabaha leg chain only |
| SSO | OIDC built (PKCE, nonce, JWKS, group mapping) | Live provider unverified; SAML not built |
| Four eyes | Database constraints on configuration, jurisdiction and licence; identity-based maker-checker | — |
| Secrets | Vault only, audited reads; Gitleaks over full history | Production secret backend undecided (DP-03) |
| AppSec | CodeQL, Semgrep (7 custom rules), Gitleaks, OSV, npm audit, dependency review, SBOM, Trivy, ZAP, compliance suite, database RLS job — all block merge | **SR-049 exception expired**; **SR-040 repository public**; SR-021 no branch protection on `main` |
| Penetration test | Required by an NCA-licensed provider | None engaged yet |
| DR and BCM | Target RPO 15 min / RTO 4 h; zone-redundant HA and point-in-time restore in the Phase 2 plan | No tested DR runbook yet |
| Incident response | Requirements defined, including a Shariah dimension | Plan and runbook not written; SIEM not integrated |
| Security register | 50 items: 39 closed, 8 in remediation, 3 open, no Critical (summary 14 Oct 2026) | Quote the register's own words, never a summary that softens it |

## RFP response matrix

Use the left column to find the requirement, the middle for the answer, and the right for what to promise.

| Requirement (typical) | SANAD's answer | Promise as |
|---|---|---|
| Shariah-compliant SME / supply-chain finance | Wasl Murabaha with three no-override gates, the financed-invoice registry, distinct parties, one leg one document | Available |
| Personal finance (Tawarruq) | Module with broker steps, deduction ratio and full disclosure | Available; broker and cap citation at implementation |
| BNPL compliant with the SAMA BNPL Rules | Module, merchant onboarding, checkout API, consumer checkout | Available |
| Conventional consumer and SME loans | Modules with platform APR and SAMA SME sizing | Available |
| APR and disclosure per SAMA | One APR function; disclosure before acceptance; version recorded | Available; annex examples transcribed at implementation |
| Maker-checker and approval tiers | Identity-based four eyes; tiers by amount; committee quorum | Available |
| Credit scoring and policy configuration | Closed policy language; scorecards and bands as configuration | Available |
| Document management and OCR | Upload, checklists, reading and checks with four eyes, viewer | Available; OCR of images planned |
| E-signature (Nafath) and digital seal | Nafath signing intent; PAdES seal | Integration-ready |
| Credit bureau (SIMAH / Bayan) incl. reporting | Bureau port with two implementations; reporting on the outbox | Integration-ready |
| Government rails (Yakeen, Wathq, GOSI, ZATCA, Tahaqoq) | All built on the same rail pattern | Integration-ready |
| Payments and collections (SADAD, payments hub) | Presentment, reconciliation, idempotent instructions | Integration-ready |
| Core banking integration | Tuum: account postings for Murabaha, loan contracts for rate-priced products | Integration-ready |
| Shariah governance and audit | Approvals register, daily checks, incidents, purification, read-only audit workspace, Board report | Available |
| Arabic UI and Hijri dates | Arabic-first RTL; Umm al-Qura beside Gregorian | Available |
| Data residency in the Kingdom | Enforced by the database; on the bank's OpenShift | Available on the bank's platform |
| NCA ECC and SAMA CSF alignment | Designed to them; controls listed | Designed to; certification is the bank's process |
| SSO (AD / Entra / SAML) | OIDC built | OIDC at implementation; SAML planned |
| Workflow and SLA | Temporal; per-state SLAs; triage | Available; Temporal cluster at implementation |
| APIs for partners | OpenAPI 3.1, mTLS + OAuth, idempotency, bilingual problems | Available |
| Reporting and dashboards | Dashboard, pipeline, Board report, exports | Available; regulatory reports by scope |

## Demonstration script (KSA)

Before every demonstration, confirm:
- the hosted site is set to the Kingdom (Admin → Jurisdiction);
- the synthetic data class is on;
- the development staff tokens for maker, checker, senior, committee, finance and the two Shariah reviewers are at hand;
- **Shariah approvals are recorded** for the demo tenant. Since W6a nothing Islamic originates without them, so record and confirm them first with the two reviewer identities;
- at least one distributor facility is approved.

| Step | Show | Say |
|---|---|---|
| 1 | Dashboard | "Everything here comes from records. No invented figure" |
| 2 | Key a Wasl request from a cleared invoice | "There is no amount box. The trade is the amount" |
| 3 | Review as a checker; try to approve your own work | "Refused, by identity, not by role" |
| 4 | Open the transaction; try to offer the sale before possession | "The gate refuses, and names the control. No role can override it" |
| 5 | Walk the gates: ownership invoice, possession evidence, the risk period | "Each step is attested and linked to the one before" |
| 6 | Accept in the SME portal as the distributor's signatory | "Nafath signs the offer's fingerprint" |
| 7 | Booking and collections; reconciliation | "Account postings in the core. No rate ever reaches it" |
| 8 | Shariah: approvals register; suspend an approval; try to open a new trade | "No approval in force, no new Islamic business" |
| 9 | Run the Shariah review on a tampered record (prepared) and open the incident | "The system re-checks itself every morning" |
| 10 | Audit workspace: draw a sample, replay, export the pack | "The Board verifies by itself" |
| 11 | Consumer: apply for personal Tawarruq; read the disclosure; accept | "Every figure SAMA requires, in both languages, before acceptance" |
| 12 | SME: pipeline, assessment trace, decision pack, offer letter PDF | "Every figure verified by a second person" |
| 13 | Admin: propose a product change as one admin, approve as another | "Configuration, not code, and four eyes on it" |

Say "Fixture" aloud when the on-screen label appears. Do not let a client believe a rail is live.

## Objections and answers

| Objection | Answer |
|---|---|
| "Is it integrated with SIMAH / Nafath / SADAD today?" | Every adapter is built and runs against a recorded simulation. The live connection is made with your credentials during implementation and recorded when verified. We will not call it integrated before that |
| "Can a senior manager override a gate in an emergency?" | No. A gate refuses a fact that is not true. The remedy is to record the evidence that makes it true, or to unwind |
| "Our board rules differently from another bank's." | The rulings are configuration under four eyes: risk period, excluded goods, templates, late amounts, purification. The software does not change |
| "Will rates appear on our Murabaha in the core?" | No. Murabaha is booked account-shaped. A rate-carrying loan contract is used only for rate-priced products, and for Tawarruq only with your board's view |
| "Where is our data?" | In the Kingdom, on your platform. The database refuses production data elsewhere |
| "What if your licence lapses?" | New business stops after a grace period. Servicing, collections, reporting and audit never stop |
| "Can we use our own core banking system?" | Yes, through a sibling adapter behind the same interface |
| "How do you handle APR?" | One function for the whole platform. No product computes its own |

## Implementation plan and client inputs

| Phase | Typical content | Institution inputs |
|---|---|---|
| 1. Assess and architect | Products, channels, rails, deployment, Shariah and credit positions | Product papers; credit policy; board positions; infrastructure answers (E-17, E-19, E-22) |
| 2. Design for compliance | Configuration: catalogue, policy, tiers, checklists, SLAs; regulatory citations confirmed | Approvals and rulings; deduction-ratio citation; SAMA annex examples; document samples |
| 3. Build and integrate | Rails verified; Tuum mapping; Nutrient; SSO; letterhead; TSA; signing | Sandbox credentials per rail; Tuum products and posting codes; Nutrient licence; CSP certificate and HSM; IdP; TSA |
| 4. Run and improve | UAT with synthetic data; pen test; go-live gate; operation | Pen-test provider; SAMA outsourcing notification; DR plan; SOC contacts |

**The institution's checklist:**
- **Shariah:** approvals for each Islamic product; rulings on late amounts and purification; the ADR 0007 view.
- **Credit and product:** credit policy and product papers; delegation of authority.
- **Documents:** document checklists and samples.
- **Rails:** sandbox and production credentials for each rail; SADAD biller id; webhook secrets.
- **Core banking:** Tuum tenant, products and posting codes.
- **Documents platform:** Nutrient licence; signing service and CSP certificate; letterhead.
- **Infrastructure:** IdP; TSA; OpenShift, PostgreSQL and HSM; API Connect.
