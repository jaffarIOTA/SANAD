---
title: Pre-sales and Technical Pack
subtitle: What SANAD is today in the Emirates, what it is not yet, every decision taken and pending, and how to present, scope and deliver it.
edition: United Arab Emirates
classification: Internal — IOTA pre-sales and delivery only
version: 1.0
date: 27 October 2026
---

## How to use this pack

:::internal Handling
This pack is for IOTA's pre-sales, solution architecture and delivery teams. Do not send it, or extracts of it, to a client or partner. Client-facing material is the Product Guide (UAE), the API Catalogue and the Datasheet. This pack names illustrative configuration, unverified integrations, open legal questions and unmerged work, and it must not travel.
:::

It answers four questions:

1. **What exactly works in a UAE deployment today?**
2. **What has been decided, what is waiting on someone, and what still needs a decision?**
3. **What does the institution have to bring?**
4. **How do we present, scope and deliver it?**

Facts are taken from the product repository as at 27 October 2026. The sources are the UAE jurisdiction profile, ADR 0005, the module readiness map, `pending.md`, the UAE adapter READMEs and the security register.

## The status vocabulary

| Engineering status | Meaning | Client-facing word |
|---|---|---|
| **LIVE** | Built, works end to end against PostgreSQL, no external rail involved | Available |
| **LIVE on fixture rail** | Built and works, but the external rail answers from a labelled demonstration transport. Synthetic data only; a real-data deployment returns `RAIL_UNAVAILABLE` and approves nothing | Available (rail integration-ready) |
| **BLOCKED** | Waiting on something outside engineering | Integration-ready, or "on implementation of …" |
| **NOT BUILT** | Specified, not built | Planned |

