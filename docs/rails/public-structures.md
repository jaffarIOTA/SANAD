# What the government and bureau rails publish — for synthetic demonstration responses

**Researched 2026-10-12.** Every demonstration transport answers in a provider's *published*
response shape where one exists. Where none does, the UAE rails now answer in the shape of a
**named public analogue** — a published standard for the same kind of record — so a synthetic
end-to-end demonstration looks like a real one; the Saudi rails still answer in Sanad's own port
vocabulary. Each adapter README cites the row below as its demonstration source and keeps the
field names as a verification item until a sandbox call confirms them.

Legend: **Published** — an official, retrievable specification. **Third-party** — the shape comes
from wrappers or integrators, not the provider; field names unconfirmed. **Analogue** — the
provider publishes nothing; the assumed contract follows the named public standard and says so in
its README; field names are not the provider's. **None** — partner-only; the demonstration speaks
Sanad's port vocabulary and says so.

## United Arab Emirates

| Rail | Spec | Source | What the demonstration uses |
|---|---|---|---|
| **CBUAE Open Finance** (bank statements, AIS) | **Published** — OpenAPI 3.0, standards v2.1-final, base `/open-finance/account-information/v2.1` | openfinanceuae.atlassian.net/wiki/spaces/standardsv2dot1final/pages/702421137 | `adapters/uae/open-finance/` follows it field for field: `Data/Links/Meta` envelope with `Links.Next` paging; consent `Status`, `Permissions`, `OpenFinanceBilling.Purpose` (`RiskAssessment`); Account `Status`, `Currency`, `AccountType`, `AccountSubType`, `IsShariaCompliant`; Balance `Type`, `CreditDebitIndicator`, `DateTime`, `Amount{Amount,Currency}` with Amount as a **string**; Transaction `TransactionType`, `SubTransactionType`, `Status`, `BookingDateTime`, `Flags[]` (incl. `Payroll`, `Finance`). `CurrencyExchange.ExchangeRate` is a number in the spec — the demonstration sends it and the adapter never reads it, so no float reaches the domain. |
| **UAE Pass** (authentication, signature) | **Published** | docs.uaepass.ae (attributes list; signature integration guide) | OIDC `/idshub/authorize` and `/idshub/userinfo` claims by assurance level (`userType` SOP1/2/3; `idn` only at SOP2/3); signer process `POST /trustedx-resources/esignsp/v2/signer_processes`, result `status` `finished|failed|failed_documents|canceled`. Enumerations of `userType`, `gender`, `idType`, the server-side envelope and the in-progress status are not published and are marked as assumptions. |
| **AECB** (bureau) | **Analogue** — no schema published | u.ae "financial credibility"; Emirates Islamic and Gulf News on the score | The common international credit-bureau report layout (report, subject, score with band and reason codes, contracts with type / role / status / limit / outstanding / overdue / days past due / monthly payment history, enquiries, public records with court cases and bounced cheques), carrying what AECB publishes: score **300–900**, higher = lower risk, individual and commercial reports. |
| **FTA** (TRN / VAT) | **Analogue** — CAPTCHA website tool only | tax.gov.ae; ec.europa.eu/taxation_customs/vies | The EU VIES VAT-validation answer (`isValid`, `requestDate`, `userError`, `name`, `address`, `requestIdentifier`) keyed by the 15-digit TRN as the FTA publishes it, plus `SUSPENDED` and `DEREGISTERED`. |
| **MoHRE / WPS** (payroll) | **Analogue** — none for lenders | Bank and exchange-house SIF file guides; Ministerial Resolution 340/2026 (85% paid = compliant) | The SIF records: SCR (employer id, salary month `MMYYYY`, EDR count, total salary, currency) and EDR (pay period, fixed and variable income, days on leave), in a JSON report per employee and per establishment; the 85%-paid rule computed in integers. Payroll evidence is also visible through Open Finance `Flags: Payroll`. |
| **ICP** (Emirates ID) | **Analogue** — contract-gated gateway | icp.gov.ae ICA Validation Gateway; docs.uaepass.ae attributes list | A match outcome, card status and reference, with subject attributes named as UAE Pass publishes them (`idn`, `fullnameEN`, `fullnameAR`, `nationalityEN`, `gender`, `idType`), since UAE Pass `idn` at SOP2/3 is the public route to a verified Emirates ID. |
| **NER** (trade licence) | **Analogue** — public search website only | u.ae National Economic Register; developer.company-information.service.gov.uk | The UK Companies House public API (company profile, officers, persons with significant control with `natures_of_control`) plus the NER's published facts: economic register number, issuing authority, licence expiry, ISIC4 activities. The status enumeration is not published. |
| **Partner bank** (payments) | **Analogue** — each bank's own API | iso20022.org | ISO 20022 pain.001-style instructions and pain.002 / pacs.002 status reports (`TxSts` `ACSC`/`ACCP`/`ACSP`/`PDNG`/`RJCT` with `StsRsnInf` reason codes; pacs.004-style return information). |

