---
title: Product Guide
subtitle: SME lending for funds, banks and finance companies in the Emirates, from hand-over to collections, on one engine.
edition: United Arab Emirates
classification: Client
version: 1.0
date: 27 October 2026
---

## About this guide

This guide describes every function SANAD (سند, "support") offers an institution lending in the United Arab Emirates: a CBUAE-licensed bank or finance company, or a government SME development fund. It covers what each function does, who uses it, how it is controlled, and what is available today. It is written for the business, credit, operations, risk and technology teams who evaluate a lending platform, and for the people who will run it.

A companion **Product Guide — Kingdom of Saudi Arabia** covers the Saudi edition. The **API Catalogue** describes every interface in technical detail.

### How to read the status of a function

| Status | Meaning |
|---|---|
| **Available** | Built, working end to end and demonstrable today. |
| **Integration-ready** | Built and working against a recorded simulation of the provider. The live connection is made and verified during implementation, with the institution's own credentials and the provider's sandbox. |
| **Planned** | Specified and on the roadmap, not yet built. |

A rail is never described as integrated until a live call has been verified. SANAD's screens say so too: a simulated answer is labelled on screen, and a deployment holding real customer data refuses simulated answers outright.

## SANAD at a glance

SANAD is a loan origination platform. In the Emirates it runs the SME lending journey from the moment an application leaves the institution's customer-record system through credit assessment, committee, offer, signature, disbursement, booking and collections. It keeps the evidence of every step.

It is built for lending that has to answer to a credit committee and a regulator. Most origination systems treat control as a set of reports produced afterwards. SANAD treats it as properties the system cannot violate. A figure is not used until a second person has verified it. A committee cannot approve an unjustified deviation. A disbursement is refused until every condition precedent is evidenced. In each case the system refuses, and says why.

| | |
|---|---|
| **Products** | SME term finance (conventional) with variants for small loans, working capital, fixed assets, expansion, first-time founders and advanced technology. SME finance by Tawarruq where the institution's Shariah board rules |
| **Channels** | Hand-over API from the institution's customer-record system; SANAD's own intake; the operations workbench |
| **UAE rails** | UAE PASS, ICP (Emirates ID), NER (National Economic Register), AECB, FTA, MOHRE (WPS), UAE Open Finance, the institution's partner bank |
| **Core banking** | Tuum, booking each disbursed facility as a loan contract on the signed terms |
| **Documents** | Nutrient Document Engine and viewer: bilingual offer letters, institutional seal, document and statement reading |
| **Language** | Arabic-first, right to left, with English. Gregorian dates on contracts |
| **Currency** | AED, held in fils as whole numbers. Never combined with another currency |
| **Deployment** | In the UAE: on the institution's own platform or a UAE cloud region, with data and keys in the Emirates |

## How SANAD is built

SANAD has three layers, and the boundary between them is enforced by automated tests on every change.

```
   Customer-record system ─▶ ORIGINATION ENGINE ─▶ Core banking (Tuum)
   Workbench intake           applications · applicants · decisioning ·
                              workflow · maker-checker · documents ·
                              consent · exceptions · SLA · audit
                                     │
                              PRODUCT MODULES
                SME term (conventional) · SME finance by Tawarruq
                                     │
                              UAE INTEGRATION RAILS
     UAE PASS · ICP · NER · AECB · FTA · MOHRE · Open Finance · Partner bank
```

- **The engine is product-agnostic.** It knows applications, applicants, decisions, workflow, documents and money.
- **Each product module owns its contract:** pricing, disclosure, schedule, execution and its own invariants.
- **Every institution-specific choice is configuration:** credit policy, product variants, document checklists, approval tiers, delegation of authority, SLAs. It is effective-dated and changed under four eyes.
- **Adapters own the providers' vocabulary.** Replacing a provider is a new adapter, not a different platform.

