# Pending

Everything waiting on someone, kept in one place. Updated as items close.
Last updated: 21 October 2026.

## Waiting on the product owner

- **Merge the stacked PRs.** Each is built on the one before; only #35 targets `main`.
  #35–#40 UAE SME M2b–M6 · #41–#44 KSA K1–K4 · #45–#47, #55 servicing S1–S4 ·
  #48–#53 Nutrient documents, letterhead, typeface · #54 Saudi demo books ·
  #56–#58 Wasl W1–W3 · #59 Wasl W4a · #60–#64 document intelligence D1–D5 · #65 UI · #66–#67 Wasl W4b-1, W4b-2.
  Auto mode cannot merge.
- **Renew the `APICAPIKEY` GitHub secret.**
- **Bank A's Tawarruq board ruling.** Record it in Admin. `sme-term-islamic` stays
  disabled until it's recorded.
- **Bank A's late-amount ruling (Wasl W4b-2).** The basis (a fixed amount per instalment is assumed), the grace
  period, and the charities a collected late amount may go to, with their accounts. They replace the ILLUSTRATIVE
  `lateAmounts` in `config/tenants/bank-a/shariah/board-positions.json`.
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

- **Timestamping authority.** The host clock stands in for an RFC 3161 authority (SR-006,
  ClaudeRecommendations E-04). Real-data deployments refuse to run without one.
- **Standalone Temporal worker process.** Needs import-alias resolution. Today the
  servicing cycle runs from the pipeline.
- **Wasl.**
  - Limits are held against the programme limit. Per-distributor facility holds
    (`core.facility`, `core.limit_reservation`) come with **W5**.
  - Contract legs are hashed canonical content; the PDF rendition through Document
    Engine and an embedded viewer in the SME portal are not built.
  - No cross-transaction evidence workspace for the board (**W6**).
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
    - Migration **0030** (unique source on `core.charity_ledger`, write-once trigger widened) has **not been run
      locally**: Docker Desktop was waiting on an administrator prompt. CI's database job is its first run, together with
      the W4b-2 case in `test/contract/wasl-booking-persistence.test.ts`.
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
- A fresh local test database `sanad_d4` was created in `sanad-w2-pg`; the old `postgres` database there is full of
  earlier runs and exhausts the Murabaha test's request numbers.

- Local Docker containers `sanad-w2-pg` (port 55432) and `sanad-w3-demo` (port 55433)
  are throwaway test databases. Remove them when no longer needed.
