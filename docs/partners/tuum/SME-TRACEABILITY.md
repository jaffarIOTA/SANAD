# SME direct lending — traceability from the Tuum prototype screens to the build

**Source.** Eleven prototype screens from Tuum for SME direct lending as it runs for the Khalifa
Fund for Enterprise Development (UAE). Received 2026-10-08, re-supplied 2026-10-09. Filed at
`docs/partners/tuum/prototype-2026-10-08/` as `01-…` to `11-…`, in journey order. Below, "the
fund" is that development fund, "the partner bank" is the disbursing bank on screen 09, "the
example applicant" is the business shown on every screen (application FR-00005061).

**Method.** Every screen was read at full resolution, with small text enlarged where needed. Every
field, figure, threshold, rule, button, integration and SLA visible on a screen is a row. Each row
was traced to the code or configuration that implements it (file:line or config key), and to a
test that proves it where one exists. The offer schedule was recomputed with our own quotation
code outside the repository (section 13). Read on 2026-10-09 against `main` at `a271b45`.

**Data protection.** The screens show what may be real personal data. None of it is copied here:
the applicant's name, email, mobile, Emirates ID, trade-licence number and bureau report number
are referred to by role only.

**Legend**

| Mark | Meaning |
|---|---|
| ✅ | Matches the screen |
| 🟡 | Partial, or built differently from the screen (the note says how) |
| ❌ | Missing |
| 🧪 | Built, but the value is illustrative and awaits the fund's own policy or product paper |
| ➖ | Outside Sanad's scope by the screens' own split: stages 1–4 in TAMM + Tuum CIF; stages 8–9 in Tuum LMS / ERP |
| ❓ | Question for Tuum (used in the Notes column; a row's status is one of the marks above) |

Paths are relative to the repository root. `business.ts` is `apps/ops/src/server/business.ts`;
`dashboard.ts` is `apps/ops/src/server/business-dashboard.ts`; `app.ts` is
`core/origination/business-application.ts`; `[app]` is `apps/ops/src/app/[locale]/business/[applicationId]`;
`catalogue` is `config/tenants/sme-fund-ae/products/catalogue.json`; `assessment.json` is
`config/tenants/sme-fund-ae/credit-policy/sme-assessment.json`.

---

## 1. Summary

### 1.1 Counts

156 rows (one per field, figure, rule, action or integration visible on a screen, plus four for
values the screens imply but do not show).

| Status | Count |
|---|---|
| ✅ matches | 67 |
| 🟡 partial / differs | 49 |
| 🧪 built, illustrative value awaiting the fund | 22 |
| ➖ out of Sanad's scope (stages 1–4, 8–9) | 11 |
| ❌ missing | 7 |

Read the 🟡 rows as the real work list: most are things built to a different shape (a manual
step where the screen shows an integration, a reference where the screen shows a file, a fixed
value where the screen shows a dropdown). The ❌ rows are: approved amount below requested,
LMS loan reference, the second contract with the partner bank, "Awaiting bank KYC", DoA tiers,
credit report notes, "Back to Tuum CIF".

### 1.2 The schedule

**Our quotation code reproduces the offer schedule on screen 09 to the fil**: level instalment
34,629.18, first-row interest 3,041.10, last instalment 34,629.04, total interest 77,750.66, total
2,077,750.66, every row shown on the screen identical. Basis: ACT/365, reducing balance, interest
rounded half up per period, disbursement on 2029-08-04 (a 37-day first period). The screen does
not show the disbursement date; 37 days is the only day count that yields 3,041.10. Details and
the screens' own inconsistencies are in sections 13 and 14.

### 1.3 The most important gaps (what Tuum asked for that we do not do, or do differently)

1. **No approved amount different from the requested amount.** The screens request AED 5,000,000
   and offer AED 2,000,000, capped by the risk band. We carry one amount from hand-over to offer:
   the committee approves or declines, but cannot approve a lower amount, so this case would be
   refused at offer generation (`AMOUNT_EXCEEDS_VARIANT`). (T-08-06, T-09-01)
2. **The scorecard does not reproduce the screen's scores.** For the example applicant's inputs we
   score applicant 92.50, project 70.00, cumulative 79.00 (LOW); the screen shows 90.59, 86.89,
   88.37 (LOW). The criteria, the 40/60 split, the knock-outs and the LOW-band terms match; the
   per-criterion weights and the scoring method (the screen's look continuous, ours are banded)
   do not, and the project weights cannot be derived from the screen. (section 6)
3. **No integration is live.** AECB is keyed manually from the stage-4 report; OCR has an ingest
   path but no OCR engine; UAE Pass signing, the partner-bank payment and the Tuum CIF / LMS
   hand-offs are fixtures or not built; no Oracle ERP task, no TAMM signing route. (T-03-13,
   T-03-15, T-11-01, T-11-12, T-11-13)
4. **The Facility Offer Letter is one structured, hashed, bilingual letter, not a PDF in two
   copies.** No PDF until the document platform is licensed; no second copy for the partner bank;
   signatories by role only, never by person name. (T-10-01, T-10-10, T-11-07)
5. **Portfolio and collections signals are not there.** No month-on-book, EWS alert, 60-day alert,
   "awaiting bank KYC" or LMS loan reference; stage 8–9 status is a manually recorded loan-system
   report. This is largely Tuum LMS scope by the screens' own split, but the dashboard shows it.
   (T-01-21 to T-01-23, T-09-03, T-01-26)

Smaller differences worth naming in the walkthrough: documents are not transferred with the
hand-over (T-03-03); the document grouping and the Arabic labels differ (T-05-02, T-05-16); the
Fixed Assets rental contract is optional in our checklist and has no ADREC check (T-05-14); the
DBR breakdown lacks the card-limit, outstanding-balance and net-disposable-income lines (T-04-11);
no credit report notes, "Save draft", "Back to Tuum CIF" or "Send to MCC queue" actions; the
committee is one decision-maker with no DoA tiers (T-08-11).

### 1.4 Questions for Tuum and the fund

1. **Scope split.** The screens put stages 5–9 in "Tuum LMS (credit engine + loan lifecycle)". Our
   build runs stages 5–7 in Sanad and hands 8–9 to the loan system. Is Sanad the credit engine for
   5–7 in your picture, and which system owns the stage-5 to stage-7 screens?
2. **Approved amount.** Is the approved facility allowed to be lower than the requested amount
   (5M requested, 2M offered)? Who sets it: the risk band automatically, the analyst, or the MCC?
3. **Scorecard.** Please supply the fund's criterion weights, the scoring function per criterion
   (bands or a continuous formula), and why "Commitment assessment" scores 1.010 (above 1.000).
   What are the risk-band boundaries? The screen classes 88.4% as LOW, so VERY_LOW must start
   above 88.4%.
4. **DBR.** Is the credit-card EMI always 5% of the card limit (2,500 on a 50,000 limit)? Is the
   outstanding card balance used anywhere? Is "DBR before KF loan" the owner's personal DBR (as
   the screen shows) or the business's debt burden?
5. **DSCR.** Screen 03 shows 1.72 (310,000 ÷ 180,000); screens 08 and the credit report notes show
   2.72x. Which is right, and is DSCR net profit ÷ total debt service?
6. **Which product?** The dropdown shows Fixed Assets selected; the info box, header, offer and
   letter say Expansion Loan; the requested tenor (72 months) and purpose (CAPEX + OPEX) fit
   Expansion, not Fixed Assets. Which product is the example?
7. **Schedule dates.** The offer is dated 05 June 2026 and valid until 05 July 2026, but the
   schedule starts 10 September 2029. Is the schedule a placeholder, or is a three-year gap
   between offer and first instalment intended? What disbursement date produced the 37-day first
   period?
8. **Islamic or conventional.** The letter says "Profit rate" and the partner bank is an Islamic
   bank; the product is called a loan with "interest". Is the fund's product conventional, or a
   Shariah-compliant structure (we have a Tawarruq module, disabled until a board ruling)?
9. **Contribution.** "20% · AED 400K from applicant" is 20% of the facility. Is the contribution a
   share of the facility or of the project cost (20% of a 2.5M project is 500K)?
10. **Two contracts.** What exactly is the second copy "with the partner bank" — the same letter
    countersigned, or a separate account/disbursement agreement? Who signs it?
11. **Signing route.** Is signing done inside the TAMM portal (with UAE Pass behind it) or by a
    direct UAE Pass signing request from the lender's system? Who holds the signed artefact?
12. **Disbursement chain.** "FOL signed → Tuum CIF task for Finance → Oracle Fusion ERP processes
    payment → bank confirms → LMS to stage 8": which system instructs the partner bank, and what
    does Sanad receive back (payment reference, LMS loan reference)?
13. **Documents at hand-over.** "Application and documents transferred automatically" — what is
    in the stage-4 hand-over payload: document references, the OCR-extracted figures, the AECB
    report reference and consent?
14. **MCC and DoA.** Composition and quorum of the MCC; any approval tiers by amount or risk
    beyond the single STP limit of AED 500,000.
15. **TAT.** Is the 23-day target measured end to end (from stage 1) or from hand-over? Our
    figure starts at stage 5.
16. **Document checklists** for the five products not shown (only Fixed Assets is on screen 05),
    the fund's Arabic wording, and what "ADREC verified" requires.
17. **Product parameters not shown**: minimum amounts, minimum tenors, grace, contribution bands,
    years in operation, purposes and collateral for Small Loan, Working Capital, 1st Time
    Founders and Advanced Tech & AI.
18. **Risk-aligned terms** on screen 08 mention "Non-Manufacturing", "0–2 conditions · 0–2
    covenants" and a corporate guarantee. Is there a manufacturing / non-manufacturing split in
    the terms table, and are covenants counted separately from conditions?
19. **Notification content.** Must the email and SMS follow the screen's wording exactly (approval
    wording, "within 30 days via your TAMM portal")? Must the email carry the PDF as an
    attachment rather than a signing link?
