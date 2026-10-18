# Pending

Everything waiting on someone, kept in one place. Updated as items close.
Last updated: 18 October 2026.

## Waiting on the product owner

- **Merge the stacked PRs.** Each is built on the one before; only #35 targets `main`.
  #35–#40 UAE SME M2b–M6 · #41–#44 KSA K1–K4 · #45–#47, #55 servicing S1–S4 ·
  #48–#53 Nutrient documents, letterhead, typeface · #54 Saudi demo books ·
  #56–#58 Wasl W1–W3. Auto mode cannot merge.
- **Renew the `APICAPIKEY` GitHub secret.**
- **Bank A's Tawarruq board ruling.** Record it in Admin. `sme-term-islamic` stays
  disabled until it's recorded.
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
| KSA-RAIL-TAHAQOQ-01 | Tahaqoq | |
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
- **ILLUSTRATIVE configuration** to replace with the institution's own:
  `config/tenants/bank-a/wasl/parties.json` (programmes, anchors, distributors,
  signatories, institution registration), `core-banking/murabaha-accounts.json`,
  `core-banking/loan-products.json`, `shariah/board-positions.json`.
- **Semgrep** has not been run locally on W2/W3 (not installed here). CI's gate is the
  first run.

## Security register items still open

- **SR-021:** no branch protection on `main`; commits unsigned.
- **SR-024:** in remediation. CI coverage of the unit, contract and adapter suites.
- **SR-039:** in remediation. The threat model is drafted, not reviewed.
- **SR-040:** the repository is public.
- **SR-047:** deployment-wide Admin actions are open to any institution's administrator.
- **SEC-Q01 … SEC-Q08:** open questions for the client (CSCC classification, CSF level,
  VAPT provider, SOC, notification contacts, disclosure programme, sign-off).

## Housekeeping

- Local Docker containers `sanad-w2-pg` (port 55432) and `sanad-w3-demo` (port 55433)
  are throwaway test databases. Remove them when no longer needed.