:::warn Four facts to keep straight in every UAE conversation
1. **The UAE offer is SME finance.** Conventional SME term finance is built. Islamic SME (Tawarruq) is built but blocked in the UAE. BNPL, consumer products, embedded lending and Wasl are Saudi-only and hidden in a UAE deployment.
2. **No UAE rail has made a verified live call.** All eight UAE rails run on fixtures modelled on published standards. Only object storage is verified (STORAGE-01).
3. **Every credit threshold in the UAE demonstration tenant is ILLUSTRATIVE.** The values come from the core banking partner's prototype screens of 8 October 2026, or are placeholders. Only two UAE regulatory figures are cited: the SME size definition and the beneficial-owner threshold.
4. **On `main`: only M1 (intake and KYB) and M2a (bureau, Open Finance and VAT on screen).** M2b–M6, servicing, the Nutrient work and document intelligence are in stacked PRs (#35–#40, #45–#55, #60–#64) awaiting the product owner's merge.
:::

## How a UAE deployment differs

| Aspect | UAE | KSA, for contrast |
|---|---|---|
| Jurisdiction | `AE`, chosen per deployment under four eyes; locked in production once there is business | `SA` |
| Currency | AED (fils); every money-bearing table refuses a row in another currency | SAR |
| Time zone | Asia/Dubai (UTC+4) | Asia/Riyadh |
| Contract calendars | **Gregorian only**; "confirm with counsel" | Gregorian and Hijri |
| Regulator | CBUAE. Which rules bind depends on the licence; recorded per tenant as `licenceType` (demonstration tenant: `DEVELOPMENT_FUND`) | SAMA |
| Registration | Trade licence plus issuing-authority code (DED, DET, ADDED, a free zone) | Commercial registration |
| Tax | 15-digit TRN, informational, never a KYB gap | ZATCA |
| SME size | Cabinet Resolution 22/2016 by sector | SAMA Circular 381000064902 |
| Pricing | Fixed catalogue rate (illustrative 150 bp reducing) | SAIBOR-3M plus margin through the rate publisher |
| Collections | Direct collection through the partner bank | SADAD bills |
| Document authenticity | No issuer service configured; reads "not checked" | Tahaqoq |
| Commodity broker | **None in the UAE profile** | Demonstration broker |
| Residency | Production in the UAE behind a customer-managed HSM (database constraint) | In the Kingdom |

**Navigation.** Saudi-tagged items are hidden in a UAE deployment: Wasl, transactions, programmes, BNPL, merchants, embedded, consumer products, the KSA rails group and Saudi SME. UAE-only items are the UAE rails group, UAE SME, document upload and booking in the loan system. Untagged items show in both. Settlement, Lifecycle and Shariah are untagged but describe Wasl behaviour. Expect questions, and explain that the Shariah approvals register also governs SME Tawarruq.

## What works today in the Emirates

### Products

| Product | Status | Notes |
|---|---|---|
| SME term finance (conventional) | **LIVE**, enabled for the demonstration fund | AED, amount-first, reducing balance, dated ACT/365 schedule matched to the core to the fil, platform APR, booking shape `CORE_FACILITY`, minimum AED 50,000 |
| SME finance (Tawarruq) | Module LIVE; **BLOCKED in the UAE** | Needs the fund's board ruling, an approval in force in the register, a UAE commodity broker rail and profile entry, and the ADR 0007 view |
| BNPL, consumer, embedded, Wasl | Not offered | BNPL stays riyal-only (ADR 0005) |

**Six variants** (from the partner prototype; unlisted values ILLUSTRATIVE):

| Variant | Max (AED) | Tenor (months) | Max grace | Owner contribution | Min years | Collateral |
|---|---|---|---|---|---|---|
| Small Loan | 1,000,000 | 6–36 | 0 | 0–100% | 0 | Personal guarantee; promissory note |
| Working Capital | 1,000,000 | 3–12 | 3 | 0–100% | 0 | As above |
| Fixed Assets | 2,000,000 | 12–60 | 6 | 20–100% | 1 | As above, plus pledge of the asset and insurance assigned |
| Expansion | 5,000,000 | 12–72 | 12 | 20–40% | 2 | As above |
| First-time Founders | 1,000,000 | 6–60 | 6 | 0–100% | 0 | As above |
| Advanced Tech & AI | 2,000,000 | 6–60 | 6 | 0–100% | 0 | As above |

### Lifecycle functions

| Stage | Function | Status |
|---|---|---|
| 1–4 | Upstream hand-over API (`business:write`), idempotent on `upstreamRef`; status API | LIVE |
| 1–4 | SANAD intake: licence, parties, consents | LIVE |
| 1–4 | NER, ICP, FTA, screening checks | LIVE on fixture rail |
| 1–4 | Beneficial-owner declaration (25%, cited); KYB gaps; hand-over to stage 5 | LIVE |
| 1–4 | Contact-channel capture at intake | **NOT BUILT** (`OFFER_NOTICE_NO_CHANNEL`) |
| 5 | Variant checklists (illustrative); upload with four-eyes validation | LIVE (STORAGE-01 verified) |
| 5 | D1 reading, D2 checks, D4 gaps, D5 throughput | LIVE (engine in evaluation mode; images and rendered Arabic not yet read) |
| 5 | D3 authenticity | Not available (no UAE issuer service) |
| 5 | Keyed figures with second-person verification; ratios | LIVE |
| 5 | Figures read from a statement | LIVE where the Document Engine is configured |
| 5 | AECB commercial report; Open Finance statement facts | LIVE on fixture rail |
| 5 | MOHRE / WPS | Adapter on fixture; **not wired to the journey** (WPS collected as a document) |
| 5 | Collateral and guarantor register; haircuts; `SECURITY_INCOMPLETE` gate | LIVE |
| 6 | Assessment: knock-outs, scorecard, risk bands, STP route | LIVE (all thresholds ILLUSTRATIVE) |
| 6 | Decision pack: memo, deviations, conditions, covenants, SHA-256 lock | LIVE |
| 6 | Committee with quorum by delegation; step-up re-authentication | LIVE |
| 7 | Quote and bilingual offer letter (Gregorian only, Arabic-Indic numerals) | LIVE |
| 7 | Offer PDF through Nutrient | BLOCKED (evaluation mode, watermarked; production licence) |
| 7 | Send offer by email and SMS on the outbox | LIVE (delivery templates not built) |
| 7 | UAE Pass signing intent bound to the letter hash; SOP1 refused | LIVE on fixture rail |
| 7 | Institution's PAdES seal | BLOCKED (OI-06) |
| 7 | Conditions precedent; payee IBAN with four eyes | LIVE |
| 7 | Disbursement and tranches through the partner bank; signed status webhook | LIVE on fixture rail (webhook LIVE) |
| 7 | Booking in Tuum as a loan contract | BLOCKED (no AED product; TUUM-LEND-01) |
| 8–9 | Position, receipts, reconciliation, partner-bank collection, AECB monthly status, late charges, hardship, restructuring, daily cycle | LIVE / LIVE on fixture rail; Temporal cluster at implementation |

**Pipeline targets (ILLUSTRATIVE, from the partner prototype):** upstream stages 1–4 within about 48 hours; credit assessment 5 days; committee 10 days; contract and disbursement 5 days. The end-to-end target is 23 days.

## Go-live blockers for a UAE institution

1. **Merge** the UAE and servicing PRs (DP-01).
2. **Rail verification** of the eight UAE rails and TUUM-LEND-01; **choose a screening vendor**.
3. **Tuum:** the fund's own AED loan product, replacing the placeholder `SME FINANCE AED`.
4. **Nutrient:**
   - a production licence (V-01);
   - signature validation with a licensed CSP (V-04 / OI-06);
   - extraction tested on real UAE samples (V-06).
5. **Fund policy** to replace every illustrative value: credit policy, product paper, checklists, rate card, offer and servicing policies, and the late-charge cap.
6. **Legal confirmation (DP-20):**
   - CBUAE applicability for the licence type;
   - the `HIGHER_OF_BOTH` SME reading;
   - the beneficial-owner article;
   - UAE data residency;
   - whether Hijri dates are needed on letters.
7. **Gaps:**
   - contact channels at intake;
   - notification templates;
   - live staff SSO;
   - the licence issuer key;
   - a TSA;
   - a Temporal cluster;
   - a vault provider code for Open Finance (migration).
8. **Hosting:** UAE North is permitted for UAE tenants. Phase 2 real-data items still apply: customer-managed key, Application Gateway WAF and the Key Vault credential functions.

## Decisions taken

### UAE-specific

| ID | Decision | Date | By | Effect |
|---|---|---|---|---|
| DT-10 | Two jurisdictions, chosen per deployment under four eyes; locked in production once there is business; each tenant keeps its onboarded jurisdiction and currency | 8 Oct 2026 | PO (ADR 0005) | Triggered by the core banking partner's request for UAE SME lending |
| DT-11 | UAE regulatory definitions as cited configuration: Cabinet Resolution 22/2016 (SME size), Cabinet Decision 58/2020 (beneficial ownership, 25%) | 8 Oct 2026 | PO (ADR 0005) | Uncited thresholds do not parse |
| DT-12 | UAE SME end to end first (M1–M6), then KSA | 12 Oct 2026 | PO | PRs #28, #33, #35–#40 |
| DT-13 | Stages 1–4 in SANAD **and** the upstream hand-over API | 12 Oct 2026 | PO | Institutions choose |
| DT-14 | Fixture transports on the synthetic hosted site, labelled; refused with real data | 12 Oct 2026 | PO | Full UAE demonstrations |
| DT-27 | BNPL stays riyal-only | 8 Oct 2026 | ADR 0005 | Not offered in AED |
| DT-33 | Gregorian governs UAE contracts; Hijri not on the letter (to confirm with counsel) | 8 Oct 2026 | Jurisdiction profile | — |
| DT-50 | UAE booking shaped to Tuum's model only; Tuum vocabulary stays in the adapter; one lending path | 12 / 15 Oct 2026 | PO | Fixture until an AED product exists |
| DT-62 | UAE rails built on fixtures, modelled on named public standards, BLOCKED until sandbox verification | 8 / 12 Oct 2026 | PO (ADR 0005) | AECB, UAE Pass, ICP, NER, MOHRE, FTA, partner bank, Open Finance |
| DT-63 | Rails parsed against the catalogue narrowed to the jurisdiction | 5 / 8 Oct 2026 | Engineering | A UAE tenant cannot use a Saudi rail |
| DT-64 | Rejected or returned payments are dead letters; the payee is reconfirmed before re-release (SR-050) | 15 Oct 2026 | Engineering (M5b) | — |
| DT-73 / DT-74 | Phase 1 hosted in UAE North; UAE tenants may be hosted there; one deployment per jurisdiction | 9 Oct 2026 | PO | KSA real data needs a different path |

### Platform-wide decisions that apply in the UAE

These are summarised here. The KSA pack holds them in full.

| ID | Decision |
|---|---|
| DT-01 – DT-06 | Re-charter as a product-agnostic engine; amount-first journeys; typed sourced rates; one APR function; the unchanged invariants (no float, vault only, RLS, tenant from the principal, idempotency and outbox, no client or vendor name in the engine) |
| DT-07 | Temporal as the workflow engine, self-hosted |
| DT-08 / DT-09 | Supabase for development and UAT on synthetic data only; production on PostgreSQL in the jurisdiction |
| DT-17 / DT-18 | IBM API Connect and DataPower; IOTA's cloud first, then the institution's own platform |
| DT-21 / DT-22 / DT-28 – DT-31 | Tawarruq enabled per board; no approval in force, no new Islamic business; Shariah reviewer and auditor authorities; incidents; purification |
| DT-26 | Islamic late charges are charity; Islamic restructuring keeps the total unchanged |
| DT-45 / DT-46 / DT-51 | SME modules built; conventional enabled, Islamic disabled; DSCR, revenue share and new-enterprise ceiling are institution policy |
| DT-52 | Servicing S1–S4 |
| DT-55 – DT-57 | Rail anatomy; consent first; snapshots; typed unavailability; no rail from the browser |
| DT-66 – DT-68 | Tuum is the system of record after booking; rate-priced products booked by the loan module with SANAD's rate reconciled; Tuum catalogue read-only in Admin |
| DT-69 – DT-71 | Document intelligence by rules now, LLM later; **always four eyes on documents**; Document Engine in evaluation mode for development |
| DT-72 – DT-83 | Azure Container Apps; WAF in-region; OIDC staff sign-in; installation licensing (grace, then no new business; servicing never refused); security posture |
| DT-87 – DT-89 | Interim brand mark (licence unconfirmed); interim letterhead synthetic only; IBM Plex Sans Arabic |

## Decisions pending

| ID | Item | Who must act | What is blocked |
|---|---|---|---|
| DP-01 | **Merge the stacked PRs** (UAE M2b–M6 #35–#40; servicing; Nutrient; D1–D5) | Product owner | Everything after M2a is off `main` |
| DP-19 | Confirm the revisions in force of Cabinet Resolution 22/2016 and Cabinet Decision 58/2020 | Compliance | Go-live |
| DP-20 | **CBUAE applicability by licence**; the `HIGHER_OF_BOTH` SME reading; **UAE data residency**; Hijri on letters | The fund and counsel | UAE production |
| DP-27 | **UAE rail verification**: UAE-RAIL-UAEPASS-01, -ICP-01, -NER-01, -AECB-01, -FTA-01, -MOHRE-01, -OPENFINANCE-01, -PARTNER-BANK-01 | Product owner / the fund | Every rail BLOCKED |
| DP-30 | **TUUM-LEND-01**: the fund's AED product; whether a supplied rate overrides the price list; servicing account; idempotency; read-back totals | Tuum and the fund | Booking fixture-only |
| DP-33 / DP-34 | Nutrient production licence; validated long-term signature (V-04, OI-06) | Product owner, commercial | Offer PDF beyond evaluation; seal |
| DP-35 | Live document reading on real UAE samples; OCR for images | Engineering and the fund | D1–D5 on live documents |
| DP-10 – DP-12 | For Islamic SME: board ruling, approval recorded, ADR 0007 view | The fund's board | `sme-term-islamic` in the UAE |
| DP-36 / DP-37 | SR-040 public repository; **SR-049 exception expired 21 Oct 2026** (High) | Product owner | Release gate |
| DP-38 | SR-047: deployment-wide Admin authority | Product owner | Jurisdiction and licence administration |
| DP-40 | SR-003 (High) and the other open security items | Platform engineering | Real-data release |
| DP-42 | The hosted deployment had an **undecided proposal to switch to AE** (9 Oct 2026) | A second administrator | UAE screens on the hosted site |
| DP-43 / DP-46 | Licence issuer key at provisioning; production OIDC with the fund's IdP | IOTA; the fund | Go-live |
| DP-45 | Azure Phase 2 go-live gate | Product owner | Hosted real data |
| DP-47 | An owned brand mark | Product owner | Print and contracts |
| — | A screening vendor for sanctions and PEP | Product owner and the fund | Real-data screening |
| — | A UAE commodity broker rail and its profile entry | Product owner and the fund | UAE Islamic SME |

## To be considered

| ID | Item | Why it matters |
|---|---|---|
| DC-02 / DC-03 | Confirm the fund's gateway transforms nothing; live transports honour its proxy | Integrity of amounts and control codes |
| DC-05 | A UAT synthetic data generator | Lawful, realistic UAT |
| DC-07 | Tuum through API Connect as an egress pipe | Gateway scope |
| DC-08 | Pause the SLA clock while waiting on the applicant | SLA fairness |
| DC-09 | **Capture contact channels at intake** | Intake-originated applications cannot be notified |
| DC-10 | Persistent reconciliation exceptions queue | Exceptions lost on restart |
| DC-15 | Browser review in RTL and LTR of October's screens | Definition of Done |
| DC-29 | Revisit "always four eyes" on documents once volume evidence exists | Throughput |
| DC-31 | The fund supplies credit policy, board ruling, guarantee agreement and a Tuum AED product | SME go-live |
| — | **Wire MOHRE/WPS into the assessment** rather than collecting the report as a document | Affordability evidence |
| — | A UAE document authenticity service if one becomes available | D3 parity with KSA |
| — | Rename the Saudi-named port fields that carry the UAE licence and TRN (ADR 0005 naming debt) | Maintainability |
| — | An applicant-facing portal for UAE applicants | Self-service |

## Illustrative configuration (UAE demonstration fund)

| Area | Illustrative values |
|---|---|
| Tenant | `jurisdiction: AE`, `licenceType: DEVELOPMENT_FUND`, `baseCurrency: AED` |
| Catalogue | Six variants above; rate 150 bp p.a. reducing (`CATALOGUE_RATE`); no admin fee |
| Module credit rule | Sizes micro, small and medium; DSCR ≥ 1.40×; financing ≤ 100% of revenue; ceiling without revenue history AED 1m |
| Knock-outs | Bureau score ≥ 650; DSCR ≥ 1.40; current ratio ≥ 1.30; sales growth ≥ 2%; owner DBR ≤ 50% |
| Scorecard | Applicant 40% (bureau, DBR, experience, equity); project 60% (sector, profitability, audited financials, years, commitment, risk, portfolio repayment, failed files) |
| Risk bands | Very low ≥ 85 (AED 3m, 15% equity); low ≥ 70 (AED 2m, 20%); medium ≥ 55 (AED 1m, 25%); high ≥ 40 (AED 500k, 30%) |
| STP | ≤ AED 500k, very low or low risk, collateral cover ≥ 120% |
| Committee quorum | One approval to AED 2m; two above; one more for high risk |
| Haircuts | Real estate 30%; vehicle, equipment or financed asset 50%; inventory 60%; receivables 40%; cash 0%; valuation ≤ 365 days |
| Covenants | DSCR ≥ 1.40× annual; current ratio ≥ 1.00×; audited financials within 120 days; quarterly VAT returns; no further borrowing; no ownership change |
| Offer policy | Disbursement within 60 days (default 14); first due 15–45 days; offer valid 30 days |
| Servicing | Late charge AED 200 after 5 days' grace (regulator's cap to be applied); AECB reporting day 5; daily cycle 06:00 Gulf time |
| Documents | Six checklists (version `0.1.0-illustrative-2026-10-08`); document-type catalogue `2026-10-19.2` |
| Rails | All 12 configured rails `enabled: false`, sandbox |
| Core banking | `sme-term-conventional` → `SME FINANCE AED` (**placeholder; no AED product in the sandbox**) |
| Seed | Licence refs `TL-ILLUS-nnnn`; registration match reads UNREADABLE by design. The seed runs only outside production |

## Rail verification plan (UAE)

| Item | Rail | Modelled on | What the sandbox must answer |
|---|---|---|---|
| UAE-RAIL-AECB-01 | AECB | A common bureau layout (assumed) | Commercial and individual report shapes; consent artefact; reporting format and cadence |
| UAE-RAIL-UAEPASS-01 | UAE Pass | docs.uaepass.ae (published) | Signing flow and signer statuses; assurance levels; callback |
| UAE-RAIL-ICP-01 | ICP (Emirates ID) | UAE Pass attribute names; envelope assumed | Access route, request envelope, consent |
| UAE-RAIL-NER-01 | NER | NER published fields; a companies-register API pattern | Access, licence status vocabulary, officers and controllers |
| UAE-RAIL-MOHRE-01 | MOHRE (WPS) | WPS SIF | Access for a lender; the 85% compliance rule's article |
| UAE-RAIL-FTA-01 | FTA | A VAT-number check pattern | Whether a lender can check a TRN; response shape |
| UAE-RAIL-PARTNER-BANK-01 | Partner bank | ISO 20022 pain.001 / pain.002 / pacs.002 (JSON analogue) | API, direct-debit mandate, status reporting, idempotency |
| UAE-RAIL-OPENFINANCE-01 | UAE Open Finance | CBUAE Open Finance Standards v2.1 AIS (published) | Participation route (TPP or the fund's own); consent dashboard |
| TUUM-LEND-01 | Tuum | Tuum API (sandbox seen) | See below |
| V-01 – V-08 | Nutrient | Vendor | See below |
| STORAGE-01 | Object storage | S3-compatible | **Verified** 15 Oct 2026 |

Common to every UAE adapter:
- Dirhams are converted at the boundary by digit manipulation; fractional numbers are refused.
- An unknown value fails closed.
- Consent is checked first for AECB, ICP, MOHRE and Open Finance.
- Each adapter has a circuit breaker and reads its credentials from the vault.

The demonstration transport holds three synthetic companies with owners, bureau files, WPS records and 12 months of statements. It refuses real data.

## Tuum integration in the UAE

- **What is booked.** A disbursed, rate-priced loan, as a loan contract on the signed terms, through `adapters/tuum/lending-adapter.ts`, the only lending path. SANAD sends its rate and APR and refuses a different echoed rate (`RATE_MISMATCH`). The booking is idempotent on `business:<id>:book`. The loan account, contract and customer references are recorded once (`LOAN_BOOKED`).
- **The upstream channel.** In the partner model, Tuum's customer-record system performs stages 1–4 and hands over through `POST /api/origination/v1/business-applications`.
- **Verified.** Authentication and the product catalogue (76 products) against Tuum's partner sandbox, 8 October 2026. Admin → Products shows Tuum's products live and read-only for mapping.
- **Sandbox finding.** Tuum's loan module derives a rate and APR when none is supplied. This does not matter for a rate-priced SME loan, because SANAD supplies both and reconciles the echo.
- **Open (TUUM-LEND-01):**
  - **an AED product** (none in the sandbox);
  - whether a supplied rate overrides the price list;
  - how the servicing account is opened;
  - `x-request-id` idempotency;
  - whether accept, activate or disbursement-initialisation calls are needed;
  - read-back totals.
- **The fund supplies:**
  - its Tuum tenant and hosts;
  - credentials in the vault (`CORE_BANKING`, `person_api_base_url`);
  - its AED product codes;
  - its servicing account set-up.

## Nutrient integration in the UAE

| Use | Status |
|---|---|
| Offer letter PDF (HTML → PDF, fingerprinted, stored by hash, Arabic joined and RTL) | Works in evaluation mode (watermarked); V-02 and V-03 passed 17 Oct 2026 |
| Statement figures read into the spread (tenant row labels, 90% confidence floor, each figure verified by a person) | Works where the Document Engine is configured; Arabic plain text garbled in V-06 |
| D1 reading and classification (trade licence, Emirates ID, statements, salary certificate, WPS report, audited financials, tenancy contract / Ejari) | LIVE; images not read |
| Seal of the signed letter (PAdES) | Plumbing at B-B with a self-signed development certificate; licensed CSP needed (V-04, OI-06) |
| Viewer | Evaluation mode until a licence key (V-01; the demo key has expired) |

Open checks: V-01 licence and feature set; V-04 validating signature; V-05 promissory note; V-06 Arabic extraction; V-07 run in a browser; V-08 redaction.

**The fund supplies:**
- a production licence, deployed in the UAE;
- a signing service in front of its HSM, with a licensed certificate;
- its letterhead;
- real document samples to tune the catalogues.

## Architecture and hosting for the UAE

- **The same codebase and the same database model as KSA.** The deployment's jurisdiction selects the profile. One deployment serves one jurisdiction.
- **Hosting options:**
  - Azure UAE North, which offers every Phase 2 service;
  - the fund's own platform (OpenShift);
  - another UAE cloud the fund approves.
- **Phase 1 (synthetic) runs in UAE North today:** three apps behind Container Apps ingress, with Admin IP-allow-listed.
- **Phase 2 (real data):**
  - Application Gateway WAF v2 in-region;
  - zone-redundant PostgreSQL with point-in-time restore;
  - a customer-managed key in a managed HSM;
  - Key Vault re-implementation of the credential functions;
  - private endpoints;
  - geo-backups kept in the UAE.
- **Residency** is a database constraint: production AE data must sit in the UAE behind a customer-managed HSM.
- **The rest is shared with KSA:** 36 ports; 35 migrations; FORCE RLS; the audit hash chain; the outbox; Temporal; IBM API Connect; OIDC.

## Security due-diligence answers (UAE framing)

| Topic | Answer | Open items to disclose only when asked |
|---|---|---|
| Regulatory frame | Designed to SAMA CSF and NCA ECC for KSA. For the UAE we map the same controls to the fund's CBUAE and UAE information assurance obligations | The UAE control mapping is not yet written; the CBUAE applicability depends on licence (DP-20) |
| Residency | Database-enforced UAE residency for production | UAE residency requirements to confirm (DP-20) |
| Tenant isolation | FORCE RLS; BOLA and cross-tenant tests | SR-003 (High) in remediation |
| Identity | OIDC with step-up (300 s) before approvals; development tokens refused in production | Live IdP unverified; SAML not built |
| Personal data | No Emirates ID number in any payload or log (`IDENTITY_NUMBER_IN_PAYLOAD`); masked recipients; IBAN shown only to an eligible confirmer | — |
| Webhooks | HMAC `Sanad-Signature` with the tenant's secret from the vault; idempotent | — |
| AppSec pipeline | All CI gates block merge | SR-049 exception expired; SR-040 public repository |

## RFP response matrix (UAE SME)

| Requirement | SANAD's answer | Promise as |
|---|---|---|
| SME term finance with variants and grace | Six configurable variants, grace, owner contribution, tranches | Available |
| Islamic SME finance | Tawarruq module with board approval | Available on board ruling and broker rail |
| Upstream CRM / core hand-over | Hand-over API, idempotent, status API | Available |
| KYB: licence, Emirates ID, screening, UBO | NER, ICP, screening, 25% UBO (cited) | Integration-ready; UBO declaration available |
| Bureau (AECB) incl. reporting | Report at assessment; reporting on first tranche, monthly and on settlement | Integration-ready |
| Open Finance affordability | CBUAE Open Finance v2.1 AIS model | Integration-ready |
| Financial spreading and ratios | Keyed or read from statements; verified by a second person | Available |
| Scorecard, risk bands, STP | Configurable; STP by amount, risk and cover | Available |
| Collateral and guarantees | Register with haircuts and four-eyes confirmation | Available |
| Credit committee and DoA | Quorum by amount and risk; deviations justified | Available |
| Bilingual offer letter and e-signature | Letter with APR and covenants; UAE Pass signing intent | Letter available; UAE Pass integration-ready |
| Disbursement in tranches | Partner bank, ISO 20022-shaped, signed status webhook | Integration-ready |
| Core banking booking | Tuum loan contract with SANAD's rate reconciled | Integration-ready (AED product needed) |
| Servicing and collections | Position, direct collection, late charges, hardship, restructuring | Available; partner bank integration-ready |
| Document management and OCR | Checklists, upload, reading, checks, viewer | Available; image OCR planned |
| Arabic and English | Arabic-first RTL; bilingual letters | Available |
| Data in the UAE | Database-enforced residency | Available |

## Demonstration script (UAE)

Before you start, check the following:
- the hosted deployment is **switched to AE** (Admin → Jurisdiction). The 9 October proposal still needs a second administrator (DP-42);
- the synthetic data class is on;
- staff tokens for maker, checker, senior checker, committee and finance are at hand;
- choose a **seeded or hand-over application** for anything involving an offer. Intake-originated cases cannot be notified (`OFFER_NOTICE_NO_CHANNEL`).

| Step | Show | Say |
|---|---|---|
| 1 | Pipeline: nine stages, SLA chips | "Where every case is, and how long it has been there" |
| 2 | Hand-over API call (or intake with NER, ICP, screening) | "No Emirates ID number crosses the API. References only" |
| 3 | Upload documents; D1 reading and D2 checks; validate as a second person | "The system reads; a person decides" |
| 4 | Spread figures; AECB report; Open Finance facts | "Each figure is verified by someone other than whoever keyed it" |
| 5 | Collateral register; try to submit with a requirement missing | "Refused: security incomplete" |
| 6 | Assessment trace; risk band; route | "Every threshold is your policy, in configuration" |
| 7 | Decision pack; justify a deviation; committee approves as a different member | "Four eyes, by identity" |
| 8 | Offer letter in both languages; send | "APR from one function; Gregorian dates" |
| 9 | UAE Pass signing; conditions precedent; payee confirmation; tranche release | "The letter's fingerprint is what is signed" |
| 10 | Booking in the loan system (Fixture label) | "Our rate is sent and the echo is checked" |
| 11 | Servicing: collection result, late charge, hardship, restructuring | "Every change needs a second person" |

## Objections and answers (UAE)

| Objection | Answer |
|---|---|
| "Is it live with AECB, UAE Pass and the bank?" | Each adapter is built against the published standard where one exists, and runs against a recorded simulation. The live connection is made with your credentials during implementation |
| "We are a development fund. CBUAE rules may not apply to us." | SANAD records your licence type. Rules apply as configuration, and we confirm the applicable set with your counsel |
| "Our scorecard is different." | Every threshold shown is illustrative. Your scorecard, bands, STP route and committee quorum are configuration |
| "Do you support Islamic SME in the UAE?" | The Tawarruq module is built. It goes live on your board's ruling, a recorded approval and a commodity broker connection |
| "Where will our data be?" | In the UAE, behind your key. The database refuses production data elsewhere |
| "Can our CRM keep doing stages 1–4?" | Yes, through the hand-over API. Or SANAD can do them; you choose |

## Implementation plan and client inputs

| Phase | Content | The fund supplies |
|---|---|---|
| 1. Assess and architect | Products and variants; channel (hand-over or intake); hosting; legal applicability | Product paper; licence type; counsel's view (DP-20) |
| 2. Design for compliance | Credit policy, bands, STP, DoA, covenants, checklists, offer and servicing policy as configuration | Credit policy; document samples; late-charge cap |
| 3. Build and integrate | UAE rails verified; Tuum AED product; Nutrient; UAE Pass signing; partner bank; SSO; letterhead | Sandbox and production credentials; Tuum set-up; Nutrient licence; CSP certificate; IdP; screening vendor |
| 4. Run and improve | UAT with synthetic data; pen test; go-live gate | Pen-test provider; DR plan; SOC contacts |