20. **Portfolio signals.** What triggers "EWS alert" and "60-day alert", and does the LMS send them
    to the origination dashboard or does the dashboard read them from the LMS?

---

## 2. End-to-end journey and stage SLAs (screens 01, 02, 03)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-01-01 | Nine-stage journey: 1 Application, 2 Needs Assessment, 3 Product Application, 4 Verification, 5 Credit Assessment, 6 Decisioning, 7 Contract & Disburse, 8 Portfolio Mgmt, 9 Collections | 01, 02 | `business.ts:189` `PIPELINE_STAGES`; strip in `apps/ops/src/app/[locale]/PipelineDashboard.tsx:140-196` | `test/ui/business-screens.test.ts` "the stage strip" | ✅ | Bilingual titles. |
| T-01-02 | Stage 1 Application: ~10 mins; systems TAMM · UAE Pass; owner TAMM | 01 | `business.ts:190-197` (target, owner UPSTREAM) | none | ➖ | Target shown; stage is upstream. Our strip labels it "Gov. portal", not the systems. |
| T-01-03 | Stage 2 Needs Assessment: ~10 mins; TAMM · Tuum CIF; owner TAMM/CIF | 01 | `business.ts:198-205` | none | ➖ | As T-01-02. |
| T-01-04 | Stage 3 Product Application: ~20 mins; TAMM · AECB · MOHRE; owner TAMM/CIF | 01 | `business.ts:206-213` | none | ➖ | AECB and MOHRE are called upstream here; our AECB and MOHRE adapters exist (`adapters/uae/aecb`, `adapters/uae/mohre`) but are BLOCKED. |
| T-01-05 | Stage 4 Verification: up to 48 hrs; Tuum CIF · TAMM; owner "Acct Mgmt" | 01 | `business.ts:214-221`; strip shows "Gov. portal · customer record" | none | ➖ | |
| T-01-06 | Stage 5 Credit Assessment: up to 5 days; LMS · AECB · TAMM; owner TUUM | 01 | `business.ts:222-229` (5 days, owner SANAD) | `test/ui/business-pipeline.test.ts` "reports near-SLA at 80% of the stage target and a breach past it" | 🟡 | Target matches. Owner differs: the screen gives stage 5 to Tuum LMS, we run it in Sanad. ❓ Q1. |
| T-01-07 | Stage 6 Decisioning: up to 10 days; LMS · MCC workflow; owner TUUM | 01 | `business.ts:230-237` | as T-01-06 | 🟡 | As T-01-06. |
| T-01-08 | Stage 7 Contract & Disburse: up to 5 days; LMS · TAMM · Oracle; owner TUUM | 01 | `business.ts:238-245` | as T-01-06 | 🟡 | As T-01-06. No Oracle or TAMM integration (T-11-12). |
| T-01-09 | Stage 8 Portfolio Mgmt: ongoing; LMS · ERP · Power BI | 01 | `business.ts:246-253` (no target) | none | ➖ | Tuum LMS scope. We record status only (T-01-19). |
| T-01-10 | Stage 9 Collections: ongoing; LMS · ERP · Legal | 01 | `business.ts:254` | none | ➖ | Tuum LMS scope. |
| T-01-11 | Legend: "Stages 1–4: TAMM + Tuum CIF · Stages 5–9: Tuum LMS (credit engine + loan lifecycle)" | 01 | strip headers `PipelineDashboard.tsx:140-150` ("Upstream" 1–4; "Sanad & the loan system" 5–9) | none | 🟡 | We split 5–7 Sanad, 8–9 loan system. ❓ Q1. |
| T-01-12 | Per-stage system list on each stage card (e.g. "LMS · AECB · TAMM") | 01 | `PipelineDashboard.tsx:183-191` shows only "Gov. portal" / "Sanad" / "Loan system" | none | 🟡 | The named systems are not shown. |
| T-01-13 | Target end-to-end TAT 23 days (header "Target TAT: 23 days"; "Target end-to-end: 23 days") | 01, 02, 09 | `business.ts:265` `TARGET_TURNAROUND_SECONDS` | `test/ui/business-pipeline.test.ts` "averages hand-over-to-disbursement in tenths of a day, rounded half up" | 🧪 | Value from the screens; marked ILLUSTRATIVE. Sum of stage targets ≈ 22 days + 40 min, consistent with 23. |
| T-03-01 | Application stepper with each stage's SLA and system ("≤5 days · LMS"; "Ongoing · LMS/ERP") and the current stage highlighted | 03, 04 | application page header `[app]/page.tsx:209-235` (stage and upstream references) | none | 🟡 | We show the stage and status, not a nine-step stepper with systems. |

## 3. Pipeline dashboard (screens 01, 02)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-01-14 | KPI "Active applications 23 · ↑4 this week" | 01, 02 | `dashboard.ts:254` `summarisePipeline` (`activeCount`, stages 5–7); tile `PipelineDashboard.tsx:200-210` | `test/ui/business-pipeline.test.ts` "counts the seed into origination, portfolio and the stage-5 queue" | 🟡 | No week-on-week delta; our sub-line is "n in portfolio". The screen's 23 does not equal its own kanban counts (section 14). |
| T-01-15 | KPI "Pending assessment 8 · 2 near SLA (5-day limit)" | 01, 02 | `dashboard.ts:254` (`pendingAssessmentCount`, `nearSlaCount`); `NEAR_SLA_PER_TEN_THOUSAND` `dashboard.ts:35` (80%) | `test/ui/business-pipeline.test.ts` "reports near-SLA at 80% of the stage target and a breach past it" | ✅ | "Near" at 80% of target is our illustrative choice. ❓ What is "near SLA" for the fund? |
| T-01-16 | KPI "Approved this month 11 · ↑ AED 14.2M disbursed" | 01, 02 | `dashboard.ts:254` (`approvedThisMonthCount`, `disbursedThisMonthMinorUnits`, UAE calendar month) | `test/ui/business-pipeline.test.ts` "sums the facility amounts disbursed in the current UAE calendar month" | ✅ | |
| T-01-17 | KPI "Avg. TAT (days) 18 · ↓ Target ≤23 days ✓" | 01, 02 | `dashboard.ts:217` `turnaroundSeconds`, average in tenths of a day | `test/ui/business-pipeline.test.ts` "averages hand-over-to-disbursement…" | 🟡 | Measured from hand-over at stage 5 to disbursement, not end to end. ❓ Q15. |
| T-01-18 | Kanban "Loan Pipeline — Stages 5–9 (Tuum scope)" with columns Credit Assessment (Stage 5 · ≤5 days, count 8), MCC Decisioning (Stage 6 · ≤10 days, 3), Contract & Disbursement (Stage 7 · ≤5 days, 5), Portfolio Management (Stage 8 · Ongoing, 31), Collections (Stage 9 · Ongoing, 4); "Stages 1–4 tracked in Tuum CIF" | 01, 02 | `dashboard.ts:283-284` `byStage`; `PipelineDashboard.tsx` section 4 | `test/ui/business-pipeline.test.ts` "counts the seed…", "leaves withdrawn and declined applications out of every open count" | ✅ | |
| T-01-19 | Card: business name + application id, amount in AED, product, score ("Expansion Loan · Score 88.4%") | 01, 02 | kanban card in `PipelineDashboard.tsx`; `business/ui.tsx` | `test/ui/business-screens.test.ts` "no raw codes on screen" | 🟡 | Name, amount and variant shown; the score is not on the card. |
| T-01-20 | Card chips: "Scoring Complete ✓", "Day 5 ⚠ SLA", "Day 2 of 5", "Day 7 of 10", "Day 9 ⚠ SLA", "FOL sent Day 2" | 01, 02 | `dashboard.ts:117` `statusChip` (SCORING_COMPLETE, SLA_NEAR "Day n of N ⚠ SLA", IN_STAGE "Day n of N", OFFER_SENT "Offer sent day n") | `test/ui/business-pipeline.test.ts` "the status chip" (5 cases) | ✅ | |
| T-01-21 | Card chip "Awaiting bank KYC" (stage 7) | 01 | none | none | ❌ | No partner-bank KYC state. ❓ Is bank KYC a step in stage 7, and who reports it? |
| T-01-22 | Stage 8 cards "Fixed Assets · Month 3 · On track ✓"; "Working Capital · M7 · EWS alert" | 01 | `dashboard.ts:123-127` (ON_TRACK only); status from `business.ts:2793` `recordPortfolioStatus` | `test/ui/business-pipeline.test.ts` "shows a performing facility as on track" | 🟡 | "On track" yes; no month-on-book, no EWS. LMS scope. ❓ Q20. |
| T-01-23 | Stage 9 card "Small Loan · DPD 32 · 60-day alert" | 01 | `dashboard.ts:119-125` (DPD chip); stage 9 when DPD > 0 `business.ts:2776` | `test/ui/business-pipeline.test.ts` "shows days past due for a facility in collections" | 🟡 | DPD shown; no "60-day alert". |
| T-01-24 | Recent activity table: Applicant, Product, Amount (AED), Stage ("Stage 5→6"), Status chip ("Score 88.4% LOW ✓", "FOL Sent", "Active Loan", "⚠ SLA Risk", "DPD 32"), TAT ("5 days", "21 days ✓", "Ongoing") | 01 | `dashboard.ts:297` `recentActivity`; table `PipelineDashboard.tsx:316-390` | `test/ui/business-pipeline.test.ts` "the status chip" | 🟡 | Same columns; chips use our words (no score in the chip); TAT from hand-over. |
| T-02-01 | Buttons "Export" and "+ New Application" | 02 | Export `PipelineDashboard.tsx:105-111`, `business/export/route.ts`; New application disabled `PipelineDashboard.tsx:112-125` | `test/ui/ops-business-export.test.ts` "#15 the pipeline CSV export" | 🟡 | Export ✅ (CSV). New application deliberately disabled: applications arrive by hand-over at stage 5. |
| T-02-02 | Top tabs ① Pipeline ② Loan Application ③ Credit Scoring ④ Offer Generation; sidebar Pipeline Dashboard, Loan Application (Stage 5), Credit Assessment (Stage 5), Offer & Contract (Stage 7) | 02, 04 | routes `business/page.tsx`, `[app]/page.tsx`, `[app]/assessment/page.tsx`, `[app]/offer/page.tsx`; sidebar `apps/ops/src/server/modules.ts:384-433` | `test/ui/business-screens.test.ts` "the sidebar, by jurisdiction" | ✅ | Same four screens, reached per application. |
| T-02-03 | Sidebar "Portfolio": Active Loans, Collections & EWS, MIS Reports | 01, 02 | none | none | ➖ | Tuum LMS / ERP / Power BI by the screens' split. |
| T-02-04 | Header filter "All Applications"; user "Credit Analyst" | 01 | list `business/page.tsx`; roles `config/tenants/sme-fund-ae/identity/staff-identity.json` (MAKER, CHECKER, SENIOR_CHECKER, CREDIT_COMMITTEE, FINANCE) | `test/unit/ops-business-service.test.ts` four-eyes cases | ✅ | Our roles are finer than "Credit Analyst" (maker, checker, committee, finance). |