## Saudi Arabia

| Rail | Spec | Source | What the demonstration uses |
|---|---|---|---|
| **SAMA Open Banking** (AIS) | **Published** framework; a bank's faithful implementation | openbanking.sama.gov.sa; developer.alrajhibank.com.sa/open-banking/APIGuides (AIS 2022.11.01-final-errata2) | Consent statuses; `KSAOB.*` transaction types, statuses and `Flags` (`KSAOB.Payroll`, `KSAOB.Loan`); balances by `Type`. PIS schemas not retrieved — inferred only. |
| **ZATCA Fatoora** (e-invoice clearance) | **Published** portal, shape confirmed via third parties | qoyod.com sample responses | `validationResults{infoMessages,warningMessages,errorMessages,status: PASS|WARNING|ERROR}`, `clearanceStatus: CLEARED|NOT_CLEARED`, rule codes such as `BR-KSA-F-06`. Zakat certificate: web e-service only. |
| **Wathq** (commercial registration) | Third-party — portal public, spec behind login | developer.wathq.sa; noqta.tn summary of sandbox spec v6.7.0; Lean Technologies wrapper | Endpoints `/info`, `/fullinfo`, `/owners`, `/managers` and the published error codes (`400.1.x`, `404.2.1`); field names unconfirmed. Only status `id:1` "Active" is published. |
| **Nafath** (authentication) | Third-party | Azakaw wrapper; Laravel/Packagist integrations | `transId` + `random`; status `WAITING|COMPLETED|REJECTED|EXPIRED|ERROR`; signed JWT callback; 200-second transaction. Claim names unconfirmed. |
| **Yakeen** (identity) | None | elm.sa; SAMA rulebook (consent required) | Port vocabulary only. |
| **SIMAH** (bureau) | None — schemas after membership | — | Port vocabulary; **score range not public** (the 300–850 seen online is unreliable). Reporting format is a verification item. |
| **GOSI** (salary) | None — likely via Wathq "Employee Information (MASDR/GOSI)" | developer.wathq.sa | Port vocabulary only. |
| **SADAD** (collection) | None — biller onboarding | sadad.com FAQ | Process only. |

## How this is used

- **Published** rails are modelled field for field, so moving to the sandbox changes the
  transport and nothing else.
- **Third-party** rails follow the wrapper shape with each field marked unconfirmed in the
  adapter README.
- **Analogue** rails follow the named public standard. The adapter README names the standard
  with its URL and states plainly that the field names are not the provider's published
  specification and remain the verification item. A demonstration in an analogue shape shows
  what kind of record the provider returns, not its format.
- **None** rails answer in Sanad's port vocabulary.
- Every demonstration answer is labelled **Fixture** on screen and runs only where a synthetic
  demonstration is permitted (SR-005); production refuses it. The UAE demonstration's synthetic
  cast is `adapters/uae/demonstration/cast.ts`.
