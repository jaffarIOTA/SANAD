# What the government and bureau rails publish — for synthetic demonstration responses

**Researched 2026-10-12.** Every demonstration transport answers in a provider's *published*
response shape where one exists, and in Sanad's own port vocabulary where none does — never in
invented vendor field names. Each adapter README cites the row below as its demonstration source
and keeps the field names as a verification item until a sandbox call confirms them.

Legend: **Published** — an official, retrievable specification. **Third-party** — the shape comes
from wrappers or integrators, not the provider; field names unconfirmed. **None** — partner-only;
the demonstration speaks Sanad's port vocabulary and says so. **Analogue** — nothing is public, so
the assumed contract follows a named public model of the same kind; field names are this
platform's assumption.

## United Arab Emirates

| Rail | Spec | Source | What the demonstration uses |
|---|---|---|---|
| **CBUAE Open Finance** (bank statements, AIS) | **Published** — OpenAPI 3.0, standards v2.1-final, base `/open-finance/account-information/v2.1` | openfinanceuae.atlassian.net/wiki/spaces/standardsv2dot1final/pages/702421137 | `Data/Links/Meta` envelope; Account `Status`, `AccountType` (Retail/SME/Corporate), `IsShariaCompliant`; Balance `Type`, `CreditDebitIndicator`, `Amount{Amount,Currency}` with Amount as a **string**; Transaction `TransactionType`, `SubTransactionType`, `Status`, `Flags[]` (incl. `Payroll`, `Finance`); consent `Status` values and `OpenFinanceBilling.Purpose` (`RiskAssessment`); errors `{Errors[{Code,Message,Path,Url}]}`. `CurrencyExchange.ExchangeRate` is a number in the spec — the adapter must convert it so no float reaches the domain. |
| **UAE Pass** (authentication, signature) | **Published** | docs.uaepass.ae (attributes list; signature integration guide) | OIDC claims by assurance level (SOP1/2/3; `idn` only at SOP2/3); signer process `POST /trustedx-resources/esignsp/v2/signer_processes`, result `status` `finished|failed|failed_documents|canceled`. Enumerations of `userType`, `gender`, `idType` are not published. |
| **AECB** (bureau) | None | u.ae "financial credibility"; Emirates Islamic and Gulf News on the score | Score **300–900**, higher = lower risk (individual and commercial); report *contents* only as described publicly (score, payment history, contracts, court obligations, bounced cheques). No field names. |
| **FTA** (TRN / VAT) | None — CAPTCHA website tool | tax.gov.ae | TRN is 15 digits; a valid one returns the legal name (EN/AR), otherwise "does not exist". Port vocabulary only. |
| **MoHRE / WPS** (payroll) | None for lenders | Bank SIF file guides; Ministerial Resolution 340/2026 (85% paid = compliant) | Not called. Payroll evidence comes through Open Finance `Flags: Payroll`. |
| **ICP** (Emirates ID) | None — contract-gated gateway | icp.gov.ae ICA Validation Gateway | Port vocabulary only. The public route to a verified Emirates ID is UAE Pass `idn` at SOP2/3. |
| **NER** (trade licence) | None — public search website | u.ae National Economic Register | Port vocabulary; ISIC4 activities, licence status, issuing authority. Status enumeration not published. |

## Saudi Arabia