## 4. Stage 5 — loan application: applicant and product (screens 03, 04)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-03-02 | Header "Loan Application — FR-00005061"; subtitle business · product · "Handed over from Tuum CIF — Stage 4 verification complete · 04 June 2026" | 03, 04 | `app.ts:205` `receiveHandover` (id pattern `^[A-Z]{2,4}-[0-9]{6,10}$`); `[app]/page.tsx:209-235` | `test/compliance/business-application.test.ts` "arrives at stage 5 in the tenant's currency, and only then" | ✅ | |
| T-03-03 | Banner: "Handed over from Tuum CIF at Stage 4. Tuum CIF is the single customer record. Application and documents transferred automatically." | 03, 04 | `POST /business-applications` `api/openapi/origination.v1.yaml:349`, schema `:1011`; `business.ts:1465` `handOver` | `test/contract/business-applications-api.test.ts` "creates with 201…, idempotent on the upstream reference" | 🟡 | The application transfers automatically; documents and figures do not (the schema has no documents). ❓ Q13. |
| T-03-04 | Applicant panel "Pre-filled from TAMM / UAE Pass", badge "✓ UAE Pass Verified" | 03, 04 | `BusinessApplicant.upstreamVerificationRefs` `app.ts:54-66`; required at hand-over `app.ts:233-234` | `test/compliance/business-application.test.ts` "refuses an application without upstream verification, or carrying an identity number" | ✅ | Shown as the list of stage-4 references. |
| T-03-05 | Business name * | 03 | `businessNameEn` / `businessNameAr` `app.ts:56-57` | `test/contract/business-applications-api.test.ts` | ✅ | |
| T-03-06 | Trade licence * (number · emirate) | 03 | `registrationRef` `app.ts:58-59`; `[app]/page.tsx:257` | as T-03-05 | ✅ | Held as the registry-verified reference. |
| T-03-07 | Sector (dropdown, "Landscaping / Horticulture") | 03 | `sector` `app.ts:60`; `[app]/page.tsx:260` | none | 🟡 | A free code from upstream; no fund sector list. The scorecard's sector priority is keyed separately by the officer (T-06-08). ❓ Fund sector list. |
| T-03-08 | Years in operation ("4+ years (est. 2020)") | 03 | `yearsInOperation` `app.ts:61` (whole years) | `test/compliance/sme-variants.test.ts` years-in-operation refusal cases | ✅ | We hold a whole number, not the establishment year. |
| T-03-09 | Owner name * | 03 | `owners[].displayName` + `ref` `app.ts:62-63` | none | ✅ | |
| T-03-10 | Emirates ID (masked) | 03 | deliberately not held; refused anywhere in the payload `app.ts:126-185` `containsIdentityNumber`, `:236-240` | `test/compliance/business-application.test.ts` "#7 recognises both jurisdictions' identity numbers…" | 🟡 | By design (CLAUDE.md §2, §12): owners carried by reference only. |
| T-03-11 | Product "Selected in Stage 3": loan product *, purpose, requested amount *, requested tenor | 03, 04 | `productCode`, `variantCode`, `purpose`, `requested`, `tenorMonths`, `graceMonths`, `contributionPerTenThousand` `app.ts:186-198`; purpose checked against the variant at hand-over `business.ts:1396-1404` | `test/unit/ops-business-service.test.ts` "refuses a contact that is not masked, and a purpose the variant does not finance" | ✅ | Hand-over does not check the variant's ceiling or tenor; the quote does (T-09-01). |
| T-04-02 | Product dropdown: Small Loan (≤ AED 1M · 36m) | 04 | `catalogue` variants[0] `SMALL_LOAN` (`maxAmountMinorUnits` 100000000, `maxMonths` 36), lines 22-54 | `test/compliance/sme-variants.test.ts` "each variant carries the ceiling, tenor, grace, contribution and years the screens show" | ✅ | |
| T-04-03 | Working Capital (≤ AED 1M · 12m) | 04 | `catalogue` `WORKING_CAPITAL` lines 56-87 | as T-04-02 | ✅ | |
| T-04-04 | Fixed Assets (≤ AED 2M · 60m) | 04 | `catalogue` `FIXED_ASSETS` lines 89-140 | as T-04-02 | ✅ | |
| T-04-05 | Expansion Loan (≤ AED 5M · 72m) | 04 | `catalogue` `EXPANSION` lines 142-192 | as T-04-02 | ✅ | |
| T-04-06 | 1st Time Founders (≤ AED 1M · 60m) | 04 | `catalogue` `FIRST_TIME_FOUNDERS` lines 194-226 | as T-04-02 | ✅ | |
| T-04-07 | Advanced Tech & AI (≤ AED 2M · 60m) | 04 | `catalogue` `ADVANCED_TECH_AI` lines 228-264 | as T-04-02 | ✅ | |
| T-04-08 | Purpose dropdown ("CAPEX + OPEX Mix") | 03, 04 | variant `purposes`; `CAPEX_OPEX` on `EXPANSION` only (`catalogue` line 154) | `test/compliance/sme-variants.test.ts` purpose refusal cases | 🧪 | Purpose lists are ours, illustrative. The screen pairs CAPEX + OPEX with Fixed Assets, which our Fixed Assets would refuse (`PURPOSE_NOT_ALLOWED`). ❓ Q6, Q17. |
| T-04-09 | Info box: "Expansion Loan: Max AED 5M · Tenor ≤72m · Grace ≤12m · Min 2 yrs operation · Contribution 20–40% (CAPEX). Risk-aligned terms auto-set from credit scoring." | 03, 04 | `catalogue` `EXPANSION`: `maxGraceMonths` 12, `minYearsInOperation` 2, contribution 2000–4000 per ten thousand; enforced `products/sme-term-conventional/variants.ts:261-303`; variant limits line `[app]/page.tsx:310` | `test/compliance/sme-variants.test.ts` "each variant carries…" and refusals (grace above, contribution 4001, years 1) | ✅ | "(CAPEX)" qualifier on the contribution is not modelled. Risk-aligned terms: T-08-07. |
| T-04-10 | Other products' minimum tenor, grace, contribution, years, purposes, collateral; product minimum amount | — (not shown) | `catalogue` notes per variant; `minAmountMinorUnits` 5000000 (AED 50,000) | `test/compliance/sme-variants.test.ts` "an amount below the product minimum" | 🧪 | Every value the screens do not show is marked ILLUSTRATIVE in the variant's `note`. Working Capital grace 3 months is cited to the screens in its note but is not visible on these 11 screens. ❓ Q17. |
| T-03-12 | Buttons "Save Draft" and "Submit to Credit Assessment →" | 03, 04, 05 | Submit: `app.ts:262` `submitForAssessment`, `business.ts:2042`; `[app]/page.tsx:720-757`. No draft concept | `test/compliance/business-application.test.ts` "needs every figure verified and every mandatory document" | 🟡 | Submit ✅. "Save draft" absent: every action is saved as it is taken. |
| T-05-01 | "← Back to Tuum CIF" | 05 | none (only `withdraw` `app.ts:442`) | none | ❌ | ❓ Should stage 5 return an application to stage 4 (and what does Tuum CIF expect back)? |

