---
title: Product Guide
subtitle: Loan origination for banks, finance companies and fintechs in the Kingdom. Embedded lending, buy now pay later and conventional finance on one engine, with Shariah compliance enforced by the system wherever an institution is Islamic.
edition: Kingdom of Saudi Arabia
classification: Client
version: 2.0
date: 5 November 2026
---

## About this guide

This guide describes SANAD (سند, "support") for an institution regulated by the Saudi Central Bank (SAMA): what each function does, who uses it, how it is controlled, and where it stands today. It is written for the business, credit, Shariah, operations, risk and technology teams who evaluate a lending platform, and for the people who will run it.

This edition replaces version 1.0 of 27 October 2026. It leads with the three lines of business most Saudi institutions ask about first: **embedded lending, buy now pay later (BNPL) and conventional loan origination**. It sets out how SANAD keeps Islamic products Shariah-compliant on the same platform, and it closes with a plain account of what is built, what is in progress and what remains.

A companion **Product Guide, United Arab Emirates** covers the UAE edition. The **API Catalogue** describes every interface in technical detail.

### How to read the status of a function

| Status | Meaning |
|---|---|
| **Available** | Built, working end to end and demonstrable today. |
| **Verified live** | Built, and its live connection has made a verified call against the provider's sandbox. |
| **Integration-ready** | Built and working against a recorded simulation of the provider. The live connection is made and verified during implementation, with the institution's own credentials and the provider's sandbox. |
| **On the board's ruling** | Built, and enabled for an institution only once its Shariah board has ruled and its approval is recorded. |
| **Planned** | Specified and on the roadmap, not yet built. |

A rail is never described as integrated until a live call has been verified. SANAD's screens say so too: a simulated answer is labelled on screen, and a deployment holding real customer data refuses simulated answers outright.

## Where SANAD stands, November 2026

:::key In one paragraph
SANAD is built end to end for the Kingdom and demonstrable today on synthetic data: seven product modules, the full origination journey, servicing and collections, Shariah governance, and all thirteen Saudi integration rails on recorded simulations. On 3 November 2026 the first BNPL purchase was booked through SANAD into the Tuum core banking sandbox, the first verified live call of a SANAD booking. What remains before a first institution goes live is mostly the institution's own: live rail credentials, its Shariah board's approvals and rulings, its regulatory citations, and its infrastructure in the Kingdom.
:::

| Area | Where it stands |
|---|---|
| **Embedded lending** | Available. Partner-raised merchant finance, fixed instalments or revenue-linked collection, partner settlement reconciliation. The partner's settlement feed connects during implementation |
| **Buy now, pay later** | Available. Merchant onboarding, checkout, the shopper's choice of collection channel, each purchase booked as a loan in the core and serviced there. Booking verified live against Tuum's sandbox |
| **Conventional consumer term finance** | Available. Benchmark-linked pricing, platform APR, full SAMA disclosure, deduction-ratio check |
| **SME term finance** | Available, conventional. The Tawarruq variant is on the board's ruling |
| **Islamic products** | Wasl Murabaha supply-chain finance and personal finance by Tawarruq available; SME Tawarruq on the board's ruling. Every Islamic product is gated by a Shariah approval in force |
| **Shariah governance** | Available. Approvals register, daily automated Shariah review, incidents, purification, the Board's audit workspace and report |
| **Saudi rails** | Integration-ready, all thirteen. Each is verified live with the institution's credentials during implementation |
| **Core banking (Tuum)** | BNPL booking verified live. Murabaha and rate-priced bookings integration-ready |
| **Documents (Nutrient)** | Available: bilingual offer letters, document reading and checks. Seal and e-signature integration-ready |
| **Production** | Not yet in production with an institution. Development and testing hold synthetic data only |

## SANAD at a glance

SANAD is a loan origination platform for the Kingdom. It takes an application from first contact through decision, offer, signature, booking and servicing, and it keeps the evidence of every step.

It is built for lending that has to answer to a regulator and, for Islamic products, to a Shariah board. Most origination systems treat compliance as a set of reports produced afterwards. SANAD treats it as a set of properties the system cannot violate. A Murabaha sale cannot be offered before the institution owns the goods. A BNPL plan cannot carry a cost to the consumer. An offer cannot be shown without its full disclosure. In each case the system refuses, and says which control refused.

| | |
|---|---|
| **Products** | Embedded merchant finance, buy now pay later, conventional consumer term finance, SME term finance (conventional and Tawarruq), personal finance by Tawarruq, Murabaha supply-chain finance (Wasl, وصل) |
| **Channels** | Partner API, embedded aggregators, merchant checkout, consumer web, branch and back-office workbench, SME distributor portal, hand-over from the institution's customer-record system |
| **Saudi rails** | Nafath, Yakeen, Tahaqoq, SIMAH, Bayan, Wathq, GOSI, ZATCA (FATOORA and tax status), Open Banking, SADAD, payments hub, rate publisher, commodity broker |
| **Core banking** | Tuum. Booking by loan contract for BNPL and rate-priced products, and by account postings for Murabaha |
| **Documents** | Nutrient Document Engine and viewer. Bilingual offer letters, institutional seal, document reading |
| **Shariah governance** | Approvals register, daily automated Shariah review, incidents, purification, read-only audit workspace and report for the Board |
| **Language** | Arabic-first, right to left, with English. Gregorian and Hijri (Umm al-Qura) dates wherever a date has contractual effect |
| **Deployment** | In the Kingdom: on the institution's own OpenShift, or on an in-Kingdom cloud the institution has SAMA approval for |