Adapters in `adapters/ksa/<rail>/`; the demonstration transport and synthetic cast in
`adapters/ksa/demonstration/` (`KsaDemonstrationTransport`, three companies, four people,
steering rules in the transport's header). Updated 2026-10-12 when the adapters were moved onto
these shapes.

| Rail | Spec | Source | What the adapter and the demonstration use |
|---|---|---|---|
| **SAMA Open Banking** (AIS) | **Published** framework; a bank's faithful implementation | openbanking.sama.gov.sa; developer.alrajhibank.com.sa/open-banking/APIGuides (AIS 2022.11.01-final-errata2) | `GET /accounts`, `/accounts/{AccountId}/balances`, `/accounts/{AccountId}/transactions` in `Data/Links/Meta`; `CreditDebitIndicator` `KSAOB.Credit|KSAOB.Debit`; `Status` `KSAOB.Booked|Pending|Rejected`; `Flags` (`KSAOB.Payroll`, `KSAOB.Loan`); balances by `Type` (`KSAOB.InterimBooked`…); `Amount` strings → bigint. Affordability is derived in the adapter (`affordability.ts`). `TransactionType` values in the demonstration (`KSAOB.LocalBankTransfer`, `KSAOB.POS`, `KSAOB.SADAD`) unconfirmed. PIS schemas not retrieved — inferred only. |
| **ZATCA Fatoora** (e-invoice clearance) | **Published** portal, shape confirmed via third parties | zatca.gov.sa/en/E-Invoicing; qoyod.com sample responses | `validationResults{infoMessages,warningMessages,errorMessages,status: PASS|WARNING|ERROR}`, `clearanceStatus: CLEARED|NOT_CLEARED`, `reportingStatus: REPORTED|NOT_REPORTED`, rule codes such as `BR-KSA-F-06`. No public read-by-UUID API: the lookup path and the decoded `invoice` block (UBL element names) are assumptions. |
| **ZATCA zakat certificate** | None — web e-service only | zatca.gov.sa (certificate inquiry) | The e-service's fields: certificate number, type, status, issue / expiry date, taxpayer, searched by CR. Field names and status vocabulary unconfirmed; own-key status lookup. |
| **Wathq** (commercial registration) | Third-party — portal public, spec behind login | developer.wathq.sa; noqta.tn summary of sandbox spec v6.7.0; Lean Technologies wrapper | `/v5/commercialregistration/{info,fullinfo,owners,managers}/{id}` (the adapter calls `fullinfo`); `crNationalNumber`, `crNumber`, `name`, `status{id,name}`, `entityType`, `parties[]`, `management.managers[]`, `activities[]`; published errors `400.1.1`–`400.1.7`, `404.2.1`. Field names unconfirmed. Only status `id:1` "Active" is published; 2 Suspended, 3 Struck off, 4 Expired are assumptions. |
| **Nafath** (authentication) | Third-party | Azakaw wrapper; Laravel/Packagist integrations (Elm endpoints `nafath.api.elm.sa/api/v1/mfa/request`, `/mfa/request/status`) | `transId` + `random`; status `WAITING|COMPLETED|REJECTED|EXPIRED|ERROR`; signed JWT callback; 200-second transaction. Claim names (`iat` assumed) and `service` values unconfirmed. |
| **Yakeen** (identity) | None — leaked operation names only | elm.sa; public UAPI listing SP014 (attributes); SAMA rulebook (consent required) | SP014 attributes (Arabic / English first, father, grandfather, family names; gender; date of birth Hijri and Gregorian; nationality; ID expiry) and operation names `CitizenInfo`, `AlienInfoByIqama` — **unconfirmed**. The adapter maps only match / mismatch and the log id; no attribute value crosses. Error codes are assumed names. |
| **SIMAH** (bureau) | None — schemas after membership | simah.com (product names) | **Analogue:** the international credit-bureau report layout (subject; score with reason codes; facilities with type, limit, outstanding, overdue, days past due, payment history; enquiries; defaults; judgments). Public product names: consumer report, commercial report SIMAT, TAQEEM / MOLIM scores. **Score range not public** (the 300–850 seen online is unreliable): an opaque integer, no range assumed. Reporting format is a verification item. |
| **Bayan** (bureau) | None | Bayan Credit Bureau public product pages | Same analogue and fail-closed mapping as SIMAH (`adapters/ksa/kernel/bureau-report.ts`); its own tests. |
| **GOSI** (salary) | None — likely via Wathq "Employee Information (MASDR/GOSI)" | gosi.gov.sa (wage certificate e-service); developer.wathq.sa | The wage certificate's contents: certificate number; per employment the establishment number and name, joining date, registered wage (basic, housing, other, total), employment status. Field names unconfirmed. |
| **SADAD** (collection) | None — biller onboarding | sadad.com FAQ; SAMA Open Banking `BillDetails` | `BillDetails{BillerID, BillNumber}` and the published lifecycle — presented, paid, settled, end-of-day reconciliation. Paths and other field names unconfirmed. |
| **Payments hub** (disbursement, collection) | None — each institution's own | iso20022.org external code sets | **Analogue:** ISO 20022 pacs.002 — `TxSts` `ACSC|ACSP|ACCP|ACTC|PDNG|RJCT` with `StsRsnInf.Rsn.Cd` (`AC04`, `AM04`), a pacs.004 `RtrInf` for a returned collection. SAR-only, positive-only guard. |

## How this is used

- **Published** rails are modelled field for field, so moving to the sandbox changes the
  transport and nothing else.
- **Third-party** rails follow the wrapper shape with each field marked unconfirmed in the
  adapter README.
- **Analogue** rails follow the named public model, with the adapter README saying plainly that
  every field name is this platform's assumption.
- **None** rails answer in Sanad's port vocabulary. A demonstration must never make a
  partner-only provider look as if its format were known.
- Every demonstration answer is labelled **Fixture** on screen and runs only where a synthetic
  demonstration is permitted (SR-005); production refuses it.