## 5. Stage 5 — financial analysis, ratios and DBR (screens 03, 04, 06)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-03-13 | "Financial Analysis — Credit Officer Input", badge "OCR Pre-filled — verify before submitting"; instruction to review each value, correct errors, tick Verified per row | 03, 04 | `business.ts:1627` `ingestReadFigures` (system path for OCR / rail figures); `business.ts:1753` `verifyFigure`; `core/applicant/financials.ts` `proposeFigure` / `verifyFigure`; table `[app]/page.tsx:324-450` | `test/unit/business-financials.test.ts` "is not usable until an officer verifies it…", "keeps the OCR value when the officer corrects it, and flags the correction"; `test/unit/ops-business-service.test.ts` "#1 a keyed figure is OFFICER_ENTRY…" | 🟡 | The pre-fill, per-row verification and correction are built. There is no OCR engine: the ingest path takes figures an OCR service would send. Keyed figures need a second person (four eyes), which the screen does not show. |
| T-03-14 | Rows with Metric · Source ("OCR — verify") · OCR value · Verified ✓: Annual Revenue FY2023 (Audited P&L) 2,340,000; Net Profit FY2023 310,000; Total Debt Service (bank statements) 180,000; Current Assets (balance sheet) 920,000; Current Liabilities 440,000; Prior Year Revenue FY2022 2,180,000 | 03, 04 | `FinancialMetric` `core/applicant/financials.ts:43-63` (ANNUAL_REVENUE, PRIOR_YEAR_REVENUE, NET_PROFIT, TOTAL_DEBT_SERVICE, CURRENT_ASSETS, CURRENT_LIABILITIES, MONTHLY_GROSS_SALARY, MONTHLY_DEBT_OBLIGATIONS); period label per figure | `test/unit/business-financials.test.ts` "ratios — reproduced against the prototype screen (AED)" uses these six figures | ✅ | |
| T-03-15 | AECB Credit Score 801, source "Auto-pull", with the bureau report reference link | 03, 04 | `AssessmentInputs.bureau` `business.ts:282-316` (score keyed MANUALLY with report reference and stage-4 consent id, `source: 'AECB_FIXTURE'`); adapter `adapters/uae/aecb/` BLOCKED | `test/unit/ops-business-service.test.ts` "refuses a bureau entry without a consent id, or with one stage 4 did not record" | 🟡 | Not auto-pulled: keyed from the stage-4 report until the AECB adapter makes a verified sandbox call (UAE-RAIL-AECB-01). |
| T-03-16 | "Auto-calculated ratios": DSCR 1.72 (min ≥1.40 ✓) | 03, 04 | `core/applicant/financials.ts:389-395` DEBT_SERVICE_COVER = NET_PROFIT ÷ TOTAL_DEBT_SERVICE, floor; tiles `[app]/page.tsx:508-571` | `test/unit/business-financials.test.ts` "debt-service cover 17222 (1.72x)" | ✅ | Screen 08 shows 2.72x for the same case (section 14). ❓ Q5. |
| T-03-17 | Current Ratio 2.09 (min ≥1.30 ✓) | 03, 04 | `financials.ts:397-403` CURRENT_RATIO, floor | `test/unit/business-financials.test.ts` "current ratio 20909 (2.09x)" | ✅ | |
| T-03-18 | Sales Growth 7.3% (min ≥2% ✓) | 03, 04 | `financials.ts:405-411` SALES_GROWTH, floor | `test/unit/business-financials.test.ts` "sales growth 733 (7.33%; the screen shows 7.3%)" | ✅ | We show two decimals (7.33%). |
| T-03-19 | Net Margin 13.2% ("Profitability check") | 03, 04 | `financials.ts:413-419` NET_MARGIN; tile `[app]/page.tsx:100` | `test/unit/business-financials.test.ts` "net margin 1324 (13.2%)" | ✅ | Not a knock-out on either side. |
| T-04-01 | "DBR calculation — from salary certificate + AECB report (auto-calculated)": monthly salary 64,456.45, salary source "Salary Certificate", existing loans "None"; "DBR = 2,500 ÷ 64,456.45 = 3.88% ✓ PASS — well below 50% threshold" | 03, 04 | OWNER_DEBT_BURDEN = MONTHLY_DEBT_OBLIGATIONS ÷ MONTHLY_GROSS_SALARY, rounded up `financials.ts:421-428`; panel `[app]/page.tsx:840-873`; assessment breakdown `[app]/assessment/page.tsx:299-331` | `test/unit/business-financials.test.ts` "owner debt burden 388 (3.88%), rounded up as a burden ratio" | ✅ | Salary and obligations are verified figures (keyed or read), not auto-pulled from AECB. |
| T-04-11 | DBR breakdown lines: Credit card (50K limit) monthly EMI 2,500.00; Credit card outstanding balance 4,105.00; Total monthly debt obligations 2,500.00; Net disposable income 61,956.45; "Formula: Total Monthly EMI ÷ Gross Salary × 100" | 06 | one figure MONTHLY_DEBT_OBLIGATIONS; no card limit, outstanding balance or NDI | none | 🟡 | The formula matches; the breakdown lines are not held. The 2,500 is 5% of the 50K limit. ❓ Q4. |
| T-06-01 | DBR tiles: "DBR pre-KF 3.88% (2,500 ÷ 64,456)"; "KO threshold ≤50% · All products"; "AECB score 801 · Excellent"; "KO result: PASS — DBR 3.88% well within 50% limit"; card heading "✓ Score 0.24/0.25 · Low Risk" | 06 | `assessment.json` `KO_OWNER_DBR` LTE 5000 lines 63-70; tiles `[app]/assessment/page.tsx:257-293` | `test/compliance/sme-assessment.test.ts` "passes every knock-out, each reported with threshold, actual and pass" | 🟡 | KO and value match. No "Excellent" grade word for the bureau score; the criterion score differs (section 6). |

## 6. Stage 5→6 — scoring matrix (screens 06, 07)