## Islamic and conventional on one platform

Some Saudi institutions run Islamic and conventional business side by side; many are Islamic outright. SANAD serves both without letting one bend the other. **Shariah compliance is a property the system enforces, not a report it produces.**

### How Islamic values are kept

- **Every product declares its family.** Each product module is either Islamic or conventional, in code. An Islamic module carries its own non-negotiable rules, enforced by automated tests on every change. They are stricter than the platform's and cannot be relaxed by configuration.
- **The institution chooses what it offers.** Each institution has its own product catalogue, changed only under four eyes. An Islamic institution's catalogue lists Islamic products only, so interest-based products are not offered to its customers.
- **No approval in force, no new Islamic business.** An Islamic product cannot be enabled, quoted, accepted or executed unless the Shariah board's approval its configuration cites is in force that day and covers it. When an approval passes its review date, new business stops on its own.
- **The board's rulings are configuration, under four eyes.** The risk-holding period, excluded goods, approved contract templates, late-amount treatment and purification method are the board's positions, held as data and changed only with a second approval. Two boards that rule differently run the same software.
- **Islamic contracts are structured as trade, not lending.** In Wasl there is no rate anywhere in the contract or the servicing record. The profit is an amount fixed once, the total never increases, and late amounts go to charity, never to income. A Murabaha is never booked in the core as an interest-bearing loan.
- **The board can check for itself.** A daily automated Shariah review re-checks every live Murabaha transaction from its own record. The board's auditor has a read-only workspace that replays any transaction from its evidence, without technical help.

### Conventional products, kept apart

Conventional consumer and SME term finance are interest-based. They are offered only to institutions, or lines of business, that are conventional. A conventional product's rules never reach an Islamic product: the modules are isolated from each other, so a change to a conventional product cannot alter an Islamic one.

### Where BNPL and embedded lending sit

- **BNPL is interest-free to the consumer by construction.** The shopper pays the basket price and nothing more; the APR is 0.00%, and the platform refuses any cost to the consumer. For an Islamic institution the board rules on the merchant discount and on how a late payment is treated. A dedicated Islamic BNPL configuration, with late amounts to charity and the board's approval gate, is planned.
- **Embedded lending fixes the total at inception.** The profit is an amount fixed when the finance is agreed; revenue-linked collection changes when the merchant pays, never how much. For an Islamic institution, the board rules on who the seller is and whether a share-of-sales collection is determinate before the Islamic variant is enabled.

:::note What SANAD does and does not claim
SANAD enforces the rulings of the institution's Shariah board and gives the board the evidence to verify them. It does not issue rulings, and it does not certify a product as Shariah-compliant; that is the board's role. An institution that is Islamic outright can run SANAD with Islamic products only, every one of them gated by its board's approval.
:::

## How SANAD is built

SANAD has three layers, and the boundary between them is enforced by automated tests on every change.

```
   Channels  ───▶  ORIGINATION ENGINE  ───▶  Core banking (Tuum or the institution's own)
                   applications · applicants · decisioning · workflow ·
                   maker-checker · documents · consent · exceptions · SLA · audit
                              │
                   PRODUCT MODULES
     Embedded · BNPL · Conventional term · SME term · Tawarruq · Wasl Murabaha
                              │
                   SAUDI INTEGRATION RAILS
     Nafath · Yakeen · Tahaqoq · SIMAH · Bayan · Wathq · GOSI · ZATCA ·
     Open Banking · SADAD · Payments hub · Rate publisher · Notifications
```

- **The engine is product-agnostic.** It knows applications, applicants, decisions, workflow, documents and money. It does not know whether a product is a Murabaha or a term loan.
- **Each product module owns its contract.** Its pricing method, disclosure, schedule, execution sequence and its own rules. Modules are isolated from each other, so a change to BNPL cannot alter a Murabaha.
- **Every institution-specific ruling is configuration.** Credit policy, product catalogue, Shariah board positions, document checklists, approval tiers, partner entitlements and service levels are data, effective-dated and changed under four eyes.
- **Adapters own the vendors' vocabulary.** No provider's data model reaches the engine. Replacing a provider is writing a new adapter, not changing the platform.

The test applied to every change is simple: would the next institution want exactly this behaviour? If not, it belongs in configuration, a product module or an adapter.

## Products for the Kingdom

| Product | Journey starts from | Family | Status |
|---|---|---|---|
| **Embedded merchant finance** | An amount, raised by a partner | Conventional; Islamic on the board's ruling | Available |
| **Buy now, pay later** | A basket at checkout | Interest-free to the consumer | Available; booking verified live |
| **Conventional consumer term finance** | An amount | Conventional | Available |
| **SME term finance** | An amount, by product variant | Conventional | Available |
| **SME finance by Tawarruq** | An amount, by product variant | Islamic | On the board's ruling |
| **Personal finance by Tawarruq** | An amount | Islamic | Available |
| **Wasl, Murabaha supply-chain finance** | A cleared invoice (trade-first) | Islamic | Available |

Every product shares one engine for intake, consent, bureau, affordability, decisioning, approval tiers, documents, disclosure, signature, booking and servicing. What differs is what the product module decides.

## Embedded lending

Merchant finance raised by the partner or aggregator the merchant trades through, under a merchant mandate. The partner's platform is the channel; the institution remains the lender, decides every application and keeps the evidence.

