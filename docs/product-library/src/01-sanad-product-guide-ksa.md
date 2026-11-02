---
title: Product Guide
subtitle: Loan origination for banks, finance companies and fintechs in the Kingdom — Islamic and conventional, consumer and SME, on one engine.
edition: Kingdom of Saudi Arabia
classification: Client
version: 1.0
date: 27 October 2026
---

## About this guide

This guide describes every function SANAD (سند, "support") offers an institution regulated by the Saudi Central Bank (SAMA). It covers each function in turn: what it does, who uses it, how it is controlled, and what is available today. It is written for the business, credit, Shariah, operations, risk and technology teams who evaluate a lending platform, and for the people who will run it.

A companion **Product Guide — United Arab Emirates** covers the UAE edition. The **API Catalogue** describes every interface in technical detail.

### How to read the status of a function

| Status | Meaning |
|---|---|
| **Available** | Built, working end to end and demonstrable today. |
| **Integration-ready** | Built and working against a recorded simulation of the provider. The live connection is made and verified during implementation, with the institution's own credentials and the provider's sandbox. |
| **Planned** | Specified and on the roadmap, not yet built. |

A rail is never described as integrated until a live call has been verified. SANAD's screens say so too: a simulated answer is labelled on screen, and a deployment holding real customer data refuses simulated answers outright.

## SANAD at a glance

SANAD is a loan origination platform for the Kingdom. It takes an application from first contact through decision, offer, signature, booking and servicing, and it keeps the evidence of every step.

It is built for lending that has to answer to a regulator and, for Islamic products, to a Shariah board. Most origination systems treat compliance as a set of reports produced afterwards. SANAD treats it as a set of properties the system cannot violate. A Murabaha sale cannot be offered before the institution owns the goods. An invoice cannot be financed twice. An offer cannot be shown without its full disclosure. In each case the system refuses, and says which control refused.

| | |
|---|---|
| **Products** | Murabaha supply-chain finance (Wasl, وصل), personal finance by Tawarruq, buy now pay later, embedded merchant finance, conventional consumer term loans, SME term finance (conventional and Tawarruq) |
| **Channels** | Branch and back-office workbench, partner API, embedded aggregators, merchant checkout, consumer web, SME distributor portal, hand-over from the institution's customer-record system |
| **Saudi rails** | Nafath, Yakeen, Tahaqoq, SIMAH, Bayan, Wathq, GOSI, ZATCA (FATOORA and tax status), Open Banking, SADAD, payments hub, rate publisher, commodity broker |
| **Core banking** | Tuum. Booking by account postings for Murabaha and by loan contract for rate-priced products |
| **Documents** | Nutrient Document Engine and viewer. Bilingual offer letters, institutional seal, document reading |
| **Shariah governance** | Approvals register, daily automated Shariah review, incidents, purification, read-only audit workspace for the Board, Board report |
| **Language** | Arabic-first, right to left, with English. Gregorian and Hijri (Umm al-Qura) dates wherever a date has contractual effect |
| **Deployment** | In the Kingdom: on the institution's own OpenShift, or on an in-Kingdom cloud the institution has SAMA approval for |

## How SANAD is built

SANAD has three layers, and the boundary between them is enforced by automated tests on every change.

```
   Channels  ───▶  ORIGINATION ENGINE  ───▶  Core banking (Tuum or the institution's own)
                   applications · applicants · decisioning · workflow ·
                   maker-checker · documents · consent · exceptions · SLA · audit
                              │
                   PRODUCT MODULES
     Wasl Murabaha · Tawarruq · BNPL · Embedded · Conventional · SME term
                              │
                   SAUDI INTEGRATION RAILS
     Nafath · Yakeen · Tahaqoq · SIMAH · Bayan · Wathq · GOSI · ZATCA ·
     Open Banking · SADAD · Payments hub · Rate publisher · Notifications
```

- **The engine is product-agnostic.** It knows applications, applicants, decisions, workflow, documents and money. It does not know whether a product is a Murabaha or a term loan.
- **Each product module owns its contract.** Its pricing method, disclosure, schedule, execution sequence and its own invariants. Modules are isolated from each other, so a change to BNPL cannot alter a Murabaha.
- **Every institution-specific ruling is configuration.** Credit policy, product catalogue, Shariah board positions, document checklists, approval tiers, partner entitlements and SLAs are data, effective-dated and changed under four eyes. Two institutions whose boards rule differently run the same software with different configuration.
- **Adapters own the vendors' vocabulary.** No provider's data model reaches the engine. Replacing a provider is writing a new adapter, not changing the platform.