**One deployment, one jurisdiction.** Administrators set a SANAD deployment to the Emirates under four eyes. It then behaves as a UAE deployment throughout: AED, Asia/Dubai time, Gregorian contracts, and only UAE rails. Once an institution has done business, the setting is locked in production.

## Products for the Emirates

### SME term finance

Business term finance for micro, small and medium enterprises, sized by **UAE Cabinet Resolution No. (22) of 2016** on the unified definition of SMEs, by sector (trading, manufacturing, services) and by revenue and headcount.

**Shape.**
- **Amount-first.** The applicant asks for an amount, a tenor and a purpose under a variant.
- **Schedule.** Reducing balance, on a dated ACT/365 schedule that matches the core banking system to the fil.
- **Grace periods and owner contribution** are set per variant.
- **Platform APR** on every offer, and the full disclosure set even where the borrower is a company, because the person signing is usually its owner.

**Variants.** The institution configures its own variants, each with limits, tenors, grace, owner contribution, years in operation, purposes, collateral and its own document checklist. A typical set:

| Variant | Purpose |
|---|---|
| Small loan | Working capital, inventory and equipment for early businesses |
| Working capital | Short-tenor working capital and inventory |
| Fixed assets | Equipment and premises, with the financed asset pledged and its insurance assigned |
| Expansion | New branches and capacity, with the owner's contribution |
| First-time founders | Business launch with a lighter document set |
| Advanced technology and AI | Technology development and equipment |

**Status: Available.**

### SME finance by Tawarruq

The Islamic variant of the same journey, offered as a deferred sale:
- **The offer** states commodity cost, profit and the deferred price, and the letter is in profit terms.
- **Before disbursement** the commodity is bought at exactly the quoted cost, sold to the customer on the signed instrument, title is passed, and the commodity is sold on.
- **Disbursement** is a single payment of the proceeds, never tranches.

It is enabled only where the institution's Shariah board has ruled, its approval is recorded and in force in SANAD's approvals register, and a commodity broker is connected for the Emirates. **Status: available on implementation of the broker connection and the board's approval.**

## Channels

| Channel | What it does | Status |
|---|---|---|
| **Hand-over from the customer-record system** | Where stages 1–4 (application, needs assessment, product application, verification) happen in the institution's own customer-record system, that system hands the verified application to SANAD's credit team at stage 5 through a secured API. The institution and currency come from the credential, never the request. A repeat hand-over returns the same application. An identity number anywhere in the request is refused | Available |
| **Status API** | The upstream system reads each application's stage, status and approved terms | Available |
| **SANAD intake** | Where the institution prefers, officers run stages 1–4 in SANAD itself, with the KYB checks below | Available |
| **Operations workbench** | Every stage for the institution's staff: pipeline, application, assessment, decision, offer, closing, servicing, documents. Arabic-first, right to left | Available |

## The SME journey, stage by stage

SANAD follows a nine-stage pipeline. Each stage has a target the institution sets, and the screens show the clock against it.

| Stage | Name | Where |
|---|---|---|
| 1 | Application | Customer-record system or SANAD intake |
| 2 | Needs assessment | Customer-record system or SANAD intake |
| 3 | Product application | Customer-record system or SANAD intake |
| 4 | Verification | Customer-record system or SANAD intake |
| 5 | Credit assessment | SANAD |
| 6 | Decisioning (credit committee) | SANAD |
| 7 | Contract and disbursement | SANAD |
| 8 | Portfolio management | SANAD |
| 9 | Collections | SANAD |

**The pipeline screen** shows every application by stage, with the stage clock, SLA chips, days past due once in collections, and four headline figures. It exports to CSV with business fields only.

**Four eyes throughout.** Whoever keyed, presented, submitted or approved is never whoever checks. This is enforced by identity, not by role.

### Stages 1–4 in SANAD: intake and KYB