### How it works

1. **The partner raises the request** through the partner API, or nominates the merchant through the embedded aggregator channel, within its entitlement.
2. **The engine checks the partner first.** Each partner has a status, a channel, the programmes it may use and a per-request maximum, set in Administration. A partner suspended there is refused on its next call. A quote carries the partner that raised it and is refused without one.
3. **The merchant is decided like any applicant:** consent, bureau enquiry, the institution's credit policy and approval tiers. There is no approval without a bureau result.
4. **The offer fixes the total.** The profit is an amount fixed at inception from the institution's catalogue. It never increases, whichever collection mode is used.
5. **Disbursement and bureau reporting** are queued once each when the finance is booked.

### Collection

| Mode | How it works | Status |
|---|---|---|
| **Fixed instalments** | A dated schedule, collected like any other instalment | Available |
| **Revenue-linked holdback** | The partner sweeps an agreed share of the merchant's revenue each period. Only where the institution's catalogue permits it | Available |
| **Partner settlement reconciliation** | Each sweep is checked against the agreed share of the reported revenue, and against the fixed total. An under-sweep becomes an exception for a person. An over-collection is refunded, never kept and never silently netted | Available |
| **Partner settlement feed** | The connection that brings each partner's settlement file in automatically | Planned, per partner, during implementation |

### For an Islamic institution

The Islamic variant is enabled only on the board's ruling. The board decides two things: who the seller is and what the goods are, so that the structure is a genuine sale; and whether a share-of-sales collection, which has no fixed final date, is determinate enough to be permitted. Where a board does not permit revenue-linked collection, fixed instalments remain available.

## Buy now, pay later

A basket split into equal instalments at no cost to the consumer. The merchant pays a discount; the consumer pays the basket price and nothing more. Built to the SAMA Rules for Regulating Buy Now Pay Later Companies (November 2023), with each requirement placed where it is enforced.

### The rules, and how they are applied

| Rule | How it is applied |
|---|---|
| No cost to the consumer (Articles 1, 20(1)) | The pricing refuses any consumer cost. The APR is 0.00%, and the platform computes and discloses it anyway |
| Ceiling (Articles 22(1), 22(2)) | A consumer limit up to the SAR 10,000 ceiling and at most 12 instalments. The institution sets its own limit within it |
| Electronic collection only (Article 22(3)) | Only electronic channels the Kingdom carries can be chosen. No cash |
| Eligibility (Articles 20(3)–(5)) | No consumer under 18 Hijri years; residency; riyals only |
| Identity (Articles 19(6), 21(2)) | From a reliable independent source, with the shopper signing in through Nafath |
| Bureau (Articles 19(2), 19(3)) | An enquiry with consent before dealing; the facility reported after booking; overdue instalments reported |
| Disclosure and acceptance (Article 19(4)) | Shown and agreed before dealing. The acceptance records which disclosure version was shown |
| Merchants (Article 27) | A store contract in place before the merchant can open a checkout |

### The journey

1. **Merchant onboarding.** A maker onboards the merchant; a different person verifies it against its store contract. One commercial registration, one merchant. A suspended merchant is refused at checkout at once.
2. **Checkout.** The merchant creates a checkout session through the merchant checkout API. The shopper signs in with Nafath, sees the disclosure for exactly that basket, and accepts or declines.
3. **The shopper chooses how to pay** each instalment, from the channels the Kingdom carries: a SADAD bill, a card through the institution's payments hub, Open Banking payment initiation, or their own account with the institution.
4. **Booking in the core.** Each accepted purchase is booked as an interest-free loan in the institution's core banking system, which then holds the schedule. The plan is set in the institution's term sheet, in days (for example four payments thirty days apart) or in months.
5. **Servicing.** SANAD collects each instalment through the channel the shopper chose, posts each settled collection into the loan, and reports an overdue instalment to the bureau and reminds the shopper, once each. A returned collection is recorded as returned.

### The BNPL workbench

The operations workbench has its own BNPL screen: the institution's loans, filtered by stage (not booked, active, overdue, paid in full), with each loan's repayment progress and next due date. Selecting a loan shows its amount, where it is in its life, its instalments as the core holds them, its servicing, and every event in order. Booking and servicing are actions for authorised staff only.

### Verified live with Tuum

On 3 November 2026 a BNPL purchase was booked through SANAD into Tuum's sandbox end to end: the customer, the servicing account, the offer, the schedule checked against the plan disclosed, the payment instruction and the confirmed contract. A retry was recognised as the same booking and created nothing twice. Activation of a confirmed contract, and the posting of repayments into it, are being confirmed with Tuum.

## Conventional loan origination

### Conventional consumer term finance

A reducing-balance consumer loan with equal monthly instalments, for conventional institutions.

- **Pricing.** From a benchmark plus the institution's margin, or a catalogue rate, through the rate publisher. The rate on the offer is a sourced, dated snapshot. A stale or missing benchmark refuses the quote.
- **Schedule.** Integer arithmetic: the instalments sum exactly to what is owed.
- **Disclosure.** The full SAMA consumer set with the platform-computed APR, in Arabic and English, before acceptance.
- **Affordability.** The institution's deduction-ratio cap, from GOSI salary and Open Banking account facts. A quote over the cap is refused.
- **Bureau.** No approval without a bureau enquiry; disbursement once and reported once.

### SME term finance

Business term finance for small and medium enterprises, sized by the SAMA definition of SMEs (Circular 381000064902), for a bank or a finance company.