Our figures are for the screen's inputs, from `test/compliance/sme-assessment.test.ts` "scores
applicant 9250, project 7000, cumulative 7900 with a full trace" (that test's example also uses
DSCR 1.85, current ratio 1.50, growth 8% and owner DBR 25%; none of those feed the scorecard
except DBR, whose band score is the same).

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-06-02 | Two sections: Applicant (weight 40%) and Project (weight 60%); "40% Applicant · 60% Project" | 06, 07 | `assessment.json` sections `APPLICANT` 4000, `PROJECT` 6000 (lines 73-77, 218-221); engine `core/decisioning/sme-assessment.ts` | `test/compliance/sme-assessment.test.ts` "refuses section weights that do not sum to 10000" | ✅ | |
| T-06-03 | Applicant: AECB Score, input 801, score 0.249, Low | 06, 07 | `BUREAU_SCORE` weight 3000, bands ≥750 → 10000 (lines 79-114) | as section intro | 🧪 | Same criterion; our weight 30% gives 0.300 of the section. The screen's 0.249 of an apparent 0.25 maximum suggests 25% weight and a continuous score. ❓ Q3. |
| T-06-04 | DBR Before KF Loan, input 3.88%, score 0.240, Low | 06, 07 | `DBR_BEFORE_LOAN` weight 2500 (lines 115-150); fact `dbrBeforeLoanPerTenThousand` = TOTAL_DEBT_SERVICE ÷ ANNUAL_REVENUE, `business.ts:2059-2079`, `:2120` | as section intro | 🟡 | Weight 25% matches the screen's "25% weight". Input differs: the screen uses the owner's DBR (3.88%), we use the business's debt service ÷ revenue (7.70% here; same band). ❓ Q4. |
| T-06-05 | Relevant Experience, input "4+ Years", score 0.250, Low | 06, 07 | `RELEVANT_EXPERIENCE` weight 2000 (lines 151-179); officer input `AssessmentInputs.relevantExperienceYears` | as section intro | 🧪 | Our weight 20% (0.200); the screen's looks like 25%. |
| T-06-06 | Total Equity Contribution, input 20%, score 0.167, Moderate | 06, 07 | `EQUITY_CONTRIBUTION` weight 2500 (lines 180-215); fact from the application's contribution | as section intro | 🧪 | Ours 20% → band score 0.70 × 25% = 0.175, risk LOW; screen 0.167, Moderate. |
| T-06-07 | "Applicant Total (40% weight) 0.9059 · LOW"; tile "Applicant score 90.6/100 · Weight 40% · AECB 801, DBR 3.88%" | 06, 07 | section score in the assessment trace; tile `[app]/assessment/page.tsx:257-275` | as section intro | 🧪 | Ours 92.50 for the same inputs. |
| T-06-08 | Project: KF Sector Priority, input "Non-priority", score 0.350, Moderate | 06, 07 | `SECTOR_PRIORITY` weight 1000 (lines 223-244); officer input | as section intro | 🧪 | Ours 0.50 band score, weight 10%. |
| T-06-09 | Profitability, "Rev. & Profitable", 1.000, Low | 06, 07 | `PROFITABILITY` weight 1500 (lines 245-266); fact = verified NET_PROFIT > 0 | as section intro | ✅ | Same outcome (full score). Weight illustrative. |
| T-06-10 | Audited Financials, "Available", 1.000, Low | 06, 07 | `AUDITED_FINANCIALS` weight 1000 (lines 267-288); officer input | as section intro | ✅ | As T-06-09. |
| T-06-11 | Years of Operations, "4+ Years", 1.000, Low | 06, 07 | `YEARS_OF_OPERATION` weight 1500 (lines 289-317); fact from the hand-over | as section intro | ✅ | As T-06-09. |
| T-06-12 | Commitment Assessment, input 1.01, score 1.010, Low | 07 | `COMMITMENT_ASSESSMENT` weight 1000 (lines 318-353); officer input | as section intro | 🧪 | Ours: 1.01 → band score 0.70. The screen's score exceeds 1.000. ❓ Q3. |
| T-06-13 | Risk Analysis, input 5.770 / 10, score 1.000, Low | 07 | `RISK_ANALYSIS` weight 1500 (lines 354-389); officer input held per ten thousand (5770) | as section intro | 🧪 | Ours: 5.77 → 0.60, Moderate. The screen gives full marks at 5.77/10. |
| T-06-14 | Portfolio Repayment %, input 53%, score 0.530, Moderate | 07 | `PORTFOLIO_REPAYMENT` weight 1500 (lines 390-425) | as section intro | 🧪 | Ours: 53% → 0.40, Moderate. Screen's score equals the input (continuous). |
| T-06-15 | Failed Files Rate, input 30%, score 0.250, High | 07 | `FAILED_FILES_RATE` weight 1000 (lines 426-461) | as section intro | 🧪 | Ours: 30% → 0.30, High. |
| T-06-16 | "Project Total (60% weight) 0.8689 · LOW"; tile "Project score 86.9/100 · Financials, viability, sector" | 06, 07 | section score in the trace | as section intro | 🧪 | Ours 70.00. The screen's eight criterion scores average 0.7675 unweighted, so hidden weights produce 0.8689; they cannot be derived from the screen. ❓ Q3. |
| T-06-17 | "Accumulative = (40% × 0.9059) + (60% × 0.8689) = 0.3624 + 0.5213 = 0.8837"; tile "Cumulative score 88.4/100 · (40%×90.6) + (60%×86.9) = 0.8837" | 06, 07 | cumulative = Σ section weight × section score, integers per ten thousand; formula panel `[app]/assessment/page.tsx:414-434` | `test/compliance/sme-assessment.test.ts` "scores applicant 9250, project 7000, cumulative 7900 with a full trace"; "produces only integers" | ✅ | The formula matches (the screen's arithmetic checks: 0.36236 + 0.52134 = 0.88370). Our cumulative for these inputs is 79.00. |
| T-06-18 | Criterion table columns: Criterion · Input · Score · Risk; every tile "Read-only" | 06, 07 | `[app]/assessment/page.tsx:618-701` (adds a Weight column); computed server-side only | `test/ui/business-screens.test.ts` "renders every knock-out threshold kind in the policy with no Latin digit" | ✅ | |
| T-06-19 | Risk level "LOW · Score 88.4% · Max AED 2,000,000"; footer "LOW RISK · Max AED 2,000,000 · Min 20% Contribution" | 06, 07 | `assessment.json` `riskBands` LOW: `maxFinancingMinorUnits` 200000000, `minEquityContributionPerTenThousand` 2000 (lines 478-488) | `test/compliance/sme-assessment.test.ts` "is LOW risk with the LOW band terms (AED 2,000,000, 20% contribution)" | ✅ | The LOW terms are from the screen. |
| T-06-20 | Risk band boundaries (implied: 88.4% is LOW, so VERY_LOW starts above it) | 06, 07 | `riskBands` VERY_LOW ≥ 8500, LOW ≥ 7000, MEDIUM ≥ 5500, HIGH ≥ 4000; below → DECLINE | `test/compliance/sme-assessment.test.ts` "declines a score below the lowest band, as configured" | 🧪 | With our boundaries, a score of 88.4% would be VERY_LOW. Boundaries and the other bands' terms are placeholders. ❓ Q3. |
| T-06-21 | Header "Credit Assessment — Stage 5 → 6 · business · Expansion Loan · AED 2,000,000 · File FR-00005061 · 21 May 2026"; buttons "← Back", "Approve → Generate Offer" | 06 | `[app]/assessment/page.tsx:178-239` (run assessment as checker), `:920-1000` (approve as checker, committee decision, generate offer with dates) | `test/unit/ops-business-service.test.ts` "hand-over → … → assess → committee → offer → send → sign → disburse" | 🟡 | Approve-then-generate exists, but the approval is a checker's or the committee's, never the analyst's own. The assessment is dated 21 May, before the 04 June hand-over (section 14). |

## 7. Stage 6 — knock-outs and decisioning (screen 08)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-08-01 | Knock-out "AECB Credit Score ≥650 (all products)", value 801, Pass | 08, 05 | `assessment.json` `KO_BUREAU_SCORE` GTE 650 (lines 31-38) | `test/compliance/sme-assessment.test.ts` "SME assessment — each knock-out declines on its own"; "passes exactly at each threshold" | 🧪 | Built as shown; threshold tagged ILLUSTRATIVE until the fund confirms. |
| T-08-02 | DSCR ≥1.40, value 2.72x, Pass | 08, 05 | `KO_DSCR` GTE 14000 (lines 39-46); also the module credit rule `catalogue` `minDebtServiceCoverPerTenThousand` 14000 | as T-08-01 | 🧪 | Our value for these figures is 1.72 (T-03-16). |
| T-08-03 | Current Ratio ≥1.30, value 2.09x, Pass | 08, 05 | `KO_CURRENT_RATIO` GTE 13000 (lines 47-54) | as T-08-01 | 🧪 | |
| T-08-04 | Sales Growth (YoY) ≥2%, value +7.3%, Pass | 08, 05 | `KO_SALES_GROWTH` GTE 200 (lines 55-62) | as T-08-01 | 🧪 | |
| T-08-05 | DBR ≤50% (all products), value 3.88%, Pass; "Knock-Out Result ✓ 0 criteria failed" | 08, 05, 06 | `KO_OWNER_DBR` LTE 5000 (lines 63-70); table `[app]/assessment/page.tsx:349-400` ("Any failure declines before scoring", "All passed") | as T-08-01 | 🧪 | The knock-outs apply to every variant (tenant-wide), as the screen's "(all products)" says. |
| T-08-06 | "Risk Level LOW — MCC Approval Required (amount AED 2M)"; "Score 88.4% · Risk = LOW ✓ · Amount AED 2M > STP limit AED 500K → MCC workflow triggered" | 08 | route COMMITTEE in `sme-assessment.ts`; `app.ts:290` `recordAssessment` → IN_COMMITTEE; decisioning panel `[app]/assessment/page.tsx:449-480` | `test/compliance/sme-assessment.test.ts` "routes to COMMITTEE because AED 2,000,000 is above the AED 500,000 straight-through maximum" | 🟡 | Routing matches. But the amount assessed is the requested amount; the screen's case requested 5M (screen 03) and is assessed at 2M. ❓ Q2. |
| T-08-07 | "Risk-aligned terms auto-set: Expansion Loan Non-Manufacturing · Max AED 2M · Min contribution 20% · 0–2 conditions · 0–2 covenants · Corporate Guarantee" | 08 | risk band `terms` (`maxFinancingMinorUnits`, `minEquityContributionPerTenThousand`, `maxConditions`) `assessment.json:466-511`; panel `[app]/assessment/page.tsx:532-545`; `outsideRiskAlignedTerms: COMMITTEE` | `test/compliance/sme-assessment.test.ts` "flags a request above the risk-aligned maximum"; "cannot reach straight-through with equity below the risk band minimum" | 🟡 | Max and contribution match. No manufacturing split, no covenant count (our LOW band says 3 conditions), and the terms are shown, not applied to the amount. Expansion collateral in our catalogue is a personal guarantee + promissory note, not a corporate guarantee. ❓ Q18. |
| T-08-08 | Two approval paths (per DoA): ① STP auto-approve when amount ≤500K, risk Low / Very Low, collateral ≥120% | 08 | `assessment.json` `straightThrough` (lines 516-522); `app.ts:325` `approveStraightThrough` | `test/compliance/sme-assessment.test.ts` "routes an AED 400,000 LOW-risk request with 130% collateral STRAIGHT_THROUGH", "refuses straight-through when collateral coverage is below 120%", "refuses straight-through at MEDIUM risk even for a small amount" | 🟡 | Conditions match (values illustrative). Not "auto-approve": a checker who is not the submitting officer approves (four eyes). ❓ Must STP be fully automatic? |
| T-08-09 | ② MCC workflow for this application (amount AED 2M, score 88.4%) | 08 | `app.ts:335` `decideInCommittee` (member ≠ submitter, reason required) | `test/compliance/business-application.test.ts` "a committee case cannot be decided by the officer who submitted it" | 🟡 | One committee decision by one principal; no MCC queue, quorum or minutes. ❓ Q14. |
| T-08-10 | Collateral coverage ≥120% as an input | 08 | fact `collateralCoveragePerTenThousand` = collateral value ÷ requested, floor `business.ts:2131`; officer input `collateralValue` | as T-08-08 | ✅ | |
| T-08-11 | "per DoA" (delegation of authority) | 08 | only the single STP limit | none | ❌ | No approval tiers by amount or risk. ❓ Q14. |
| T-08-12 | "Credit Report Notes": analyst's free-text summary | 08 | none | none | ❌ | Only committee and withdrawal reasons are free text. |
| T-08-13 | Buttons "Send to MCC Queue" and "Generate Offer →" | 08 | committee route is automatic from the assessment; Generate offer only after APPROVED `business.ts:2304` | `test/unit/ops-business-service.test.ts` full journey | 🟡 | No explicit "send to queue" action; the offer cannot be generated before the committee approves. |

## 8. Stage 5 — document checklist, Fixed Assets (screen 05)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-05-02 | "Documents — Fixed Assets checklist", "Dynamic per product", groups Core Documents — All Products / Financial Documents / Project & Collateral Documents | 05 | per-variant checklist `documentChecklistRef` → `config/tenants/sme-fund-ae/documents/sme-ae-*.json`; grouping `dashboard.ts:338-353`; `[app]/page.tsx:110-112`, `:582-710` | `test/compliance/sme-variants.test.ts` "the project and collateral documents differ by variant"; `test/ui/business-pipeline.test.ts` "groups the checklist for display and never drops an unknown document" | 🟡 | Per product ✅. Grouping differs: we put the personal and company bank statements under Financial and the company profile under Core; the screen has the statements under Core and the profile under Project & Collateral. |
| T-05-03 | Counter "8 of 12 uploaded" | 05 | `business.ts:1351` `checklistStatus` (missing list, complete flag) | `test/unit/ops-business-service.test.ts` "#6 a typed reference does not make a document present" | 🟡 | We show "mandatory documents complete" or the missing ones, not an "n of m" counter. |
| T-05-04 | Trade Licence (valid, current) — Mandatory | 05 | `sme-ae-fixed-assets.json` `TRADE_LICENCE` required, valid 365 days | `test/compliance/sme-variants.test.ts` "the project and collateral documents differ by variant" | ✅ | Validity window is ours, illustrative. |
| T-05-05 | Emirates ID — all owners — Mandatory | 05 | `OWNER_EMIRATES_ID` required | as T-05-04 | ✅ | Held as a document reference only. |
| T-05-06 | Personal AECB Report — Mandatory | 05 | `PERSONAL_BUREAU_REPORT` required, valid 30 days | as T-05-04 | ✅ | |
| T-05-07 | Personal Bank Statement — 12 months — Mandatory | 05 | `PERSONAL_BANK_STATEMENT_12M` required | as T-05-04 | ✅ | |
| T-05-08 | Company Bank Statement — 12 months — Mandatory | 05 | `COMPANY_BANK_STATEMENT_12M` required | as T-05-04 | ✅ | |
| T-05-09 | Audited Financial Statements — 2 years — Mandatory | 05 | `AUDITED_FINANCIALS_2Y` required | as T-05-04 | ✅ | |
| T-05-10 | Salary Certificate — Mandatory | 05 | `SALARY_CERTIFICATE` required | as T-05-04 | ✅ | |
| T-05-11 | WPS / MOHRE Salary Report — Mandatory (shown Missing) | 05 | `WPS_SALARY_REPORT` required; MOHRE adapter `adapters/uae/mohre/` BLOCKED | as T-05-04 | ✅ | Document only; no MOHRE call. |
| T-05-12 | Supplier Quotations / Purchase Invoices — Mandatory | 05 | `SUPPLIER_QUOTATIONS` required | as T-05-04 | ✅ | |
| T-05-13 | Asset / Collateral Valuation Report — Mandatory | 05 | `ASSET_VALUATION_REPORT` required | as T-05-04 | ✅ | |
| T-05-14 | Rental Contract (ADREC verified) — Mandatory | 05 | `RENTAL_CONTRACT` `required: false`; no ADREC check | none | 🟡 | Optional in our Fixed Assets checklist; no tenancy-registry verification. ❓ Q16. |
| T-05-15 | Company Profile — Mandatory | 05 | `COMPANY_PROFILE` required | as T-05-04 | ✅ | |
| T-05-16 | Arabic label under every item (e.g. "رخصة تجارية", "هوية إماراتية", "بروفايل الشركة") | 05 | `titleAr` on every item | `test/ui/business-screens.test.ts` "writes no Latin quantity into an Arabic string on the pages" | 🟡 | Bilingual, but our Arabic wording differs from the screen's. ❓ Q16. |
| T-05-17 | Per item: status (✓ Uploaded / ⚠ Missing) and action (View ↗ / Attach ↑) | 05 | `presentDocument` `business.ts:1818`, `validateDocument` `business.ts:1877`; statuses `[app]/page.tsx:118-122`; Attach by document reference `[app]/page.tsx:691-700` | `test/unit/ops-business-service.test.ts` "stores PENDING, cannot satisfy the submission gate, and is validated only by someone other than the presenter" | 🟡 | Attach is a document-platform reference, then validated by a second person; no file upload or viewer in Sanad. |
| T-05-18 | Fixed Assets rules: "Max AED 2,000,000 · Tenor 60 months · Grace 6 months · Contribution 20% · Min. operation 1 year; Collateral: personal guarantee · promissory note · underlying asset + insurance; KO: DSCR ≥1.40, AECB ≥650, CR ≥1.30, DBR ≤50%, sales growth ≥2%" | 05 | `catalogue` `FIXED_ASSETS` (200000000, 60, grace 6, contribution min 2000, years 1, four collateral items, `knockOutNotes`); KOs `assessment.json` | `test/compliance/sme-variants.test.ts` "each variant carries…"; refusal "a contribution below the variant minimum" | ✅ | Our variant `knockOutNotes` list DSCR, years, contribution; the five KOs themselves are the tenant-wide policy. Contribution is a minimum (ceiling 100% illustrative). |
| T-05-19 | Checklists for the other five products | — (not shown) | `sme-ae-small-loan.json`, `-working-capital`, `-expansion`, `-first-time-founders`, `-advanced-tech` (version `0.1.0-illustrative-2026-10-08`) | `test/compliance/sme-variants.test.ts` "the project and collateral documents differ by variant" | 🧪 | Our derivation from the Fixed Assets list. ❓ Q16. |
| T-05-20 | "Submit to Credit Assessment" disabled while mandatory documents are missing | 05 | `app.ts:262-286` (`DOCUMENTS_MISSING`, `FIGURES_NOT_VERIFIED`) | `test/compliance/business-application.test.ts` "needs every figure verified and every mandatory document" | ✅ | |

## 9. Stage 7 — offer and repayment schedule (screen 09)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-09-01 | Approved facility AED 2,000,000 (requested AED 5,000,000 on screen 03) | 09, 03 | offer uses `app.requested` `business.ts:2390`, `:2418` | none | ❌ | No approved amount separate from the requested amount; a 5M request on Fixed Assets is refused at quote (`AMOUNT_EXCEEDS_VARIANT`, `TENOR_OUTSIDE_VARIANT`). ❓ Q2. |
| T-09-02 | "Facility Offer Letter — Stage 7 · Digital Signing", business name, "Expansion Loan · FR-00005061 · Score 88.4% LOW · 05 June 2026" | 09 | `[app]/offer/page.tsx:150-180` | `test/ui/business-screens.test.ts` "the offer's send action and figures" | 🟡 | Variant, reference and date shown; score not on the offer header. |
| T-09-03 | "Loan ref: L000000002569"; "Tuum LMS generated · 10 Sep 2029 → 10 Aug 2034" | 09 | none (CORE_BANKING rail disabled, `config/tenants/sme-fund-ae/rails/rails.json`) | none | ❌ | Our schedule is Sanad's, built to match the LMS to the fil (section 13); no LMS booking or loan reference yet. |
| T-09-04 | Tenor 60 months, "10 Sep 2029 → 10 Aug 2034" | 09 | `quoteSmeConventional` `products/sme-term-conventional/pricing.ts:66-157`; tiles `[app]/offer/page.tsx:182-212` | `test/compliance/sme-variants.test.ts` "the golden core-banking case is priced on the dated ACT/365 schedule…" | ✅ | |
| T-09-05 | Monthly instalment 34,629.18, "AED · Fixed amount" | 09 | level instalment `core/pricing/dated-schedule.ts:184-196` | `test/unit/dated-schedule.test.ts` "first period is 37 days and the level instalment is 34,629.18" | ✅ | |
| T-09-06 | Total interest 77,751 (AED 77,750.66) | 09 | `pricing.ts:140` `interestAmount` | `test/unit/dated-schedule.test.ts` "totals: principal 2,000,000.00, interest 77,750.66, payable 2,077,750.66" | ✅ | |
| T-09-07 | Total repayable 2,077,751 (AED 2,077,750.66) | 09 | `business.ts:2421` `totalPayable` | as T-09-06 | ✅ | No admin fee configured (`adminFeeMinorUnits` 0). |
| T-09-08 | Contribution 20% · "AED 400K from applicant" | 09 | `[app]/offer/page.tsx:210-212` (percent "of the project cost") | none | 🟡 | We show the percentage, not an amount; the screen's 400K is 20% of the facility. ❓ Q9. |
| T-09-09 | Repayment schedule table: # · Payment date · Opening balance · Principal · Interest · Instalment · Closing balance; rows 1–5, "… Payments 6–57 · Fixed instalment AED 34,629.18 / month · Principal increasing, interest decreasing …", rows 58–60; Total — 60 payments: 2,000,000.00 · 77,750.66 · 2,077,750.66 · 0.00 ✓ | 09 | `dashboard.ts:318` `scheduleExcerpt` (first 5, last 3); table `[app]/offer/page.tsx:254-305` | `test/ui/business-pipeline.test.ts` "shows the first five and the last three, and says how many it skipped"; `test/unit/dated-schedule.test.ts` | ✅ | Every displayed figure reproduced (section 13). |
| T-09-10 | Rate 1.5% p.a. (on the letter, screen 10) | 10 | `catalogue` `pricingRule` CATALOGUE_RATE `bp` 150, REDUCING; rate and APR tile `[app]/offer/page.tsx:218-230` | `test/ui/business-screens.test.ts` "shows the stored rate and the platform's APR through <Rate>, from the offer terms" | 🧪 | Rate card is ILLUSTRATIVE, taken from the screen. We also show the APR the platform computes (1.51%), which the screen does not. |
| T-09-11 | Grace: "No grace period" | 09, 10 | `graceMonths` 0; grace supported (interest-only first rows) `dated-schedule.ts` convention 4 | `test/unit/dated-schedule.test.ts` "six interest-only rows leave the principal untouched"; `test/compliance/sme-variants.test.ts` "a grace period gives interest-only instalments first…" | ✅ | |
| T-09-12 | Offer generation speed "generated in 1.2 seconds — previously ~30 minutes manual work" | 09 | — | none | ✅ | Not a requirement; offer generation is a single synchronous call. |

## 10. Stage 7 — Facility Offer Letter (screen 10)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-10-01 | "PDF FOL generated · Standardised template · Auto-populated from approved loan terms · 2 copies (KF + bank)" | 10, 11 | `core/documents/offer-letter.ts` `buildOfferLetter` (structured, content-hashed); called `business.ts:2381-2410`; PDF deferred to the document platform (`rails.json` DOCUMENT_PLATFORM disabled; note `[app]/offer/page.tsx:772`) | `test/unit/offer-letter.test.ts` "the letter version is a content hash" | 🟡 | Template and auto-population ✅; no PDF yet; one letter, not two copies. ❓ Q10. |
| T-10-02 | Letter header: institution name in English and Arabic | 10 | `institutionLegalName` en/ar `business.ts:2404` | `test/unit/offer-letter.test.ts` "carries parties, conditions and signature blocks by role only" | ✅ | |
| T-10-03 | Title "Facility Offer Letter — خطاب عرض التسهيل" | 10 | letter `title` en/ar | `test/unit/offer-letter.test.ts` "AE conventional: AED 2,000,000 over 60 months at 150 bp shows Interest rate and no Hijri date" | ✅ | |
| T-10-04 | Applicant (business name), Ref FR-00005061, Date 05 June 2026 | 10 | `applicantBusinessName`, `applicationReference`, `offerDate` | as T-10-03 | ✅ | |
| T-10-05 | Product: Expansion Loan; Facility Amount AED 2,000,000 | 10 | `productVariantName`, `facilityAmount` | as T-10-03 | ✅ | |
| T-10-06 | Valid until 05 July 2026 (30 days) | 10, 11 | `validUntil` = offer date + `offerValidityDays` 30, `config/tenants/sme-fund-ae/credit-policy/offer-policy.json` | `test/unit/ops-business-service.test.ts` "#8 the bounds come from the fund's credit-policy configuration, marked ILLUSTRATIVE, through a parser" | 🧪 | 30 days matches the screen; tagged ILLUSTRATIVE. |
| T-10-07 | Terms & Conditions / الشروط والأحكام: Tenor 60 months · Grace period "No grace period" · Profit rate 1.5% p.a. · Contribution 20% | 10 | letter rows TENOR, grace, RATE, contribution | `test/unit/offer-letter.test.ts` "AE conventional…shows Interest rate…" | 🟡 | We label it "Interest rate" for a conventional product ("Profit rate" only for Islamic). We add instalment, totals and APR. ❓ Q8. |
| T-10-08 | Calendars: Gregorian dates only | 10 | jurisdiction profile `contractualCalendars` (UAE: Gregorian) | `test/unit/offer-letter.test.ts` "…no Hijri date" | ✅ | |
| T-10-09 | Bilingual letter (Arabic + English) | 10, 11 | bilingual text throughout; Arabic-Indic digits in Arabic parts | `test/unit/offer-letter.test.ts` "writes every Arabic quantity in Arabic-Indic digits…" | ✅ | |
| T-10-10 | Signature blocks: "For [fund] — Authorised Signatory" and "Applicant — [person's name] · Date ____" | 10 | signatories by role `business.ts:2405-2408` (LENDER, BORROWER "Authorised Signatory of the Borrower") | `test/unit/offer-letter.test.ts` "carries parties, conditions and signature blocks by role only" | 🟡 | By design no person's name on the letter; no partner-bank signature block. |
| T-10-11 | Conditions / collateral on the letter | 10 (not shown) | `conditions` from the variant's collateral `business.ts:2409` | as T-10-10 | ✅ | Our letter lists them; the screen's letter does not. |
| T-10-12 | "Preview FOL PDF" button | 10, 11 | "Preview offer letter" `[app]/offer/page.tsx:474` (HTML) | none | 🟡 | Preview of the structured letter, not a PDF. |

## 11. Stage 7 — signing, notifications and disbursement (screens 09, 10, 11)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-11-01 | "Digital Signing — FOL (Arabic + English)": "FOL auto-generated in Arabic and English. Sent via TAMM for UAE Pass digital signature." | 09, 10, 11 | signing `business.ts:2627` `recordSigned` → `app.ts:397` (signature must be on the sent letter version); UAE Pass adapter `adapters/uae/uae-pass/` BLOCKED; module entry BLOCKED `modules.ts:416-425` | `test/compliance/business-application.test.ts` "the signature must be on the letter that was sent; disbursement only after signing" | 🟡 | UAE Pass signature is a fixture reference; no TAMM route. ❓ Q11. |
| T-11-02 | "Two contracts: one with [the fund], one with partner bank" | 09, 10, 11 | none | none | ❌ | ❓ Q10. |
| T-11-03 | Notification channel dropdown "Email + SMS" | 09, 10, 11 | channels derived from the contact (email and/or mobile on record) `business.ts:2527-2530`; display `[app]/offer/page.tsx:347-353` | `test/ui/business-screens.test.ts` "sends by email and SMS and names the letter by reference" | 🟡 | Both channels sent when both are on record; not a selectable choice. |
| T-11-04 | Recipient email (unmasked) and recipient mobile (masked "+971 50 XXX XXXX") | 09, 10, 11 | masked display only; destination resolved by the adapter from the party reference `core/notifications/offer-notification.ts:1-60` | `test/unit/offer-letter.test.ts` "refuses an unmasked email or mobile", "mask predicates" | 🟡 | By design neither is held in clear in Sanad. |
| T-11-05 | Language dropdown "Arabic + English" | 09, 10, 11 | fixed "Arabic and English" `[app]/offer/page.tsx:361` | `test/unit/offer-letter.test.ts` "email: English body with an Arabic summary…", "SMS: Arabic first, then English…" | ✅ | Always both; not selectable. |
| T-11-06 | "Confirm & Send — Automated actions on confirmation"; button "Confirm & Send — Email + SMS + PDF" | 10, 11 | `business.ts:2589` `sendOffer` → `app.ts:372` `recordOfferSent`; one OFFER_ISSUED outbox event per letter version | `test/unit/ops-business-service.test.ts` "sending the same letter version twice queues one notification…"; "writes OFFER_SENT and its OFFER_ISSUED outbox row between one begin and its commit" | 🟡 | Email + SMS ✅, idempotent; no PDF. |
| T-11-07 | ① Email notification "Sent automatically · FOL PDF attached · Arabic + English" | 10, 11 | email body `offer-notification.ts:100-125` (English with Arabic summary, signing-link placeholder, letter version) | `test/unit/offer-letter.test.ts` "the preview is exactly what would be sent", "email: English body with an Arabic summary…" | 🟡 | A signing link, not an attachment. ❓ Q19. |
| T-11-08 | Email preview: Subject "Facility Offer Letter — [fund] (FR-00005061)"; "Dear [person's name], We are pleased to confirm that your application for an Expansion Loan of AED 2,000,000 has been approved. Please find your FOL attached in Arabic and English. Please sign and return within 30 days via your TAMM portal (UAE Pass)." Signed by the fund | 11 | subject "{title} {ref} — {lender} \| {title ar}"; body addresses the business, lists amount, tenor, rate, instalment, valid-until date and the signing link | as T-11-07 | 🟡 | Different wording; addressed to the business, not a person; validity as a date, not "30 days"; no TAMM mention. ❓ Q19. |
| T-11-09 | ② SMS "Sent automatically · Arabic SMS · Offer summary · Signing link" | 10, 11 | SMS body `offer-notification.ts:127-137` (Arabic first, then English; amount, valid-until, signing link, reference, short version) | `test/unit/offer-letter.test.ts` "SMS: Arabic first, then English; references the version; no identity-number pattern" | ✅ | |
| T-11-10 | SMS preview (Arabic): fund name, "your request has been approved for AED 2,000,000", file number, "please review the attached facility offer and sign"; English: "Your AED 2,000,000 Expansion Loan is approved. Ref FR-00005061. Please review and sign the attached FOL via TAMM." | 11 | as T-11-09 | as T-11-09 | 🟡 | Our text: "your facility offer of AED … is ready to sign until …" with the link; no product name, no "approved", no TAMM. ❓ Q19. |
| T-11-11 | "Preview Notification" button | 10, 11 | `business.ts:2496` `previewNotifications` (same function as the send); `[app]/offer/page.tsx:456` | `test/unit/offer-letter.test.ts` "the preview is exactly what would be sent"; `test/ui/business-screens.test.ts` "the offer notification preview" | ✅ | |
| T-11-12 | "Disbursement — Partner Bank + Oracle Fusion": "Upon FOL signing → Tuum CIF task created for Finance team → Oracle Fusion ERP processes payment → Bank confirms → LMS updates to Stage 8" | 09, 10, 11 | `business.ts:2717` `recordDisbursed` (body `disburseAt` `:2636`): a FINANCE principal other than the approver and submitter releases; PAYMENT_DISBURSE (rail PARTNER_BANK) and BUREAU_REPORT queued on the outbox; status → DISBURSED (stage 8) | `test/unit/ops-business-service.test.ts` "refuses the approver and the submitting officer; queues PAYMENT_DISBURSE and BUREAU_REPORT with DISBURSED"; `test/compliance/sme-products.test.ts` "disburses once, with the bureau report, both keyed on the transaction" | 🟡 | No Tuum CIF task, no Oracle ERP step, no bank confirmation callback, no LMS update; the partner-bank payment is a fixture. ❓ Q12. |
| T-11-13 | Partner bank dropdown (a named Islamic bank) | 09, 10, 11 | fixed "Partner bank" `[app]/offer/page.tsx:377`; adapter `adapters/uae/partner-bank/` BLOCKED | none | 🟡 | One partner bank per tenant; not selectable per application. ❓ Several partner banks? |
| T-11-14 | Disbursement type dropdown "Single disbursement" | 09, 10, 11 | fixed "Single disbursement" `[app]/offer/page.tsx:378` | none | 🟡 | Tranches not supported. ❓ Are tranched disbursements needed (fixed assets, expansion)? |
| T-11-15 | Disbursement on or after the planned date in the signed offer | — (implied) | `business.ts:2665-2672` `DISBURSEMENT_BEFORE_PLANNED_DATE` | `test/unit/ops-business-service.test.ts` "#6 refuses a disbursement earlier than the signed offer's planned disbursement date, queuing nothing" | ✅ | Our control; not on the screens. |
| T-11-16 | Mandatory bureau reporting of the new facility | — (not shown) | BUREAU_REPORT outbox event on disbursement `business.ts:2694-2703` | as T-11-12 | ✅ | Not on the screens; included because AECB data contribution applies. |

## 12. Stages 8–9 — portfolio and collections (screen 01)

| ID | What the screen shows | Screen | Where it is built | Test proving it | Status | Notes / question for Tuum |
|---|---|---|---|---|---|---|
| T-01-25 | Portfolio management (LMS · ERP · Power BI): active loans, month on book, on-track | 01 | `business.ts:2793` `recordPortfolioStatus` (DPD, arrears, manual) | `test/unit/ops-business-service.test.ts` "#6 keeps possible timelines…days past due accrued from a past first due date" | ➖ | Tuum LMS. We record what the loan system reports, for the dashboard only. |
| T-01-26 | EWS alerts | 01 | none | none | ➖ | LMS. ❓ Q20. |
| T-01-27 | Collections (LMS · ERP · Legal): DPD, 60-day alert, legal | 01 | DPD chip only | `test/ui/business-pipeline.test.ts` "shows days past due for a facility in collections" | ➖ | LMS / ERP / legal. |
| T-01-28 | MIS reports, Power BI | 01, 02 | none (CSV export only) | `test/ui/ops-business-export.test.ts` | ➖ | |

---

## 13. Schedule check

**Method.** A scratch script outside the repository loaded the fund's catalogue
(`config/tenants/sme-fund-ae/products/catalogue.json`), validated the `sme-term-conventional`
term sheet, and called `smeTermConventional.quote()` and then `buildOffer()` — the same calls
`generateOfferAt` makes (`business.ts:2348-2377`) — with: AED 2,000,000.00; 60 instalments;
catalogue rate 150 bp annual reducing; no grace; contribution 20%; four years in operation;
disbursement 2029-08-04; first due date 2029-09-10 (payment day 10). It was run for both the
Fixed Assets and the Expansion variant; the schedule is identical.

**Result: every figure on screen 09 matches to the fil.**

| # | Date | Days | Opening | Principal | Interest | Instalment | Closing | Screen |
|---|---|---|---|---|---|---|---|---|
| 1 | 2029-09-10 | 37 | 2,000,000.00 | 31,588.08 | 3,041.10 | 34,629.18 | 1,968,411.92 | same |
| 2 | 2029-10-10 | 30 | 1,968,411.92 | 32,202.37 | 2,426.81 | 34,629.18 | 1,936,209.55 | same |
| 3 | 2029-11-10 | 31 | 1,936,209.55 | 32,162.50 | 2,466.68 | 34,629.18 | 1,904,047.05 | same |
| 4 | 2029-12-10 | 30 | 1,904,047.05 | 32,281.72 | 2,347.46 | 34,629.18 | 1,871,765.33 | same |
| 5 | 2030-01-10 | 31 | 1,871,765.33 | 32,244.60 | 2,384.58 | 34,629.18 | 1,839,520.73 | same |
| 58 | 2034-06-10 | 31 | 103,626.09 | 34,497.16 | 132.02 | 34,629.18 | 69,128.93 | same |
| 59 | 2034-07-10 | 30 | 69,128.93 | 34,543.95 | 85.23 | 34,629.18 | 34,584.98 | same |
| 60 | 2034-08-10 | 31 | 34,584.98 | 34,584.98 | 44.06 | 34,629.04 | 0.00 | same |
| Total | | 1,832 | | 2,000,000.00 | 77,750.66 | 2,077,750.66 | | same |

**Conventions that make it match** (`core/pricing/dated-schedule.ts`, header conventions 1–5):
actual/365 day count; interest per period = opening balance × 150 bp × actual days ÷ 3,650,000,
rounded half up to the fil; a level instalment equal on every row but the last, found as the
smallest whole-fil amount whose final instalment does not exceed it; the last instalment clears
the balance (34,629.04). A plain monthly annuity (rate ÷ 12, 30/360) gives 34,619.78 and would
not match.

**The disbursement date is inferred, not shown.** First-row interest 3,041.10 is 2,000,000 ×
1.5% × 37 ÷ 365; 36 days gives 2,958.90 and 38 days 3,123.29, so the first period is 37 days and
the disbursement date is 2029-08-04. The golden test fixes the same inputs
(`test/unit/dated-schedule.test.ts`, "first period is 37 days and the level instalment is
34,629.18"; `test/compliance/sme-variants.test.ts`, "the golden core-banking case is priced on
the dated ACT/365 schedule, and the platform computes the APR").

**APR.** `buildOffer` computes 151 bp (1.51%) from the dated cash flows; the screens show no APR.

**But the workbench would not produce this offer from this application as shown.** Three things
stand in the way, all in section 14: the application asks for AED 5,000,000 (the quote would
refuse it above the 2M variant ceiling, and the facility is always the requested amount); it asks
for 72 months on a Fixed Assets product (maximum 60); and a schedule starting in 2029 from an
offer dated June 2026 is outside our illustrative offer-date bounds (`offer-policy.json`:
disbursement at most 60 days after the offer).

## 14. Inconsistencies inside the screens

| # | Inconsistency | Screens |
|---|---|---|
| 1 | Offer dated 05 June 2026, valid to 05 July 2026, but the schedule runs 10 Sep 2029 → 10 Aug 2034. | 09, 10 |
| 2 | Product dropdown shows Fixed Assets (≤2M · 60m) selected; the info box, header, credit assessment, offer, letter and notifications say Expansion Loan. | 03, 04 vs 06–11 |
| 3 | Requested AED 5,000,000 and 72 months (screen 03) against a Fixed Assets product capped at 2M and 60 months; the facility offered is 2M over 60 months. | 03, 09 |
| 4 | DSCR 1.72 on screen 03 (310,000 ÷ 180,000) but 2.72x in the knock-out table and the credit report notes. | 03, 08 |
| 5 | Credit assessment dated 21 May 2026, before the 04 June 2026 hand-over at stage 4 → 5. | 03, 06 |
| 6 | "Commitment Assessment" scores 1.010, above the 1.000 maximum every other criterion respects. | 07 |
| 7 | Project criterion scores average 0.7675 unweighted, yet the section total is 0.8689; the weights are not shown. | 07 |
| 8 | Dashboard KPI "Active applications 23" matches neither the kanban's stages 5–7 (16) nor 5–9 (51). | 01 |
| 9 | Contribution "20% · AED 400K" is 20% of the facility, while the product rules define contribution against project cost (CAPEX). | 03, 09 |
| 10 | Letter says "Profit rate" (Islamic usage) for a "loan" with "interest" in the schedule. | 09, 10 |
| 11 | Purpose "CAPEX + OPEX Mix" is offered with Fixed Assets selected. | 03 |
| 12 | Email asks the applicant to "sign and return within 30 days via your TAMM portal", while screen 09 says the letter is sent via TAMM for UAE Pass signature and the SMS says "sign the attached FOL via TAMM"; the FOL is described as attached in both messages and as generated in two copies. | 09, 11 |

## 15. What could not be determined

- The fund's scorecard weights and scoring functions: the screens give section weights and
  scores, but not criterion weights for the project section, nor whether criterion scores are
  banded or continuous.
- The disbursement date behind the screen's schedule (inferred as 2029-08-04 from the 37-day
  first period).
- Which product the example application is (Fixed Assets or Expansion).
- What "ADREC verified", "Awaiting bank KYC", "EWS alert" and "60-day alert" require, and which
  system raises them.
- Parameters and checklists for the five products other than Fixed Assets and Expansion.
