# Pending

Everything waiting on someone, kept in one place. Updated as items close.
Last updated: 26 October 2026.

## Waiting on the product owner

- **Merge the stacked PRs.** Each is built on the one before; only #35 targets `main`.
  #35–#40 UAE SME M2b–M6 · #41–#44 KSA K1–K4 · #45–#47, #55 servicing S1–S4 ·
  #48–#53 Nutrient documents, letterhead, typeface · #54 Saudi demo books ·
  #56–#58 Wasl W1–W3 · #59 Wasl W4a · #60–#64 document intelligence D1–D5 · #65 UI · #66–#67 Wasl W4b-1, W4b-2 · #68–#69 Wasl W5a, W5b ·
  #70 Wasl W6a · #71 Wasl W6b-1 · #72 Wasl W6b-2 · #73 Wasl W6c.
  Auto mode cannot merge.
- **Record each institution's Shariah approvals (W6a).** Since W6a nothing Islamic originates until the approval
  its configuration cites is in the register: Bank A `SSB-A-2026-014` (Wasl) and `SSB-A-2026-021` (personal
  Tawarruq), Fintech B `SSB-B-2026-007` (its structure) and `SSB-B-2026-003` (its catalogue's Wasl entry). A Shariah
  reviewer records each at `/shariah/approvals` and a second confirms, with the board's members, dates and the
  template versions it approves. The references in the checked-in files are ILLUSTRATIVE.
- **Renew the `APICAPIKEY` GitHub secret.**
- **Bank A's Tawarruq board ruling.** Record it in Admin. `sme-term-islamic` stays
  disabled until it's recorded.
- **Bank A's late-amount ruling (Wasl W4b-2).** The basis (a fixed amount per instalment is assumed), the grace
  period, and the charities a collected late amount may go to, with their accounts. They replace the ILLUSTRATIVE
  `lateAmounts` in `config/tenants/bank-a/shariah/board-positions.json`.
- **Each board's purification ruling (Wasl W6b-2, OI-12).** Whole profit or an assessed amount, the basis
  reference, the charities purified income may go to, and what to do with profit that is never collected. They
  replace the ILLUSTRATIVE `purification` in each tenant's `board-positions.json`.
- **ADR 0007 board view.** Each institution's Shariah board states its view on servicing
  a Tawarruq debt through a rate-carrying loan contract before go-live.
- **SME portal deployment.** It is behind sign-in since W3 (SR-019) but not deployed.
  Deploying it is a separate decision.

## Live rail verification (each needs sandbox credentials)

Every rail runs on a fixture transport until its live transport makes a verified call.
The findings go in the adapter README.

| Item | Rail | Notes |
|---|---|---|
| KSA-RAIL-NAFATH-01 | Nafath | SME portal sign-in and offer signing, KSA signing |
| KSA-RAIL-YAKEEN-01 | Yakeen | |
| KSA-RAIL-WATHQ-01 | Wathq | Will also supply distributor signatories (replacing `parties.json`) |
| KSA-RAIL-SIMAH-01, KSA-RAIL-BAYAN-01 | Credit bureaus | Enquiry and reporting |
| KSA-RAIL-GOSI-01 | GOSI | |
| KSA-RAIL-ZATCA-01, -02 | ZATCA e-invoicing, zakat | Wasl gate 1 ownership invoice; the demo stamp is waived on FIXTURE only |
| KSA-RAIL-OB-01, -02 | Open Banking AIS/PIS | |
| KSA-RAIL-SADAD-01 | SADAD | |
| KSA-RAIL-PAYHUB-01 | Payments hub | |
| KSA-RAIL-RATEPUB-01 | Rate Publisher | |
| KSA-RAIL-TAHAQOQ-01 | Tahaqoq | Document authenticity (D3); also confirm what identifies a document to it |
| KSA-RAIL-BROKER-01 | Commodity broker | |
| UAE-RAIL-UAEPASS-01, -ICP-01, -NER-01, -AECB-01, -FTA-01, -MOHRE-01, -OPENFINANCE-01 | UAE rails | |
| TUUM-LEND-01 | Tuum lending | Loan contracts (UAE M6, KSA K4); totals reconciliation |
| TUUM-ACCT-01 | Tuum accounts | Wasl account-shaped booking: Bank A's posting codes and account types |
| V-04 … V-08 | Nutrient Document Engine | Signature validation, forms, extraction, redaction (see `adapters/nutrient/verification/README.md`) |

## Built, with parts deliberately deferred

- **Timestamping authority (A3).** The RFC 3161 adapter is built (`adapters/tsa/`) and accepts a real
  authority's token (FreeTSA, 2026-10-28). What waits is E-04: **each institution's accredited authority**,
  saved in Admin → Credentials under the timestamping authority (`endpoint_url`, `authority_id`,
  `trust_anchors_pem`, optional `policy_oid` and `authorization`), then its rail enabled in Admin → Rails.
  Until then the host clock stands in, on synthetic data only (SR-006).
- **Standalone Temporal worker process.** Needs import-alias resolution. Today the
  servicing cycle runs from the pipeline.
- **Wasl.**
  - **W5a built**, PR #68 (stacked on #67): distributor facilities, limits, concentration and the financed-invoice registry,
    as decided on 22 October 2026.
    - **Facilities:** credit proposes a distributor's limit in a programme and a second person approves it at
      `/facilities`. This writes `core.facility_approval` and `core.facility` (migration 0031). No facility, no trade.
    - **Trade validation** checks, in order: the facility, the programme, then the concentration rules the
      institution chose. The first that doesn't fit refuses, and nothing is held.
    - **Concentration:** the three rules (single-trade cap, distributor share of programme, anchor share of book) are
      chosen per institution in **Admin → Concentration**, under four eyes (revision area `CONCENTRATION`). Bank A's
      fallback file `wasl/concentration.json` is ILLUSTRATIVE: cap SAR 5m and distributor share 25% on, anchor share
      off. Shares are measured against limits, not utilisation; the book is the sum of programme limits.
    - **Holds:** in the database each hold is a `core.limit_reservation` row. It is consumed at purchase, released on
      an unwind before purchase, and repaid on settlement or a later unwind. The invoice goes into
      `core.financed_invoice_registry` at purchase (SH-10). A hold has the 30-day expiry the schema requires but does
      not lapse on it; there is no job releasing abandoned holds, since an unwind releases them.
    - **Not done:** every institution has to approve facilities before Wasl can trade again. Existing demo requests
      will be refused with NO_FACILITY until someone approves one at `/facilities`. Transactions held before W5a have
      no reservation, so their facility isn't moved, though their invoice is registered at purchase.
    - Facilities can't be suspended yet; a lower approved limit is the only way to restrict one. Limits are in SAR only.
    - **Not reviewed in a browser** in RTL or LTR: `/facilities` and Admin → Concentration (the W4b-2 screens neither).
  - **W5b built**, PR #69 (stacked on #68): programmes, anchors and the goods register, editable in Admin under four eyes, as
    decided on 22 October 2026.
    - **Admin → Programmes & anchors** (new revision area `PROGRAMMES`, migration 0032) adds, changes or removes one
      programme: names, limit, anchor and the anchor's settlement IBAN. The change is checked against live exposure at
      proposal and again at approval: no removal while a transaction or facility refers to it, no new anchor once it
      has traded, no limit below what it holds or below a facility in it.
    - **Admin → Goods register** adds or removes one HS heading, as a `BOARD_POSITIONS` revision that carries every
      other board position as it stood (the late-amount ruling included).
    - **Fixed:** until W5b, every Wasl step, booking, facilities and transaction opening read the board positions and
      programmes from the **file**. An approved board revision would not have bound a Wasl trade. They now all read the
      configuration in force (`services/origination/src/wasl/configuration.ts`).
    - Workbench `/programmes` (programmes, anchors and their share of the book) and `/goods` (the register in force,
      and the headings financed) are read-only views.
    - **A new programme also needs its terms in the product catalogue** (Admin → Products & modules) before a
      transaction can open on it, and facilities approved for its distributors. A new anchor's CR and IBAN are typed
      in, with no Wathq or bank verification (KSA-RAIL-WATHQ-01).
    - Distributors and the institution itself stay in `parties.json` (onboarding is not built).
    - A goods-register change binds new transactions only. Transactions already open keep the screening they had.
    - **Not reviewed in a browser** in RTL or LTR: Admin → Programmes & anchors, Admin → Goods register, workbench
      `/programmes` and `/goods`.
  - **W6a built**, PR #70 (stacked on #69): the Shariah approvals register, as decided on 26 October 2026 (W6 split into
    W6a register, W6b checks/incidents/purification, W6c audit workspace/Board report).
    - **Workbench → Shariah governance → Approvals register** (`/shariah/approvals`). A Shariah reviewer records an
      approval (body, reference, members, effective and review or expiry dates, products and template versions);
      a second reviewer confirms. Suspend, reinstate, withdraw and renew go the same way. Migration **0033**:
      `core.shariah_approval_change` (decided once, four eyes in the table, one open proposal per approval), with
      each confirmation projected onto `core.shariah_approval`, whose recorded terms are then immutable.
    - Two new staff authorities, `SHARIAH_REVIEWER` and `SHARIAH_AUDITOR` (read-only, used from W6c), mapped to
      `sanad.<tenant>.shariah-reviewers` / `-auditors` in every tenant's staff identity configuration. Development
      identities `STAFF_DEV_TOKEN_SA_SHARIAH_1`, `_2`, `_SA_SHARIAH_AUDITOR`, `_FB_SHARIAH_1`, `_2`,
      `_AE_SHARIAH_1`, `_2` are in `.env.example`; **`.env.local` needs tokens for them** before the screen can be
      tried locally.
    - **SH-17 at every new-business point:** Wasl request (API and workbench), transaction opening (approval in
      force, covering Wasl and every template the board approves), limit hold, wa'd and purchase; SME Tawarruq
      hand-over and offer; consumer Tawarruq quote and acceptance; and enabling an Islamic product in Admin →
      Products (in force when the change takes effect). A lapse is a date: nobody acts on it.
    - Executed transactions keep their approval. After the purchase the sale of goods already owned, booking and
      servicing continue under it.
    - **Gap made sharper:** a transaction holding its limit (`LIMIT_RESERVED`) when its approval stops cannot
      move until reinstated. The Murabaha module has no transition that releases a hold before the wa'd (unwind
      starts at `WAAD_EXECUTED`). This was true before W6a for any abandoned hold. It needs a release transition in
      `products/murabaha-scf/sequencing/`, which is its own reviewed change.
    - Approval dates are entered and stored Gregorian; the screen shows the Umm al-Qura date beside them,
      converted for display.
    - Database cases and migration 0033 ran locally on 26 October on a fresh database (`sanad_w6a` in
      `sanad-w2-pg`), every migration applied from empty and 0033 applied twice; the full suite passed against it.
    - **Not reviewed in a browser** in RTL or LTR: `/shariah/approvals`, and the SH-17 notice in Admin → Products.
  - **W6b-1 built**, PR #71 (stacked on #70): automated Shariah checks and incidents, as decided on 26 October 2026 (W6b split
    into W6b-1 checks/incidents and W6b-2 purification; severity LOW / MEDIUM / HIGH / MATERIAL; an open MATERIAL
    incident stops the sale).
    - **The Shariah review** (`products/murabaha-scf/compliance/checks.ts`, run by `services/origination/src/wasl/
      compliance.ts`) re-checks every live Wasl transaction from its own record:
      - the legs' chain and order, and a state not ahead of its legs;
      - each gate evidenced, and every gate holding when the sale was offered;
      - the risk period at the sale offer;
      - distinct parties, the same buyer on every leg;
      - the goods against the register at opening and as it stands;
      - the sale price is the cost plus the profit;
      - template drift: each leg's template is in the approval it executed under, and each executed document is
        rebuilt from its template and the transaction's figures and compared by hash (one `instrumentHash` for
        execution and the check).
    - It runs in the daily cycle (tenant task `SHARIAH_REVIEW`, after reconciliation) and from **Workbench → Shariah
      governance → Incidents** (`/shariah/incidents`). Each failure is raised once, ever (fingerprinted).
    - **Incidents**: raised by the review or as a reviewer's observation; triaged (severity, owner, a reason for
      re-rating), planned, remediated and closed, in that order; closed by a different reviewer with evidence.
      Migration **0034** (`core.shariah_incident`, `core.shariah_incident_event`) enforces the order, the four eyes at
      closing and write-once rows.
    - **An open MATERIAL incident** on a transaction stops the wa'd, the purchase and the sale offer (SH-17
      `SHARIAH_INCIDENT_OPEN`). Unwinding is not stopped; a transaction already sold is not touched.
    - An incident remediated as affecting income closes only once it is purified in full (W6b-2, below).
    - The opening event now records the goods it screened. Transactions opened before W6b-1 have none recorded; the
      review raises a LOW `GOODS_SCREENING_NOT_RECORDED` for each.
    - Evidence "as it stood at the sale" is read by capture time; a checker's decision keeps the artefact's capture
      time. The sequencing engine refuses a sale before its gates are decided, so this reads real sales correctly.
    - The institution's registration in a rebuilt document is read as it stands. If the institution's CR in
      `parties.json` changes, every executed document will read as drifted.
    - Database cases and migration 0034 ran locally on 26 October on a fresh database (`sanad_w6b`), every migration
      applied from empty and 0034 applied twice; the full suite passed against it.
    - **Not reviewed in a browser** in RTL or LTR: `/shariah/incidents`.
  - **W6b-2 built**, PR #72 (stacked on #71): purification of income from a defective transaction (BR-F06), as decided on
    26 October 2026 (the board's method per tenant; raised as the profit is collected).
    - **The board's ruling** is a new `purification` position in board-positions (method `WHOLE_PROFIT` or
      `ASSESSED_AMOUNT`, basis key, its own approved recipients), carried by every BOARD_POSITIONS revision.
      ILLUSTRATIVE: Bank A whole profit to `chr-a-01`; Fintech B an assessed amount to an invented `chr-b-01`.
    - **On the incident** (`/shariah/incidents`): once remediated as affecting income, a Shariah reviewer proposes the
      amount by the board's method (never above the profit), and a second reviewer confirms or rejects it.
    - **Raised as collected:** the amount is split across the instalments in proportion, the last taking the
      remainder. Each share is raised when its instalment is paid, to `core.charity_ledger` as `NON_COMPLIANT_INCOME`
      (key `wasl:<ref>:purify:<incident>:I<n>`) and to the core's charity liability together. Shares already paid
      are raised at confirmation. One the core could not take is raised by the daily Shariah review.
    - **Disbursed** share by share, by finance and a second person, to a recipient the board approved for
      purification, through the payments hub (as late amounts are).
    - **The incident closes** only when every share is raised. Migration **0035** has the table check this against
      the ledger itself (the confirmed amount = the sum of the incident's NON_COMPLIANT_INCOME entries).
    - Lifecycle in the transaction's event log (`services/origination/src/wasl/purification.ts`); the product
      registers its "purified in full" check with the incident service. A product that registers none can never
      close an incident that affected its income.
    - **Not done:** an incident whose instalments will never all be paid (hardship, write-off) cannot close. The
      board must rule what purifying uncollected profit means. A payment returned after its share was raised leaves the
      share raised (the ledger is write-once): over-purified, never under. The payments hub's result for a
      disbursement is not recorded, as with late amounts.
    - Purification amounts and the disbursement screens were typechecked but **not reviewed in a browser** in RTL or
      LTR. The charity ledger page now counts purified income in its totals.
    - Database cases and migration 0035 ran locally on 26 October on a fresh database (`sanad_w6b2`), every migration
      applied from empty and 0035 applied twice; the full suite passed against it.
  - Contract legs are hashed canonical content; the PDF rendition through Document
    Engine and an embedded viewer in the SME portal are not built.
  - **W6c built**, PR #73 (stacked on #72): the Shariah audit workspace and the Board report (BR-F05, BR-F08, SH-18). W6 is complete.
    - **Workbench → Shariah governance → Audit workspace** (`/shariah/audit`), for `SHARIAH_AUDITOR` and the reviewers.
      Search, or draw a sample that the same seed draws again (`core/shariah/sampling.ts`). The replay of any
      transaction, in plain words, shows:
      - each contract in order with its time, fingerprint and link to the one before;
      - each step's evidence as the sale saw it;
      - the risk period required and held;
      - the figures disclosed;
      - the approval as it stood the day it opened;
      - every Shariah check;
      - whether the invoice was financed once.
    - **Audit pack**: a JSON download whose manifest carries the SHA-256 of each part; `verifyAuditPack` names the part
      changed in a copy. **Raise an observation**: the auditor's only act. It becomes an incident for the reviewers.
    - **Board report** (`/shariah/report`), for a period:
      - transactions opened and executed;
      - the risk period held before each sale (shortest, median, any below the board's);
      - incidents raised, closed and open by severity and age;
      - template drift;
      - late amounts, purified income, charity given and held;
      - the approvals register at the period's end.

      It is printable, and downloadable as JSON.
    - Defaults chosen where the solution design is silent (sampling method, pack contents, report format). The
      institution's Shariah audit methodology and annual-report format (SDD Phase 0) may change them.
    - Not done:
      - The pack is JSON, not a signed PDF. A PDF rendition through Document Engine with a seal is the natural
        next step.
      - Gate refusals (SH-17, sale stopped) are not events, so the report does not count them.
      - Signature validation of executed documents waits on the PDF rendition and V-04.
    - **Not reviewed in a browser** in RTL or LTR.
  - **W4b-1 built**, PR #66 (stacked on #65): SADAD paid-bills reconciliation (`/transactions/reconciliation`), and Wasl in
    the daily servicing cycle (reconciliation first, then collections).
    - FIXTURE until KSA-RAIL-SADAD-01. Each tenant's SADAD **biller id** must be configured before it can go live.
    - The latest reading and its exceptions are held in memory and shown until the process restarts. Unmatched
      bills reappear at the next reading, but there is no persistent exceptions queue yet.
    - Credit-bureau reporting of Wasl facilities is not built. The cycle reports that task as not this facility's.
  - **W4b-2 built**, PR #67 (stacked on #66): late amounts and the charity ledger, as decided on 21 October 2026. The cycle
    proposes, an officer assesses, a second person confirms. A confirmed amount is billed on its own SADAD bill. It is
    raised to `core.charity_ledger` and the core's charity liability only when collected, then disbursed to a
    board-approved recipient after a second person approves. Ledger view at `/transactions/charity`.
    - **Needs from the board:** the late-amount basis, the grace period and the approved recipients. They are in
      `board-positions.json` → `lateAmounts`, all ILLUSTRATIVE: SAR 500 per instalment, 5 days' grace, two invented
      charities with invented IBANs. The basis is a **fixed amount per instalment**, since the Murabaha module holds no
      rate. If the board rules a proportion of the overdue amount instead, that is a change to the ruling's shape.
      A board that rules none gets no proposals.
    - Migrations **0030** and 0031 and the W4b-2 and W5a database cases ran locally on 22 October on a fresh database
      (`sanad_w5` in `sanad-w2-pg`), with every migration applied from empty; the full suite passed against it.
    - The charity liability is posted to the core **synchronously** when the collection is recorded, as booking is.
      If the core is unavailable, nothing is recorded, the webhook is answered 503 so SADAD delivers it again, and
      reconciliation lists it as an exception. It is not on the outbox, because the dispatcher has no core-banking
      port.
    - The payments hub's result for a charity disbursement is not recorded. The payment-results webhook only knows
      seller payments, so the outbox delivery is the only evidence it was paid.
    - A late amount's payment that comes back after it was raised to charity is refused for operations. There is no
      queue for it, and no reversal of the ledger entry, which is write-once.
    - The hardship assessment closes the late amount only. Wasl collections are not suspended for hardship (the
      Hardship module stays NOT_BUILT).
    - The four screens (assess, confirm, propose a recipient, approve) were typechecked but **not reviewed in a
      browser** in RTL or LTR.
  - A return that arrives after an obligation has settled is refused for operations to resolve. There is no
    operations queue for it yet.
  - Wasl's payment and collection webhooks need each tenant's PAYMENTS_HUB and BILL_COLLECTION `webhook_secret`
    in the vault. Anchor settlement IBANs in `parties.json` are ILLUSTRATIVE.
- **ILLUSTRATIVE configuration** to replace with the institution's own:
  `config/tenants/bank-a/wasl/parties.json` (programmes, anchors, distributors,
  signatories, institution registration), `core-banking/murabaha-accounts.json`,
  `core-banking/loan-products.json`, `shariah/board-positions.json`.
- **Semgrep** has not been run locally on W2/W3 (not installed here). CI's gate is the
  first run.

## Document intelligence (docs/DOCUMENT-INTELLIGENCE-PLAN.md)

- **D1 built**, PR #60: findings and classification on business uploads.
- **D2 built**, PR #61 (stacked on #60): checks on what the document says, declared per checklist item and shown to the
  checker. The checks in every checklist are ILLUSTRATIVE; each institution sets its own limits.
  - Corroboration against Wathq and GOSI waits on KSA-RAIL-WATHQ-01 and KSA-RAIL-GOSI-01.
  - The UAE seed applications' licence references (`TL-ILLUS-nnnn`) are too short to compare, so
    REGISTRATION_MATCHES reads UNREADABLE for them until real licence numbers are used.
- **D3 built**, PR #62 (stacked on #61): authenticity with Tahaqoq, under a new document-verification consent at Saudi
  intake. A document the issuer doesn't confirm needs the checker's written resolution to be accepted.
  - Fixture only until KSA-RAIL-TAHAQOQ-01. The sandbox must also answer what identifies a document to Tahaqoq;
    today the adapter sends Sanad's own document reference.
  - Seeded and partner-handed-over applications have no Sanad consent, so their authenticity check reads "not
    checked: no consent".
- **D4 built**, PR #63 (stacked on #62): the gaps on a business application, one request to the applicant per gap set,
  and the case shown ready again when the last gap closes.
  - The notification goes to the outbox. What the applicant actually receives depends on the notifications adapter
    and its templates for `INFORMATION_REQUESTED`, which aren't built (the development port only records it).
  - **Applications from Sanad's own intake can't be sent a request yet**, and can't be sent the offer either
    (`OFFER_NOTICE_NO_CHANNEL`). Intake records the contact party but not whether it has an email or mobile, so
    both refuse with no channel. Seeded and partner applications carry it. Intake needs to capture the signatory's
    contact channels (masked, as everywhere else).
  - The stage clock doesn't pause while a case waits on the applicant. Whether it should is a policy decision for
    the product owner.
  - Wasl isn't covered until its documents are uploaded rather than referenced.
- **D5 built**, PR #64 (stacked on #63): the throughput view at `/documents/reading`. Measurement only.
  - Revisiting "always four eyes" is the product owner's call. The view's "accepted despite a failed check" figure
    is the evidence for it, once there is live volume.
- **Document intelligence D1–D5 is complete.**
- **Live reading needs:** the Document Engine configured for the tenant, V-05/V-06 verified on real Saudi and UAE
  samples, and the catalogues (ILLUSTRATIVE) tuned against them.
- **Images (PNG, JPEG) are not read.** They need the engine's OCR path.
- **Wasl request documents** are attached by reference, not uploaded, so there is nothing to read until they're
  uploaded.

## Security register items still open

- **SR-021:** no branch protection on `main`; commits unsigned.
- **SR-024:** in remediation. CI coverage of the unit, contract and adapter suites.
- **SR-039:** in remediation. The threat model is drafted, not reviewed.
- **SR-040:** the repository is public.
- **SR-047:** deployment-wide Admin actions are open to any institution's administrator.
- **SEC-Q01 … SEC-Q08:** open questions for the client (CSCC classification, CSF level,
  VAPT provider, SOC, notification contacts, disclosure programme, sign-off).

## Housekeeping

- Local database runs: the Docker VM's clock drifts behind the host after sleep (9 s on 19 October), which fails
  `test/contract/spent-tokens-postgres.test.ts` locally. Restart Docker Desktop to resync. Under heavy load (another
  project's kind cluster), the database suite needs `--testTimeout=60000`.
- Fresh local test databases `sanad_d4` and `sanad_w5` (all migrations to 0031) were created in `sanad-w2-pg`; the old
  `postgres` database there is full of earlier runs and exhausts the Murabaha test's request numbers. Wasl facilities
  persist across runs in a database, so a long-used one eventually exhausts the test facility (SAR 10m).

- Local Docker containers `sanad-w2-pg` (port 55432) and `sanad-w3-demo` (port 55433)
  are throwaway test databases. Remove them when no longer needed.