- **Intake and KYB.** Commercial registration, the request, parties and ownership, with beneficial owners checked against the 25% threshold. Wathq, Yakeen, sanctions and PEP screening, zakat status, SIMAH commercial report and Open Banking statement facts, each under the subject's consent.
- **Assessment.** Bureau score, debt-service cover, current ratio, sales growth and owner debt burden as knock-outs. A weighted applicant and project scorecard; risk bands with maximum financing and conditions; straight-through or committee.
- **Security.** Collateral and guarantees with valuation and lending value after the institution's haircuts.
- **Pricing and schedule.** SAIBOR-3M plus the institution's margin from the rate publisher, with the publisher's reference kept on the offer. A dated ACT/365 schedule that matches the core banking system to the halala, and the platform APR on the offer.
- **Closing.** Conditions precedent, a verified payee IBAN, disbursement through the payments hub, SIMAH reporting at booking, and booking in Tuum as a loan contract on SANAD's own terms.

The **Tawarruq variant** is offered as a deferred sale: commodity cost, profit and deferred price, with the letter in profit terms. Between signature and disbursement the commodity is bought at exactly the quoted cost, sold to the customer on the signed instrument, title passed, and sold on. Disbursement is a single payment of the proceeds. It is enabled on the board's ruling.

### One APR for the whole platform

**One function computes the APR for every product**: the effective annual rate that equates the present value of disbursements and repayments, fees included, in integer arithmetic. No product computes its own. Every consumer offer carries it, and the acceptance records which disclosure was shown.

## Islamic products

### Wasl, Murabaha supply-chain finance

The institution buys the goods a cleared e-invoice names, holds them at its own risk for the period its Shariah board sets, and sells them to the distributor at cost plus a disclosed profit amount, payable on a fixed schedule.