The test applied to every change is simple: would the next institution want exactly this behaviour? If not, it belongs in configuration, a product module or an adapter.

## Products for the Kingdom

| Product | Journey starts from | Family | Status |
|---|---|---|---|
| **Wasl — Murabaha supply-chain finance** | A cleared invoice (trade-first) | Islamic | Available |
| **Personal finance by Tawarruq** | An amount | Islamic | Available |
| **Buy now, pay later** | A basket at checkout | Conventional (no cost to the consumer) | Available |
| **Embedded merchant finance** | An amount, raised by a partner | Conventional; Islamic by board ruling | Available (partner settlement feed planned) |
| **Conventional consumer term loan** | An amount | Conventional | Available |
| **SME term finance** | An amount, by product variant | Conventional | Available |
| **SME finance by Tawarruq** | An amount, by product variant | Islamic | Available once the institution's board ruling is recorded |

Every product shares one engine for intake, consent, bureau, affordability, decisioning, approval tiers, documents, disclosure, signature, booking and servicing. What differs is what the product module decides.

### Wasl — Murabaha supply-chain finance

The institution buys the goods a cleared e-invoice names, holds them at its own risk for the period its Shariah board sets, and sells them to the distributor at cost plus a disclosed profit amount, payable on a fixed schedule.

- **Trade-first.** There is no amount box. The amount is the invoice's.
- **No rate anywhere in the contract.** The profit is an amount, fixed once. The total can never increase.
- **Three gates with no override:** ownership, possession, and the risk-holding period. Nobody, at any level of authority, can pass a gate that is not met.
- **One leg, one document.** The promise (wa'd), purchase, sale offer and acceptance are separate, time-stamped instruments, each linked by its fingerprint to the one before.
- **Distinct parties.** Seller, buyer and institution are three distinct commercial registrations, so the structure cannot become ‘inah.
- **Each invoice is financed once.** A database registry makes duplicate financing structurally impossible.
- **Late amounts are never income.** They are charity, held in a segregated liability.

Wasl is described end to end in its own chapter below.

### Personal finance by Tawarruq

Personal finance by organised Tawarruq. The institution buys an identified commodity lot from a board-approved broker and sells it to the customer at cost plus profit on deferred monthly instalments. The customer, or the institution as agent where the board permits it, sells the lot on, and the proceeds are disbursed.

- Each step is attested after the one before: purchase, sale to the customer, title, onward sale, disbursement. Disbursement happens once, after the proceeds are realised.
- Priced from a benchmark plus the institution's margin, bounded by the market range from the rate publisher. A stale or missing benchmark refuses the quote.
- Affordability against the institution's deduction-ratio cap, from GOSI salary and Open Banking account facts.
- Full SAMA consumer disclosure, including the APR, in Arabic and English before acceptance.
- Enabled only where the institution's Shariah board has ruled, and only while that approval is in force.

### Buy now, pay later

A basket split into equal instalments at no cost to the consumer. The merchant pays a discount. Built to the SAMA Rules for Regulating Buy Now Pay Later Companies (November 2023).

| Rule | How it is applied |
|---|---|
| Ceiling | A consumer limit up to the SAR 10,000 ceiling, at most 12 instalments; the institution sets its own limit within it (Articles 22(1) and 22(2)) |
| Collection | Electronic only (Article 22(3)) |
| Eligibility | Age, residency and riyal-only checks (Articles 20(3)–(5)); identity from a reliable source (Article 19(6)) |
| Bureau | Check with consent and reporting |
| Merchants | A store contract in place before checkout (Article 27); merchant onboarding with verification by a second person; suspension refuses new checkouts at once |

**Checkout.** Merchants integrate through the merchant checkout API (see the API Catalogue). The shopper signs in with Nafath, sees the disclosure for exactly the basket, including an APR of 0.00%, and accepts or declines.

### Embedded merchant finance

Merchant finance raised by a partner or aggregator under a merchant mandate.

- **Partner entitlements.** Each partner has a status, channel, programmes and a per-request maximum, set in Administration. A partner suspended there is refused on its next call.
- **Collection.** By fixed instalments, or as a revenue-linked holdback where the institution's policy permits.
- **Islamic variants.** These follow the institution's board's ruling on determinacy and on who the seller is.

### Conventional consumer term loan

A reducing-balance consumer loan with equal monthly instalments. It is priced from a benchmark plus margin, carries the full SAMA disclosure set and the platform-computed APR, and is checked against the deduction-ratio cap. It is never enabled for an Islamic institution.

### SME term finance and SME finance by Tawarruq

Business term finance for small and medium enterprises, sized by the SAMA definition of SMEs (Circular 381000064902).

- **Shape.** Variants, purposes and collateral; a dated ACT/365 schedule that matches the core banking system to the halala; the platform APR on the offer.
- **Pricing.** SAIBOR-3M plus the institution's margin, from the rate publisher, with the publisher's reference kept on the offer.
- **Tawarruq variant.** Offered as a deferred sale: commodity cost, profit and deferred price, with the letter in profit terms. Between signature and disbursement the commodity is bought at exactly the quoted cost, sold to the customer on the signed instrument, title passed, and sold on. Disbursement is a single payment of the proceeds, never tranches.

## Channels and surfaces

| Surface | Who uses it | What it does | Status |
|---|---|---|---|
| **Operations workbench** | The institution's staff | Every journey: dashboard, request keying, review queue, SME pipeline, Wasl transactions, facilities, programmes, goods register, merchants, documents, Shariah governance. Arabic-first, right to left | Available |
| **Dashboard** | Managers, team leads | Work awaiting review against the institution's own SLA targets, open pipeline, approvals and declines, a "needs attention first" triage list, rails as configured. No invented figures | Available |
| **Review queue** | Checkers, senior checkers, committee | Oldest first. SLA breaches in words. Own work visible but not actionable. No bulk approval | Available |
| **Partner API** | Partner systems | Raise, read and withdraw requests; eligibility pre-check. Every channel lands in the same queue | Available |
| **Embedded nomination** | Aggregators | Nominate under a merchant mandate, within the partner's entitlement | Available |
| **Merchant checkout** | Merchants and their shoppers | BNPL sessions: create, read, cancel; shopper sign-in, disclosure and acceptance | Available |
| **Consumer web** | Individuals | Sign in with Nafath; apply by amount; see the full disclosure; accept | Available (Nafath integration-ready) |
| **SME distributor portal** | Distributors' authorised signatories | Sign in with Nafath as a configured signatory; see sale offers and what the company owes; accept a Murabaha sale by signing its fingerprint | Available (Nafath integration-ready) |
| **Business hand-over API** | The institution's customer-record system | Hand a verified SME application to credit at stage 5 | Available |
| **Administration** | Platform administrators | Configuration under four eyes | Available |

## The origination journey, function by function

### Intake and know your customer

| Function | What it does | Status |
|---|---|---|
| Request keying | A three-step wizard for Murabaha: choose a cleared invoice (unavailable invoices show the control that refuses them), then the programme and a determinate tenor, then review and submit to a second person | Available |
| SME intake | Commercial registration, the request, parties and ownership. Beneficial owners checked against the 25% threshold. Consents recorded per subject | Available |
| KYB checks | Wathq registration, Yakeen identity, sanctions and PEP screening, zakat status, SIMAH commercial report, Open Banking statement facts. Each fetched under the subject's consent; the officer keys none of the answers. A referral is cleared by a different checker. Hand-over to credit only when the gap list is empty | Integration-ready |
| Consent | Purpose-bound consent records (bureau, screening, identity, documents, employment, account information, payment initiation, partner data sharing, notifications), with channel, version and evidence. Withdrawal is a new record. **Every rail adapter checks the consent itself before calling out** (PDPL purpose limitation, in code) | Available |

### Decisioning and approval

| Function | What it does | Status |
|---|---|---|
| Eligibility pre-check | The institution's policy over the facts supplied, answered approve, refer or decline with reason codes. Nothing stored | Available |
| Decision engine | A closed policy language: no loops, no clock, no hidden inputs. Its failure mode is refer, never approve. Each policy is versioned, and the decision records the version it ran under | Available |
| Knock-outs and data freshness | For example: registration not active; signatory unverified; sanctions hit; excluded activity; politically exposed person; trading history too short. Each source has a maximum age | Available |
| Affordability | Deduction ratio for consumers from GOSI salary and Open Banking facts; debt-service cover and revenue share for SMEs; BNPL consumer limit | Available (rails integration-ready) |
| Approval tiers | Checker, senior checker and credit committee by amount, set by the institution. A decision beyond a person's authority is refused | Available |
| Maker-checker | The person who keyed, presented or submitted never decides. Enforced by identity, not by role | Available |
| SME credit assessment | Bureau score, debt-service cover, current ratio, sales growth and owner debt burden as knock-outs. A weighted applicant and project scorecard; risk bands with maximum financing and conditions; straight-through or committee | Available |
| Collateral and guarantor register | Collateral by kind, value, valuation date, valuer and charge status. Guarantees. Lending value after the institution's haircuts. Submission refused while a requirement is outstanding | Available |
| Decision pack | The credit memo from the record. Every deviation justified before approval, never by its justifier. Conditions and covenants from the institution's templates. Frozen by fingerprint at approval | Available |
| Exceptions | An exception has an owner, an SLA and a mandatory resolution. It is never silently dropped | Available |

### Documents

| Function | What it does | Status |
|---|---|---|
| Checklists | Per product and variant, with validity windows. For SMEs: commercial registration, articles, owners' identity, national address, SIMAH report, 12 months of statements, two years of audited financials, zakat, VAT and GOSI certificates | Available |
| Upload and validation | File type read from the bytes. Stored by fingerprint. Pending until a different person validates it. Served only to the institution's staff after a fingerprint check | Available |
| Document reading | Classifies each upload, reads issue, expiry and statement dates, and runs the checks the checklist declares (not expired, recent enough, period covered, registration and name match). Findings are shown to the checker, never decided on: **a person always validates** | Available |
| Authenticity with the issuer | Checks Saudi national documents with Tahaqoq, under the applicant's consent. A document the issuer does not confirm needs the checker's written resolution | Integration-ready |
| Gaps and requests | Missing, expired, refused or failing documents are listed in plain words, and one request goes to the applicant. The case shows ready again when the last gap closes | Available |
| Statement reading | Figures read from an uploaded financial statement into the spread, under the institution's own row labels. Every figure is verified by a person | Available |
| Throughput | First-attempt accuracy, checks by type, touchpoints and time to a complete pack. Measurement only | Available |

### Offer, disclosure and acceptance

| Function | What it does | Status |
|---|---|---|
| Quotation | Computed by the product module from the institution's catalogue, which is effective-dated. A benchmark-linked product is refused if the benchmark is stale or missing | Available |
| APR | **One function computes the APR for the whole platform**: the effective annual rate that equates the present value of disbursements and repayments, fees included, in integer arithmetic. No product computes its own | Available |
| Disclosure | Financing amount, term, instalment, total cost of credit, total payable, APR and every fee, in Arabic and English, before acceptance. The acceptance records which disclosure version was shown | Available |
| Offer letter | A bilingual facility offer letter whose fingerprint is its version. A dated schedule, the APR, and Hijri (Umm al-Qura) dates alongside Gregorian. Rendered to PDF with the institution's letterhead | Available |
| E-signature | The signer signs through Nafath. The signing intent carries the letter's or instrument's fingerprint, and each identity assertion is accepted once | Integration-ready |
| Institutional seal | The signed letter is sealed with the institution's PAdES signature through its own signing service | Integration-ready |

### Closing, booking and disbursement

| Function | What it does | Status |
|---|---|---|
| Conditions precedent | Each one evidenced by a document and verified by a second person. Disbursement refused until all are met | Available |
| Payee | A Saudi IBAN, checked for format and checksum, proven by a document and confirmed by a second person | Available |
| Disbursement | Through the institution's payments hub. Each tranche is an idempotent instruction on a transactional outbox. Finance releases it; finance is never the approver or the submitter | Integration-ready |
| Bureau reporting | The facility reported to SIMAH once at disbursement, then monthly status | Integration-ready |
| Booking | In Tuum. See the chapter on core banking | Integration-ready |

## Wasl — Murabaha supply-chain finance, end to end

Wasl finances the goods an anchor sells to its distributors. The institution enters the chain as a real buyer and seller, not as a lender in a buyer's clothes.

### The book

| Function | What it does | Status |
|---|---|---|
| Programmes and anchors | Each programme has its anchor, its limit and the account the institution pays the anchor at. Changed in Administration under four eyes, checked against live exposure: no removal while in use, no new anchor once it has traded, no limit below what it holds | Available |
| Facilities | Credit proposes a distributor's limit in a programme; a different person approves it. **No facility, no trade** | Available |
| Concentration | The institution chooses which rules apply and their values: a cap on a single trade, a distributor's share of its programme, an anchor's share of the book. Set in Administration under four eyes | Available |
| Goods register | The board's excluded goods by HS heading. An invoice line on the register refuses the trade when the transaction opens | Available |
| Financed-invoice registry | Each invoice is registered when it is bought. A second financing is refused by the database | Available |

### The sequence

1. **Approval opens a transaction** in draft, through the product module, with the goods screened and the profit amount fixed from the catalogue.
2. **Trade validation.** Distinct parties are checked, and the cost is held against the facility, the programme and the concentration rules. The first one it does not fit refuses it, and nothing is held.
3. **The wa'd and the purchase** are executed as separate instruments. Each comes from a template version the board approved, is time-attested, and is linked to the one before.
4. **Gate 1, ownership.** The anchor's e-invoice to the institution, cleared by ZATCA and verified against the authority's keys.
5. **Gate 2, possession.** Delivery evidence uploaded and validated by a second person.
6. **Gate 3, the risk period.** The goods held at the institution's risk for the board's interval, measured between attested instants.
7. **The sale offer** states cost, profit, the fixed sale price and the due dates in both calendars. It lapses if it is not accepted in time. A position can be unwound, with the goods' disposition recorded.
8. **Acceptance.** The distributor's authorised signatory accepts in the SME portal by signing the offer's fingerprint with Nafath.
9. **Booking.** The obligation and its schedule are recorded in SANAD, where the total is fixed and the schedule sums to it. The receivable is booked in Tuum as account postings, never as a loan contract.

### Settlement and collection

| Function | What it does | Status |
|---|---|---|
| Seller payment | Instructed to the anchor at the purchase, through the payments hub, once. A returned payment is instructed again by finance | Integration-ready |
| Collection | Instalments presented as SADAD bills from seven days before they fall due. The institution remains the biller | Integration-ready |
| Reconciliation | SADAD's paid-bills file read each morning and matched to presentations. Exact matches applied once; everything else becomes an exception for operations | Integration-ready |
| Returns | A returned collection takes its receipt off the obligation. The total never moves | Available |
| Late amounts | Each morning the system proposes a late amount for each overdue instalment, at the board's fixed amount and after its grace period. An officer assesses whether the distributor was able but unwilling to pay, or unable (hardship), and a second person confirms. A confirmed amount is billed on its own SADAD bill, never on the obligation. On collection it is raised to the segregated charity liability, then disbursed to a board-approved charity by two people | Available (rails integration-ready) |

## Servicing and collections

| Function | What it does | Status |
|---|---|---|
| Position | Arrears, days past due and bucket, from confirmed receipts against the signed schedule, oldest instalment first | Available |
| Manual receipts | Recorded by finance. A receipt counts once a second person confirms it | Available |
| Collections | Instalments due within seven days, or overdue, presented as SADAD bills. Each signed result becomes a rail-confirmed receipt | Integration-ready |
| Bureau reporting | The month's status reported to SIMAH once; SETTLED reported once when the facility is repaid | Integration-ready |
| Late charges | Once per instalment overdue beyond the grace days. A fee on a conventional loan; **a charity obligation on an Islamic facility, never income**. Waived only by a second person | Available |
| Hardship hold | Pauses collections and charges. Lifted by a second person | Available |
| Restructuring | A conventional loan is re-amortised at its signed rate. An Islamic facility is re-spread with its total unchanged. In force only after a second person approves | Available |
| Daily cycle | Each morning, as the institution's scheduler: reconciliation, the Shariah review, late charges, collections and bureau status. Every task is idempotent, so a re-run changes nothing | Available |

## Shariah governance

SANAD gives the institution's Shariah board and its Shariah reviewers their own tools. Their decisions bind the system, and they can verify any transaction themselves without technical assistance.

### Approvals register

Each approval the board issues is recorded: the approving body, its reference, the members, the effective date, the review or expiry date, and the products and template versions it covers. A Shariah reviewer records it and a second reviewer confirms. Suspension, reinstatement, withdrawal and renewal go the same way, and a recorded approval is never edited.

**No approval in force, no new Islamic business.** Each of these is refused unless the approval its configuration cites is in force that day and covers it:

- a Wasl request, a transaction opening, a limit hold, a wa'd or a purchase;
- an SME Tawarruq hand-over or offer;
- a consumer Tawarruq quote or acceptance;
- enabling an Islamic product in Administration.

When an approval passes its review date, new business on every product it covers stops on its own; nobody has to act. Contracts already executed keep the approval they were made under. **Status: Available.**

### The daily Shariah review and incidents

Each morning SANAD re-checks every live Murabaha transaction from its own record, independently of the path that moved it:

- the contracts' chain and order;
- the evidence at each gate and at the sale;
- the risk period held before the sale offer;
- distinct parties and the same buyer throughout;
- the goods against the register at opening and as it stands now;
- that the sale price equals the cost plus the profit;
- **template drift**: each executed document is rebuilt from its approved template and the transaction's figures, and compared by fingerprint.

**Incidents.** Each failure is raised once as an incident, rated low, medium, high or material.

- **Who works them.** The Shariah reviewers triage, plan, remediate and close them. A different reviewer closes, with evidence.
- **Effect on the transaction.** An open material incident stops the wa'd, the purchase and the sale offer until it is closed. Unwinding is never stopped.
- **Observations.** Reviewers can raise their own observations as incidents.

**Status: Available.**

### Purification

Where an incident finds that income was affected, the income is purified.

1. A Shariah reviewer proposes the amount by the board's method: the transaction's whole profit, or an assessed amount within it. A second reviewer confirms it.
2. The amount is split across the instalments in proportion.
3. Each share is raised to the segregated charity liability, and to the core banking system's charity liability, as its instalment is collected.
4. Each share is disbursed by two people to a charity the board approved.

The incident closes only when every share is raised, and the database checks this against the ledger itself. **Status: Available.**

### Audit workspace and Board report

A read-only workspace for the Board's Shariah auditor. **Status: Available.**

- **Finding transactions.** Search, or draw a sample. Anyone can draw the same sample again from its seed, so the Board can check it was not chosen for them.
- **The replay.** Each contract with its time, fingerprint and link to the one before; each step's evidence as the sale saw it; the risk period required and held; the figures disclosed; the approval as it stood that day; and every Shariah check.
- **The audit pack.** Exported as a file whose manifest carries the fingerprint of each part, so a changed copy shows it.
- **Observations.** The auditor's one act. An observation becomes an incident for the reviewers.
- **The Board report.** For any period: transactions opened and executed; the risk period held before each sale; incidents by severity and age; template drift; late amounts and purified income held and given; and the approvals register at the period's end. Printable, and downloadable for the institution's annual Shariah report.

## Saudi integration rails

Every rail follows the same pattern:
- an interface named for the capability, not the vendor;
- a recorded simulation for testing and demonstration;
- a live connection through the institution's own egress;
- a circuit breaker;
- credentials held in the vault.

Every rail **refuses to call without the subject's consent** where consent is required. It keeps the decision-relevant result and the provider's reference, never a copy of the provider's file. **A rail being down never approves anything.**

| Rail | What SANAD uses it for | Status |
|---|---|---|
| **Nafath** | Sign-in and step-up for applicants and distributors; signing intent bound to the document's fingerprint | Integration-ready |
| **Yakeen** | Identity attributes against national records | Integration-ready |
| **Tahaqoq** | Authenticity of national documents an applicant presents | Integration-ready |
| **SIMAH** | Consumer and commercial reports and scores; existing obligations; **mandatory reporting** of new facilities (on the outbox, never fire-and-forget) | Integration-ready |
| **Bayan** | Alternative bureau. The institution chooses the primary and the fallback | Integration-ready |
| **Wathq** | Commercial registration status, legal form, activities and capital; distributor signatories | Integration-ready |
| **GOSI** | Employment and registered salary for affordability and covenants | Integration-ready |
| **ZATCA FATOORA** | Clearance of the anchor's invoice for Murabaha ownership (gate 1) | Integration-ready |
| **ZATCA tax status** | Zakat and tax certificate status for SME eligibility | Integration-ready |
| **Open Banking** | Affordability facts from account information; payment initiation | Integration-ready |
| **SADAD** | Bill presentment and collection; paid-bills reconciliation | Integration-ready |
| **Payments hub** | Disbursements and payments (SARIE, mada, internal transfer). The hub decides the rail | Integration-ready |
| **Rate publisher** | Benchmarks (SAIBOR) and market APR ranges. It informs pricing; it never sets a customer's rate | Integration-ready |
| **Commodity broker** | Tawarruq purchase, title and onward sale | Integration-ready |
| **Notifications** | SMS, email and push, by party reference | Integration-ready |

## Core banking with Tuum

SANAD originates, decides, prices, documents and executes. Tuum is the system of record once a facility is booked. At the point of booking SANAD hands the facility to Tuum through a vendor-neutral interface, so nobody re-keys the deal into the core.

| What is booked | How | Why |
|---|---|---|
| **Wasl Murabaha** | Account-shaped: the distributor as a party, its collection account, and one posting at the fixed sale price, with cost and profit recorded as detail | No rate ever reaches the servicing record the Shariah board audits. A loan contract would carry a rate the contract does not have |
| **SME and rate-priced loans** | As a Tuum loan contract, created on the signed terms | SANAD sends its own rate and APR. If Tuum answers with a different rate, the booking is refused |
| **SME Tawarruq** | As a loan contract, with the deferred price authoritative in SANAD and reconciled | A position the institution's Shariah board reviews before go-live |
| **Charity liability** | Collected late amounts and purified income posted to a segregated charity liability account | The interface has no way to post them to income |

**What the institution sees:**
- **Booking without re-keying.** The loan account number is stored back on the application.
- **Core products in Administration.** A read-only view of the core's product catalogue, showing whether the core would price each product by a rate. Administrators use it to map SANAD products to core products.
- **Safe retries.** Bookings are idempotent, so a retry never books twice.

**Vendor neutrality.** Tuum's vocabulary lives only in its adapter. An institution with another core banking system gets a sibling adapter, not a different platform.

## Documents with Nutrient

SANAD composes its documents itself. The Nutrient Document Engine, deployed on the institution's own hosts, prints, seals and reads them, so documents never leave the institution's trust boundary.

| Function | What the institution gets |
|---|---|
| Offer letters as PDF | The bilingual letter, Arabic governing and right to left beside English, printed as A4 PDF. Fingerprinted, stored, tied to the version the customer signs |
| Letterhead and typography | The institution's own letterhead. One typeface for both scripts, embedded so the PDF matches the screens. Arabic renders joined, with Arabic-Indic digits |
| Institutional seal | After the customer signs, the letter is sealed with the institution's PAdES signature, with the key held in the institution's own signing service and HSM |
| Document reading | Text and tables extracted locally. SANAD's rules then classify the document, read its dates and run the checklist's checks for the checker |
| Statement figures | Tables on an uploaded statement read into figures for a person to verify |
| Secure viewer | The viewer loads from SANAD's own origin. The browser gets a short-lived token for one document, never the engine's key |

## Administration and configuration

Every change is an effective-dated revision. One administrator proposes it and a different one approves it. Nothing changes until it is approved, and every change is recorded in the audit chain.

| Area | What is configured | Status |
|---|---|---|
| Products and modules | The catalogue: term sheets, pricing rules, variants, enable or disable. Validated by the product module. An Islamic product needs a board ruling and an approval in force. Mapping to core banking products | Available |
| Rails and adapters | Per capability: the adapter, its fallback, environment and address | Available |
| Credentials | Saved and rotated into the vault. Names and dates listed; values never shown; every read audited | Available |
| Staff identity | The institution's identity provider (OpenID Connect) and the mapping of its groups to authorities: maker, checker, senior checker, credit committee, finance, Shariah reviewer, Shariah auditor, administrator. Session lifetime and step-up before approvals | Available (live sign-in verified during implementation) |
| Partners | Partners and aggregators, agents, approval tiers | Available |
| Programmes, concentration, goods register | The Wasl book and the board's excluded goods | Available |
| Jurisdiction | The deployment behaves as the Kingdom (SAR, SAMA) | Available |
| Licence | The installation's licence: state, history and renewal | Available |

## Security, residency and compliance

| Area | How SANAD addresses it |
|---|---|
| **Data residency** | Customer data is processed and stored in the Kingdom. The database refuses to mark an environment as holding production data unless its region is in the Kingdom and its keys are in a customer-managed HSM. Development and test environments hold synthetic data only |
| **Tenant isolation** | Every table carries the institution and row-level security, enforced by the database for every transaction. The institution and channel always come from the authenticated identity, never from a request |
| **Audit** | Every decision, approval, acceptance, document and state change writes an event to a per-institution hash chain, in the same transaction. The chain is verified independently by the database and by a separate verifier |
| **Secrets** | Held only in the vault. Every read is audited. Never logged, traced or returned |
| **Personal data** | No national identifier or personal datum in any log, trace, metric or error. Consent is purpose-bound and checked before every rail call |
| **Money** | Integer minor units and basis points. No floating point anywhere in the financial path |
| **Four eyes** | Enforced by identity on every decision, and by the database on configuration, jurisdiction and licence changes |
| **Frameworks** | Designed to NCA ECC-2:2024, SAMA Cyber Security Framework, PDPL and NDMO, and to OWASP ASVS Level 2, with Level 3 for authentication, cryptography, signing, Murabaha sequencing and the audit chain |
| **Engineering controls** | Every change passes static analysis (CodeQL, Semgrep with SANAD's own invariant rules), secret scanning of the full history, dependency and licence checks, a software bill of materials, container and infrastructure scanning, dynamic scanning, an adversarial compliance suite, and the full test suite against the database with row-level security enforced. A finding blocks the merge |
| **Gateway independence** | Fronted by IBM API Connect and DataPower. No service trusts a header the gateway adds; every service re-validates the caller and the institution |

## Deployment options

| Option | Description |
|---|---|
| **On the institution's OpenShift, in the Kingdom** | SANAD's containers run on the institution's own platform with in-Kingdom PostgreSQL, the institution's HSM and its API Connect and DataPower. Residency is satisfied by construction; disaster recovery uses the institution's second datacentre |
| **On an in-Kingdom cloud** | Where the institution holds SAMA approval for an in-Kingdom cloud provider, SANAD deploys there under the same controls |

Durable workflows (multi-day origination, Murabaha sequencing, the daily cycle) run on Temporal, self-hosted with PostgreSQL persistence.

The installation is licensed by a signed licence file verified offline. If a licence lapses, new business stops after a grace period. Servicing, collections, regulatory reporting, audit and exports never stop: a licence dispute is between IOTA and the institution, never with its customers.

## Implementation with IOTA

IOTA delivers SANAD in four steps.

1. **Assess and architect.** Products, channels, Shariah positions, credit policy, rails and the deployment target, agreed with the institution's business, credit, Shariah, risk and technology teams.
2. **Design for compliance.** The institution's configuration: catalogue, credit policy, approval tiers, document checklists, board positions and approvals, SLAs.
3. **Build and integrate.** Each rail connected and verified against the provider's sandbox with the institution's credentials. Core banking product mapping. Documents and letterhead. Staff identity. The institution's own regulatory citations confirmed.
4. **Run and improve.** Deployment, user acceptance with synthetic data, go-live, then operation and improvement by the same team that built it.

**What the institution provides:**
- its credit policy and product papers;
- its Shariah board's approvals and rulings;
- provider credentials and sandbox access for each rail;
- its core banking product configuration;
- its signing certificate, timestamping authority and HSM;
- its letterhead;
- its identity provider;
- its deployment platform.

## Roadmap

These functions are specified and planned. They are named here so that the boundary of what is available is clear.

- Counterparty onboarding, verification exceptions and screening-hit queues as dedicated screens.
- Decision traces, credit policy versions and portfolio concentration as dedicated screens.
- Wasl drawdowns, reschedule and hardship plans; credit-bureau reporting of Wasl facilities.
- Template management and a template-drift screen for all products; Murabaha contract documents rendered as PDF and shown in the distributor portal.
- Audit packs as sealed PDF.
- User and entitlement management, configuration and multi-tenant administration screens.
- SAML sign-in, alongside OpenID Connect.
- The partner settlement feed for embedded finance, and revenue-linked collection for Islamic institutions where boards rule it determinate.

## Glossary

| Term | Meaning |
|---|---|
| **APR** | Annual percentage rate: the effective annual rate equating disbursements and repayments, fees included |
| **Fingerprint** | The SHA-256 hash of a document or record. Any change produces a different fingerprint |
| **Four eyes** | No person decides their own work. A second, different person approves |
| **Murabaha** | Sale at cost plus a disclosed profit, payable on a deferred schedule |
| **Tawarruq** | The institution sells a commodity on deferred terms; the customer sells it on for cash |
| **Wa'd** | A binding promise, here the distributor's promise to buy |
| **‘Inah** | A sale and buy-back between the same parties, which Shariah prohibits; prevented by distinct parties |
| **Purification** | Giving away income found to be impermissible |
| **Risk period** | The interval the goods must be held at the institution's own risk before they can be sold |
| **Integration-ready** | Built and working against a recorded simulation of the provider; the live connection is made during implementation |

## Contact

IOTA Technologies · Riyadh · Dubai · London
engagements@iotatechnologies.ai · iotatechnologies.io

---

*This material is general information about IOTA Technologies' services and is not legal, regulatory or compliance advice, nor a compliance opinion on any specific circumstance. References to SAMA, NCA, NDMO and PDPL are context. Regulatory thresholds are configured by each institution and confirmed against the current rulebook during implementation. Engagements are governed by separate written agreements.*