| Function | What it does | Status |
|---|---|---|
| Open the intake | Trade licence and issuing authority (an emirate's economic department or a free zone), business name, sector, years in operation, optional tax registration number. The request: product, variant, purpose, amount, tenor, grace, owner contribution | Available |
| Parties | Owners and signatories by reference, with roles and ownership shares. At least one signatory. **No identity number held anywhere** | Available |
| Consent | Per subject, per purpose: identity, screening, credit bureau, account information, document verification. Every rail adapter checks the consent itself before calling out | Available |
| Registry | Licence status, legal form, activities and capital from the National Economic Register. Officers and controllers become signatory references | Integration-ready |
| Identity | Each party's Emirates ID verified with ICP | Integration-ready |
| Screening | Sanctions and politically exposed persons for the business and every party. A referral is cleared by a checker other than the officer who opened the intake, with a reason | Integration-ready |
| Beneficial ownership | Owners at or above the threshold in **Cabinet Decision No. (58) of 2020** declared with evidence | Available |
| VAT registration | Status by tax registration number from the FTA, as information | Integration-ready |
| Gaps and hand-over | Outstanding checks listed as gaps. Hand-over to credit only when none remain | Available |

### Stage 5: credit assessment

| Function | What it does | Status |
|---|---|---|
| Document checklist | Per variant. Typically: trade licence, owners' Emirates IDs and personal AECB reports, 12 months of personal and company statements, two years of audited financials, salary certificate, WPS salary report and company profile; plus supplier quotations, asset valuation or tenancy contract where the variant needs them | Available |
| Upload and validation | File type read from the bytes. Stored by fingerprint in the institution's object store. Pending until a different person validates it | Available |
| Document reading | Each upload classified; issue, expiry and statement dates read; the checklist's checks run (not expired, recent enough, period covered, licence and name match). Shown to the checker, never decided on. **A person always validates** | Available |
| Gaps and requests | Missing, expired or failing documents listed in plain words. One request goes to the applicant. The case shows ready again when the last gap closes | Available |
| Financial spreading | Figures keyed by the officer or read from an uploaded statement under the institution's own row labels. **Every figure verified by a second person.** Ratios computed: debt-service cover, current ratio and the full spread | Available |
| Commercial bureau | The AECB commercial report fetched under the applicant's consent. Nothing typed overrides it | Integration-ready |
| Bank-statement facts | Average inflow, lowest month-end balance, returned payments and salary credits over 12 months, through UAE Open Finance, confirmed under four eyes | Integration-ready |
| Collateral and guarantors | Collateral by kind, value, valuation date and valuer, charge status and registry reference. Personal and corporate guarantees. Lending value after the institution's haircuts. Submission refused while a requirement is outstanding | Available |

### Stage 6: decisioning

| Function | What it does | Status |
|---|---|---|
| Assessment and scoring | Knock-outs (bureau score, debt-service cover, current ratio, sales growth, owner debt burden). A weighted scorecard of applicant and project factors. Risk bands, each with a maximum financing amount, minimum equity and maximum conditions. Every threshold is the institution's own | Available |
| Routing | Straight-through where the amount, risk band and collateral cover allow, approved by a checker. Otherwise to the credit committee | Available |
| Credit report notes | The analyst's notes for the committee, every version kept | Available |
| Decision pack | The credit memo assembled from the record. Every deviation from the assessment justified before approval, never approved by the person who justified it. Conditions precedent and subsequent, and covenants, from the institution's templates only, capped by the risk band. Frozen by fingerprint at approval and stated in the offer | Available |
| Committee | A member other than the submitter decides, with a reason. The committee may approve less than requested. Delegation of authority sets the quorum by amount and risk. Step-up re-authentication before every approval | Available |

### Stage 7: contract and disbursement

| Function | What it does | Status |
|---|---|---|
| Quotation | On the approved terms, from the institution's rate card, on the dated schedule. Offer and disbursement dates checked against the institution's offer policy | Available |
| Offer letter | A bilingual facility offer letter: Arabic and English in aligned rows, Gregorian dates, Arabic-Indic numerals in the Arabic text. It states the terms, the repayment summary, the APR, the conditions and covenants, and the signature blocks. Its fingerprint is its version. Rendered to PDF with the institution's letterhead | Available |
| Sending | "Confirm and send" by email and SMS: one notification per letter version, on the outbox in the same transaction. A resend needs a new version | Available |
| Signature | The signer signs through UAE PASS at an assurance level that verifies identity. The signing intent carries the letter's fingerprint, and each assertion is accepted once | Integration-ready |
| Institutional seal | The signed letter is sealed with the institution's PAdES signature through its own signing service | Integration-ready |
| Conditions precedent | Each one evidenced by a document and verified by a second person. Disbursement refused until all are met | Available |
| Payee | The IBAN checked for country, length and checksum, proven by a document and confirmed by a second person. The full IBAN is shown only to an eligible confirmer | Available |
| Disbursement | Released by finance, who is never the approver, the submitter or whoever recorded the payee. One to twelve tranches summing to the facility, released in order. Each is an idempotent payment instruction to the partner bank; the first carries the bureau report | Integration-ready |
| Bank status | The partner bank reports each tranche settled, rejected or returned on a signed callback. A rejected or returned payment fails the tranche and withdraws the payee confirmation until it is confirmed again | Available |
| Booking | The disbursed facility booked in Tuum as a loan contract on the signed terms | Integration-ready |

### Stages 8 and 9: portfolio and collections

| Function | What it does | Status |
|---|---|---|
| Position | Arrears, days past due and bucket, from confirmed receipts against the signed schedule, oldest instalment first, charges before principal | Available |
| Collections | Instalments due within seven days, or overdue, collected from the confirmed payee account through the partner bank. Each signed result becomes a rail-confirmed receipt. A returned collection is presented again | Integration-ready |
| Manual receipts | Recorded by finance. A receipt counts once a second person confirms it | Available |
| Bureau reporting | The month's status reported to AECB once; settled reported once at the end | Integration-ready |
| Late charges | Once per instalment overdue beyond the grace days. A fee on a conventional loan; **a charity obligation on an Islamic facility, never income**. Subject to the regulator's cap. Waived only by a second person | Available |
| Hardship hold | Pauses collections and charges. Lifted by a second person | Available |
| Restructuring | A conventional loan is re-amortised at its signed rate. An Islamic facility is re-spread with its total unchanged. In force only after a second person approves | Available |
| Loan system reconciliation | The core banking system's report reconciled against SANAD's position. A difference is flagged | Available |
| Daily cycle | Each morning: late charges, collections and the month's bureau status for every disbursed facility. Idempotent, so a re-run changes nothing | Available |
| Withdrawal and portfolio status | Applications withdrawn or declined with a reason. Portfolio status recorded | Available |

## UAE integration rails

Every rail follows the same pattern:
- an interface named for the capability, not the vendor;
- a recorded simulation for testing and demonstration;
- a live connection through the institution's egress;
- a circuit breaker;
- credentials held in the vault.

Every rail refuses to call without the subject's consent where consent is required, and keeps the result and the provider's reference rather than a copy of the provider's file. Dirhams cross the boundary as whole fils, never as floating point. **A rail being down never approves anything.**

| Rail | What SANAD uses it for | Status |
|---|---|---|
| **UAE PASS** | Sign-in, step-up and signing intent bound to the letter's fingerprint | Integration-ready |
| **ICP** | Emirates ID verification of each party | Integration-ready |
| **NER** | Trade licence status, legal form, activities, capital and signatories | Integration-ready |
| **AECB** | Commercial and individual reports and scores; facility reporting at disbursement, monthly and at settlement | Integration-ready |
| **FTA** | VAT registration status | Integration-ready |
| **MOHRE (WPS)** | Registered salary and establishment wage-protection compliance | Integration-ready |
| **UAE Open Finance** | Account-information facts for affordability, read to the CBUAE Open Finance Standards | Integration-ready |
| **Partner bank** | Disbursement tranches and instalment collections; signed status reports | Integration-ready |
| **Object storage** | Documents and letters stored by fingerprint in the institution's store | Available |

## Core banking with Tuum

SANAD originates, decides, prices, documents and disburses. Tuum is the system of record once the facility is booked.

- **Booking without re-keying.** The disbursed facility is created in Tuum (the borrower as a legal person, and the loan contract) from the signed offer's terms. Tuum's loan account number is stored back on the application.
- **SANAD's figures govern.** SANAD sends its own rate and APR, computed by the platform's single APR function. If Tuum answers with a different rate, the booking is refused rather than accepted quietly.
- **Safe retries.** Booking is idempotent: a retry never books twice.
- **Core products in Administration.** A read-only view of Tuum's product catalogue, showing whether each product would price by a rate, to map SANAD's products to the institution's core products.
- **Reconciliation.** The core's report is reconciled against SANAD's position during servicing.
- **Vendor neutrality.** Tuum's vocabulary lives only in its adapter. Another core banking system means a sibling adapter, not a different platform.

Where the institution's customer-record system is also Tuum, stages 1–4 happen there and hand over to SANAD at stage 5. SANAD runs stages 5 to 7 and hands back to the core for stages 8 and 9. SANAD keeps the evidence of all of them.

## Documents with Nutrient

SANAD composes its documents itself. The Nutrient Document Engine, deployed on the institution's own hosts, prints, seals and reads them, so documents stay within the institution's trust boundary.

| Function | What the institution gets |
|---|---|
| Offer letters as PDF | The bilingual letter printed as A4 PDF, fingerprinted, stored and tied to the version the customer signs |
| Letterhead and typography | The institution's letterhead. One typeface for both scripts, embedded so the PDF matches the screens. Arabic renders joined and right to left |
| Institutional seal | After the customer signs with UAE PASS, the letter is sealed with the institution's PAdES signature, with the key in its own signing service and HSM |
| Document reading | Text and tables extracted locally; SANAD's rules classify each document, read its dates and run the checklist's checks for the checker |
| Statement figures | Tables on an uploaded statement read into the spread, for a person to verify |
| Secure viewer | The viewer loads from SANAD's own origin. The browser holds a short-lived token for one document, never the engine's key |

## Administration and configuration

Every change is an effective-dated revision. One administrator proposes it and a different one approves it. Nothing changes until it is approved, and every change is recorded in the audit chain.

| Area | What is configured |
|---|---|
| Jurisdiction | The deployment set to the Emirates under four eyes. Locked in production once there is business. Production data must sit in the UAE behind a customer-managed HSM |
| Products and modules | Variants, rate card, limits, enable or disable, and mapping to Tuum products. Enabling the Islamic product needs a board ruling and an approval in force |
| Credit policy | Knock-outs, scorecard, risk bands, straight-through rules, delegation of authority, collateral haircuts, covenants, offer dates, servicing charges |
| Documents | Checklists per variant, document types and checks, statement row labels, letterhead |
| Rails and adapters | Per capability: adapter, fallback, environment, address. Only UAE rails can be configured |
| Credentials | Saved and rotated into the vault. Values never shown; every read audited |
| Staff identity | The institution's identity provider (OpenID Connect) and the mapping of its groups to authorities. Session lifetime and step-up before approvals |
| Partners | The customer-record system's credential, channel and maximum request; approval tiers |
| Licence | The installation's licence: state, history and renewal |

## Security, residency and compliance

| Area | How SANAD addresses it |
|---|---|
| **Data residency** | Customer data is processed and stored in the Emirates for a UAE deployment. The database refuses production data unless the region and the key custody meet the residency rule |
| **Tenant isolation** | Every table carries the institution and row-level security enforced by the database. The institution always comes from the authenticated identity |
| **Audit** | Every decision, approval, document, offer and state change writes an event to a per-institution hash chain, in the same transaction. It is verified independently |
| **Secrets** | Held only in the vault. Every read is audited. Never logged or returned |
| **Personal data** | No identity number in any payload, log or error. Consent is purpose-bound and checked before every rail call |
| **Money** | Whole fils and basis points. No floating point in the financial path. One currency per institution |
| **Four eyes** | By identity on every credit, closing and servicing act; by the database on configuration, jurisdiction and licence changes |
| **Engineering controls** | Static analysis with SANAD's own invariant rules, full-history secret scanning, dependency and licence checks, a software bill of materials, container and infrastructure scanning, dynamic scanning, an adversarial compliance suite, and the full test suite against the database with row-level security enforced. A finding blocks the merge |
| **Frameworks** | Designed to OWASP ASVS Level 2, with Level 3 for authentication, cryptography, signing and the audit chain. Aligned to the institution's CBUAE obligations as its licence requires |

## Deployment options

| Option | Description |
|---|---|
| **On the institution's own platform in the UAE** | SANAD's containers on the institution's Kubernetes or OpenShift, with PostgreSQL and the institution's HSM |
| **On a UAE cloud region** | SANAD on a UAE cloud region, with a customer-managed key in a managed HSM, in-region TLS termination and private database access |

Durable workflows and the daily cycle run on Temporal, self-hosted with PostgreSQL persistence. The installation is licensed by a signed file verified offline. If a licence lapses, new business stops after a grace period. Servicing, collections, reporting, audit and exports never stop.

## Implementation with IOTA

1. **Assess and architect.** Variants, channels (hand-over or SANAD intake), credit policy, delegation of authority, rails and the deployment target.
2. **Design for compliance.** The institution's configuration: catalogue, credit policy, checklists, covenants, offer and servicing policies. The applicable CBUAE rules confirmed against the institution's licence.
3. **Build and integrate.** Each rail verified against the provider's sandbox with the institution's credentials. The Tuum loan products and servicing accounts. Documents, letterhead and the signing service. Staff identity.
4. **Run and improve.** Deployment, user acceptance with synthetic data, go-live, then operation by the same team that built it.

**What the institution provides:**
- its credit policy and product papers;
- its rate card;
- provider credentials for each rail;
- its Tuum product configuration;
- its signing certificate and HSM;
- its letterhead;
- its identity provider;
- its deployment platform;
- for Islamic finance, its Shariah board's approval and a commodity broker.

## Roadmap

- A customer portal for applicants to follow their application and accept online.
- Capture of applicants' contact channels at SANAD intake, so intake-originated applications receive document requests and offers directly.
- MOHRE salary verification wired into the SME assessment (today the WPS report is collected as a document).
- Document authenticity checks with UAE issuers, where an issuer service exists.
- A commodity broker connection for the Emirates.
- SAML sign-in alongside OpenID Connect.
- User and entitlement management screens.

## Glossary

| Term | Meaning |
|---|---|
| **APR** | Annual percentage rate: the effective annual rate equating disbursements and repayments, fees included |
| **DSCR** | Debt-service cover ratio: cash available for debt service divided by debt service |
| **Fingerprint** | The SHA-256 hash of a document or record. Any change produces a different fingerprint |
| **Four eyes** | No person decides their own work. A second, different person approves |
| **Straight-through** | Approved by a checker without a committee, within limits the institution sets |
| **Tawarruq** | The institution sells a commodity on deferred terms; the customer sells it on for cash |
| **Integration-ready** | Built and working against a recorded simulation of the provider; the live connection is made during implementation |

## Contact

IOTA Technologies · Dubai · Riyadh · London
engagements@iotatechnologies.ai · iotatechnologies.io

---

*This material is general information about IOTA Technologies' services and is not legal, regulatory or compliance advice, nor a compliance opinion on any specific circumstance. References to the CBUAE, UAE federal legislation and regulators are context. Regulatory thresholds are configured by each institution and confirmed with its counsel during implementation. Engagements are governed by separate written agreements.*