- **Trade-first.** There is no amount box. The amount is the invoice's.
- **No rate anywhere in the contract.** The profit is an amount, fixed once. The total can never increase.
- **Three gates with no override:** ownership, possession, and the risk-holding period. Nobody, at any level of authority, can pass a gate that is not met.
- **One leg, one document.** The promise (wa'd), purchase, sale offer and acceptance are separate, time-stamped instruments, each linked by its fingerprint to the one before.
- **Distinct parties.** Seller, buyer and institution are three distinct commercial registrations, so the structure cannot become ‘inah.
- **Each invoice is financed once.** A database registry makes duplicate financing structurally impossible.
- **Late amounts are never income.** They are charity, held in a segregated liability and given to a board-approved charity by two people.

Wasl is described end to end in its own chapter below.

### Personal finance by Tawarruq

The institution buys an identified commodity lot from a board-approved broker and sells it to the customer at cost plus profit on deferred monthly instalments. The customer, or the institution as agent where the board permits it, sells the lot on, and the proceeds are disbursed.

- Each step is attested after the one before: purchase, sale to the customer, title, onward sale, disbursement. Disbursement happens once, after the proceeds are realised.
- Priced from a benchmark plus the institution's margin, bounded by the market range from the rate publisher. A stale or missing benchmark refuses the quote.
- Affordability against the institution's deduction-ratio cap; full SAMA consumer disclosure, including the APR, before acceptance.
- Enabled only where the institution's Shariah board has ruled, and only while that approval is in force.

## Channels and surfaces

| Surface | Who uses it | What it does | Status |
|---|---|---|---|
| **Partner API** | Partner systems | Raise, read and withdraw requests; eligibility pre-check. Every channel lands in the same queue | Available |
| **Embedded nomination** | Aggregators | Nominate under a merchant mandate, within the partner's entitlement | Available |
| **Merchant checkout** | Merchants and their shoppers | BNPL sessions: create, read, cancel; shopper sign-in, disclosure, choice of collection channel and acceptance | Available (Nafath integration-ready) |
| **Consumer web** | Individuals | Sign in with Nafath; apply by amount; see the full disclosure; accept | Available (Nafath integration-ready) |
| **Operations workbench** | The institution's staff | Every journey, Arabic-first. A short list of pinned shortcuts and an all-modules page that lists every function with its status | Available |
| **Dashboard** | Managers, team leads | Work awaiting review against the institution's own service levels, open pipeline, approvals and declines, a "needs attention first" list | Available |
| **Review queue** | Checkers, senior checkers, committee | Oldest first. Service-level breaches in words. Own work visible but not actionable. No bulk approval | Available |
| **BNPL loans** | Operations, finance | The BNPL book by stage, each loan's position in the core, booking and servicing | Available |
| **SME distributor portal** | Distributors' authorised signatories | Sign in with Nafath as a configured signatory; accept a Murabaha sale by signing its fingerprint | Available (Nafath integration-ready) |
| **Business hand-over API** | The institution's customer-record system | Hand a verified SME application to credit | Available |
| **Administration** | Platform administrators | Configuration under four eyes | Available |

## The origination journey, function by function

### Intake and know your customer

| Function | What it does | Status |
|---|---|---|
| Amount-first intake | Consumer, BNPL, embedded and term products open with an amount; the product decides the journey's shape | Available |
| SME intake | Commercial registration, the request, parties and ownership. Beneficial owners checked against the 25% threshold. A reachable contact for each signing party before hand-over | Available |
| KYB checks | Wathq, Yakeen, sanctions and PEP screening, zakat status, SIMAH commercial report, Open Banking statement facts. Each fetched under the subject's consent; the officer keys none of the answers | Integration-ready |
| Consent | Purpose-bound consent records (bureau, screening, identity, documents, employment, account information, payment initiation, partner data sharing, notifications). Withdrawal is a new record. **Every rail adapter checks the consent itself before calling out** (PDPL purpose limitation, in code) | Available |

### Decisioning and approval

| Function | What it does | Status |
|---|---|---|
| Eligibility pre-check | The institution's policy over the facts supplied, answered approve, refer or decline with reason codes. Nothing stored | Available |
| Decision engine | A closed policy language: no loops, no clock, no hidden inputs. Its failure mode is refer, never approve. The decision records the policy version it ran under | Available |
| Affordability | Deduction ratio for consumers from GOSI salary and Open Banking facts; BNPL consumer limit; debt-service cover and revenue share for SMEs | Available (rails integration-ready) |
| Approval tiers | Checker, senior checker and credit committee by amount, set by the institution. A decision beyond a person's authority is refused | Available |
| Maker-checker | The person who keyed, presented or submitted never decides. Enforced by identity, not by role | Available |
| Decision pack | The credit memo from the record. Every deviation justified before approval. Frozen by fingerprint at approval | Available |
| Exceptions | An exception has an owner, a service level and a mandatory resolution. It is never silently dropped | Available |

### Documents

| Function | What it does | Status |
|---|---|---|
| Checklists | Per product and variant, with validity windows | Available |
| Upload and validation | File type read from the bytes. Stored by fingerprint. Pending until a different person validates it | Available |
| Document reading | Classifies each upload, reads issue, expiry and statement dates, and runs the checks the checklist declares. Findings are shown to the checker, never decided on: **a person always validates** | Available |
| Authenticity with the issuer | Saudi national documents checked with Tahaqoq, under the applicant's consent | Integration-ready |
| Gaps and requests | Missing, expired or failing documents listed in plain words; one request to the applicant | Available |

### Offer, disclosure and acceptance

| Function | What it does | Status |
|---|---|---|
| Quotation | Computed by the product module from the institution's effective-dated catalogue. A benchmark-linked product is refused if the benchmark is stale or missing | Available |
| Disclosure | Financing amount, term, instalment, total cost of credit, total payable, APR and every fee, in Arabic and English, before acceptance | Available |
| Offer letter | Bilingual, fingerprinted, with a dated schedule, the APR, and Hijri dates beside Gregorian. Rendered to PDF with the institution's letterhead | Available |
| E-signature | Through Nafath. The signing intent carries the document's fingerprint | Integration-ready |
| Institutional seal | The signed letter sealed with the institution's PAdES signature | Integration-ready |

### Closing, booking and disbursement

| Function | What it does | Status |
|---|---|---|
| Conditions precedent | Each evidenced by a document and verified by a second person. Disbursement refused until all are met | Available |
| Payee | A Saudi IBAN, checked for format and checksum, proven by a document and confirmed by a second person | Available |
| Disbursement | Through the institution's payments hub. Each instruction idempotent, on a transactional outbox. Finance releases it; finance is never the approver | Integration-ready |
| Bureau reporting | The facility reported to SIMAH once at booking, then its monthly status | Integration-ready |
| Booking | In Tuum. See the chapter on core banking | BNPL verified live; others integration-ready |

## Servicing and collections

| Function | What it does | Status |
|---|---|---|
| Position | Arrears, days past due and bucket, oldest instalment first. For BNPL, the core's own position for a chosen date | Available |
| Collections | Through the channel the customer chose: SADAD bill, card through the payments hub, Open Banking payment initiation or own account. Each result becomes a receipt once | Integration-ready |
| Manual receipts | Recorded by finance. A receipt counts once a second person confirms it | Available |
| Bureau reporting | Monthly status reported once; overdue and settled reported once | Integration-ready |
| Late charges | Once per instalment overdue beyond the grace days. A fee on a conventional loan; **a charity obligation on an Islamic facility, never income**. Waived only by a second person | Available |
| Hardship hold | Pauses collections and charges. Lifted by a second person | Available |
| Restructuring | A conventional loan is re-amortised at its signed rate. An Islamic facility is re-spread with its total unchanged. In force only after a second approval | Available |
| Daily cycle | Reconciliation, the Shariah review, late charges, collections and bureau status, each idempotent, on a durable workflow worker | Available |

## Wasl, Murabaha supply-chain finance, end to end

Wasl finances the goods an anchor sells to its distributors. The institution enters the chain as a real buyer and seller, not as a lender in a buyer's clothes.

### The book

| Function | What it does | Status |
|---|---|---|
| Programmes and anchors | Each programme has its anchor, its limit and the account the anchor is paid at. Changed under four eyes, checked against live exposure | Available |
| Facilities | Credit proposes a distributor's limit; a different person approves it. **No facility, no trade** | Available |
| Concentration | The institution chooses which rules apply: a cap on a single trade, a distributor's share of its programme, an anchor's share of the book | Available |
| Goods register | The board's excluded goods by HS heading. An excluded line refuses the trade | Available |
| Financed-invoice registry | A second financing of the same invoice is refused by the database | Available |

### The sequence

1. **Approval opens a transaction**, with the goods screened and the profit amount fixed from the catalogue.
2. **Trade validation.** Distinct parties checked; the cost held against the facility, the programme and the concentration rules.
3. **The wa'd and the purchase**, as separate instruments from board-approved template versions, time-attested and linked.
4. **Gate 1, ownership.** The anchor's e-invoice to the institution, cleared by ZATCA.
5. **Gate 2, possession.** Delivery evidence validated by a second person.
6. **Gate 3, the risk period.** The goods held at the institution's risk for the board's interval, measured between attested instants from an accredited timestamping authority.
7. **The sale offer** states cost, profit, the fixed sale price and the due dates in both calendars. It lapses if not accepted in time.
8. **Acceptance.** The distributor's authorised signatory signs the offer's fingerprint with Nafath.
9. **Booking.** The obligation is fixed in SANAD; the receivable is booked in Tuum as account postings, never as a loan contract.

### Settlement and collection

| Function | What it does | Status |
|---|---|---|
| Seller payment | To the anchor at the purchase, through the payments hub, once | Integration-ready |
| Collection | SADAD bills from seven days before each due date. The institution remains the biller | Integration-ready |
| Reconciliation | SADAD's paid-bills file matched each morning; everything unmatched becomes an exception | Integration-ready |
| Late amounts | Proposed at the board's fixed amount after its grace period; assessed for ability to pay; confirmed by a second person; billed separately; raised to the charity liability on collection and given to a board-approved charity by two people | Available (rails integration-ready) |

## Shariah governance

SANAD gives the institution's Shariah board and reviewers their own tools. Their decisions bind the system, and they can verify any transaction themselves. **Status of everything in this chapter: Available.**

- **Approvals register.** Each approval the board issues is recorded with its body, reference, members, dates, and the products and template versions it covers. A reviewer records it and a second confirms. Suspension, reinstatement, withdrawal and renewal go the same way. No approval in force, no new Islamic business; contracts already executed keep the approval they were made under.
- **The daily Shariah review.** Each morning every live Murabaha transaction is re-checked from its own record: the contracts' chain and order, the evidence at each gate, the risk period, distinct parties, the goods against the register, that the sale price equals cost plus profit, and **template drift**, by rebuilding each executed document from its approved template and comparing fingerprints.
- **Incidents.** Each failure is raised once, rated low, medium, high or material, and worked by the reviewers to closure by a different reviewer. An open material incident stops the wa'd, the purchase and the sale offer. Unwinding is never stopped.
- **Purification.** Where income was affected, a reviewer proposes the amount by the board's method and a second confirms. It is raised to the segregated charity liability as each instalment is collected and given away by two people. The incident closes only when every share is raised, which the database checks against the ledger.
- **Audit workspace and Board report.** A read-only workspace for the Board's auditor: search or a reproducible sample; a replay of each transaction from its evidence; an audit pack whose manifest fingerprints each part; observations that become incidents. The Board report covers any period and is printable for the annual Shariah report.

## Saudi integration rails

Every rail follows the same pattern: an interface named for the capability, not the vendor; a recorded simulation for testing and demonstration; a live connection through the institution's own egress; a circuit breaker; and credentials held in the vault. Every rail **refuses to call without the subject's consent** where consent is required, keeps the decision-relevant result and the provider's reference, never a copy of the provider's file. **A rail being down never approves anything.**

| Rail | What SANAD uses it for | Status |
|---|---|---|
| **Nafath** | Sign-in and step-up for applicants, shoppers and distributors; signing intent bound to the document's fingerprint | Integration-ready |
| **Yakeen** | Identity attributes against national records | Integration-ready |
| **Tahaqoq** | Authenticity of national documents | Integration-ready |
| **SIMAH** | Consumer and commercial reports and scores; **mandatory reporting** of new facilities and their status | Integration-ready |
| **Bayan** | Alternative bureau; the institution chooses primary and fallback | Integration-ready |
| **Wathq** | Commercial registration, legal form, activities, signatories | Integration-ready |
| **GOSI** | Employment and registered salary for affordability | Integration-ready |
| **ZATCA FATOORA** | Clearance of the anchor's invoice for Murabaha ownership | Integration-ready |
| **ZATCA tax status** | Zakat and tax certificate status for SME eligibility | Integration-ready |
| **Open Banking** | Affordability facts from account information; payment initiation for collections | Integration-ready |
| **SADAD** | Bill presentment and collection; paid-bills reconciliation | Integration-ready |
| **Payments hub** | Disbursements, card collections and payments (SARIE, mada, internal transfer) | Integration-ready |
| **Rate publisher** | Benchmarks (SAIBOR) and market APR ranges. It informs pricing; it never sets a customer's rate | Integration-ready |
| **Commodity broker** | Tawarruq purchase, title and onward sale | Integration-ready |
| **Notifications** | SMS, email and push, by party reference | Integration-ready |

## Core banking with Tuum

SANAD originates, decides, prices, documents and executes. Tuum is the system of record once a facility is booked. SANAD hands the facility to Tuum through a vendor-neutral interface, so nobody re-keys the deal into the core, and every booking is idempotent, so a retry never books twice.

| What is booked | How | Status |
|---|---|---|
| **BNPL purchase** | An interest-free loan through Tuum's offer workflow; the schedule checked against the plan disclosed before the contract is confirmed | Verified live, 3 November 2026 |
| **Conventional and SME loans** | A loan contract on the signed terms. SANAD sends its own rate and APR; if Tuum answers with a different rate, the booking is refused | Integration-ready |
| **Wasl Murabaha** | Account-shaped: the distributor as a party, its collection account, and one posting at the fixed sale price. No rate reaches the servicing record the Shariah board audits | Integration-ready |
| **SME Tawarruq** | A loan contract, with the deferred price authoritative in SANAD and reconciled. The institution's board gives its view on this before go-live | On the board's ruling |
| **Charity liability** | Collected late amounts and purified income posted to a segregated charity liability. The interface has no way to post them to income | Integration-ready |

**Vendor neutrality.** Tuum's vocabulary lives only in its adapter. An institution with another core banking system gets a sibling adapter, not a different platform.

## Documents with Nutrient

SANAD composes its documents itself. The Nutrient Document Engine, deployed on the institution's own hosts, prints, seals and reads them, so documents never leave the institution's trust boundary.

| Function | What the institution gets | Status |
|---|---|---|
| Offer letters as PDF | Bilingual, Arabic governing and right to left beside English, on the institution's letterhead, fingerprinted and tied to the version the customer signs | Available |
| Institutional seal | PAdES signature with the key in the institution's own signing service and HSM | Integration-ready |
| Document reading | Text and tables extracted locally; SANAD's rules classify the document and run the checklist's checks for the checker | Available |
| Secure viewer | Loads from SANAD's own origin with a short-lived token for one document | Available |

## Administration and configuration

Every change is an effective-dated revision. One administrator proposes it and a different one approves it. Nothing changes until it is approved, and every change is recorded in the audit chain.

| Area | What is configured | Status |
|---|---|---|
| Products and modules | Term sheets, pricing rules, variants, BNPL plan intervals in days or months, enable or disable, mapping to core banking products. An Islamic product needs a board ruling and an approval in force | Available |
| Partners | Partners and aggregators, their channels, programmes and per-request limits; agents; approval tiers | Available |
| Merchants | BNPL merchants, verified by a second person, suspended or reinstated | Available |
| Rails and credentials | Per capability: the adapter, its fallback and address. Credentials saved and rotated into the vault; values never shown; every read audited | Available |
| Staff identity | The institution's identity provider (OpenID Connect) and the mapping of its groups to authorities, including Shariah reviewer and Shariah auditor. Step-up before approvals | Available (live sign-in verified during implementation) |
| Wasl book and board positions | Programmes, concentration, the goods register, risk period, late amounts and purification | Available |
| Jurisdiction and licence | The deployment behaves as the Kingdom (SAR, SAMA); the installation's licence | Available |

## Security, residency and compliance

| Area | How SANAD addresses it |
|---|---|
| **Data residency** | Customer data is processed and stored in the Kingdom. The database refuses to mark an environment as holding production data unless its region is in the Kingdom and its keys are in a customer-managed HSM. Development and test environments hold synthetic data only |
| **Tenant isolation** | Every table carries the institution and row-level security, enforced by the database. The institution and channel always come from the authenticated identity, never from a request |
| **Audit** | Every decision, approval, acceptance, document and state change writes an event to a per-institution hash chain in the same transaction, verified daily and independently |
| **Trusted time** | Contract steps are time-attested through RFC 3161 by the institution's accredited timestamping authority, never by a server clock in production |
| **Secrets** | Held only in the vault. Every read is audited. Never logged, traced or returned |
| **Personal data** | No national identifier or personal datum in any log, trace, metric or error. Consent is purpose-bound and checked before every rail call |
| **Money** | Integer minor units and basis points. No floating point anywhere in the financial path |
| **Four eyes** | Enforced by identity on every decision, and by the database on configuration, jurisdiction and licence changes |
| **Frameworks** | Designed to NCA ECC-2:2024, SAMA Cyber Security Framework, PDPL and NDMO, and to OWASP ASVS Level 2, with Level 3 for authentication, cryptography, signing, Murabaha sequencing and the audit chain |
| **Engineering controls** | Every change passes static analysis with SANAD's own invariant rules, secret scanning, dependency and licence checks, a software bill of materials, container scanning, an adversarial compliance suite and the full test suite. A finding blocks the merge |

## Deployment options

| Option | Description |
|---|---|
| **On the institution's OpenShift, in the Kingdom** | SANAD's containers on the institution's own platform with in-Kingdom PostgreSQL, the institution's HSM and its API Connect and DataPower |
| **On an in-Kingdom cloud** | Where the institution holds SAMA approval for an in-Kingdom cloud provider, under the same controls |

Durable workflows (multi-day origination, Murabaha sequencing, the daily cycle) run on Temporal, self-hosted with PostgreSQL persistence, on a standalone worker. The installation is licensed by a signed licence file verified offline. If a licence lapses, new business stops after a grace period; servicing, collections, regulatory reporting, audit and exports never stop.

## Delivery status in detail

### Built so far

| Area | What is built |
|---|---|
| **Engine** | Applications, applicants, consent, decision engine, approval tiers, maker-checker by identity, exceptions, service levels, audit hash chain, transactional outbox, idempotency on every change |
| **Embedded lending** | Partner entitlements, partner API and aggregator nomination, fixed and revenue-linked collection, partner settlement reconciliation with refunds of over-collection |
| **BNPL** | The module to the SAMA BNPL Rules; merchant onboarding under four eyes; merchant checkout API and shopper checkout with Nafath sign-in; the shopper's choice of collection channel; booking in the core; servicing with collections, posting, bureau reporting and reminders; the BNPL workbench |
| **Conventional** | Consumer term finance; SME term finance with intake, KYB, assessment, security, decision pack, offer letter, closing, booking and servicing; one platform APR; the full SAMA disclosure set |
| **Islamic** | Wasl end to end: facilities, programmes, goods register, the three gates, contracts, acceptance, booking, collection, reconciliation, late amounts to charity. Personal Tawarruq. SME Tawarruq, held until the board rules |
| **Shariah governance** | Approvals register, daily review, incidents, purification, audit workspace and Board report |
| **Documents** | Checklists, upload, four-eyes validation, document reading and checks, gap requests, bilingual offer letters on the institution's letterhead |
| **Rails and core** | All thirteen Saudi rails and Tuum on the common adapter pattern; BNPL booking verified live against Tuum |
| **Platform** | Arabic-first workbench, consumer web, distributor portal, Administration under four eyes, timestamping, standalone workflow worker, licensing, residency control |

### In progress and planned

| Item | Area | What it involves |
|---|---|---|
| Activation and repayment posting of BNPL loans in Tuum | BNPL | Confirming with Tuum how a confirmed contract is activated and disbursed, and posting repayments into an active loan |
| Collection results from the rails | BNPL, servicing | SADAD, card, Open Banking and account debit results recorded automatically as each rail reports them |
| Scheduled BNPL servicing | BNPL | Running consumer-loan servicing on the daily workflow schedule rather than by an operator |
| Islamic BNPL configuration | BNPL | Late amounts to charity and the board's approval gate for an Islamic institution offering BNPL |
| Partner settlement feed | Embedded | The connection that brings each partner's settlement file in automatically |
| Islamic embedded finance | Embedded | Enabled once the institution's board rules on the seller, the goods and share-of-sales collection |
| Islamic-only deployment setting | Platform | A setting that makes an Islamic institution's deployment refuse any conventional product outright, beyond its catalogue |
| Counterparty and decision screens | Workbench | Counterparty onboarding, screening hits and consents; decision traces and credit policy versions as dedicated screens |
| Wasl extensions | Wasl | Drawdowns, reschedule and hardship plans; bureau reporting of Wasl facilities; contract documents as PDF in the distributor portal |
| Sealed audit pack | Shariah | The Board's audit pack as a sealed PDF |
| Notification templates | Platform | The offer and information-request messages delivered by SMS and email |
| SAML sign-in | Platform | Alongside OpenID Connect |

### What each institution brings to go live

| Item | Why |
|---|---|
| **Sandbox and production credentials for each rail** | Each rail is verified live with the institution's own credentials before it carries real data |
| **Its Shariah board's approvals and rulings** | No Islamic business starts until the approvals are recorded; the board rules on Tawarruq, late amounts, purification, and Islamic BNPL and embedded variants |
| **Its regulatory citations** | Thresholds such as the deduction-ratio cap are configured by the institution with their citation, confirmed against the current SAMA rulebook |
| **Its credit policy and product papers** | Credit policy, catalogue, approval tiers and document checklists are the institution's own |
| **Its core banking configuration** | Tuum products, posting codes and account types for each product |
| **Its infrastructure in the Kingdom** | Deployment platform, PostgreSQL, HSM, accredited timestamping authority, signing certificate, identity provider, API gateway |
| **Its letterhead and merchant and partner agreements** | For documents, BNPL merchants and embedded partners |

## Implementation with IOTA

IOTA delivers SANAD in four steps.

1. **Assess and architect.** Products, channels, Shariah positions, credit policy, rails and the deployment target, agreed with the institution's business, credit, Shariah, risk and technology teams.
2. **Design for compliance.** The institution's configuration: catalogue, credit policy, approval tiers, document checklists, board positions and approvals, service levels.
3. **Build and integrate.** Each rail connected and verified against the provider's sandbox with the institution's credentials. Core banking product mapping. Documents and letterhead. Staff identity. The institution's regulatory citations confirmed.
4. **Run and improve.** Deployment, user acceptance with synthetic data, go-live, then operation and improvement by the same team that built it.

## Glossary

| Term | Meaning |
|---|---|
| **APR** | Annual percentage rate: the effective annual rate equating disbursements and repayments, fees included |
| **BNPL** | Buy now, pay later: a purchase split into instalments at no cost to the consumer |
| **Embedded lending** | Finance raised through a partner's platform that the merchant already trades through |
| **Fingerprint** | The SHA-256 hash of a document or record. Any change produces a different fingerprint |
| **Four eyes** | No person decides their own work. A second, different person approves |
| **Murabaha** | Sale at cost plus a disclosed profit, payable on a deferred schedule |
| **Tawarruq** | The institution sells a commodity on deferred terms; the customer sells it on for cash |
| **Wa'd** | A binding promise, here the distributor's promise to buy |
| **‘Inah** | A sale and buy-back between the same parties, which Shariah prohibits; prevented by distinct parties |
| **Purification** | Giving away income found to be impermissible |
| **Risk period** | The interval goods must be held at the institution's own risk before they can be sold |
| **Integration-ready** | Built and working against a recorded simulation of the provider; the live connection is made during implementation |

## Contact

IOTA Technologies · Riyadh · Dubai · London
engagements@iotatechnologies.ai · +966 50 534 0573 · iotatechnologies.io

---

This material is general information about IOTA Technologies' services and a product in development. It is not legal, regulatory, Shariah or compliance advice, nor a compliance opinion on any specific circumstance. Shariah compliance of any product is determined by the institution's own Shariah board. References to SAMA, NCA, NDMO and PDPL are context. Regulatory thresholds are configured by each institution and confirmed against the current rulebook during implementation. Engagements are governed by separate written agreements.
