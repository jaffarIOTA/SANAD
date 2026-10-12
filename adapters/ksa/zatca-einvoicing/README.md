# ZATCA — e-invoicing (FATOORA)

**Port:** `core/ports/e-invoicing.ts`. **Status:** `BLOCKED` — fixture transport only.

## Verification item

KSA-RAIL-ZATCA-01 — the integration path an institution uses to *read* another
taxpayer's cleared invoice (the platform is the financier, not the issuer): whether
that is the authority's API under the institution's own onboarding, or the anchor's
own e-invoicing solution exposing cleared invoices. The `invoice` block mapped here is a
placeholder until then; the outcome fields are the published ones.

## Demonstration and assumed contract

**Source: published** — the Fatoora clearance / reporting response
(`https://zatca.gov.sa/en/E-Invoicing`, developer portal and sandbox), confirmed through
third-party sample responses (qoyod.com). Row "ZATCA Fatoora" in
`docs/rails/public-structures.md`.

Published, and mapped exactly (`clearanceOutcome()`):

- `validationResults{infoMessages[], warningMessages[], errorMessages[], status: PASS |
  WARNING | ERROR}`, each message `{type, code, category, message, status}` with rule codes
  such as `BR-KSA-F-06` (`ruleCodes()` lists them for the audit trail);
- `clearanceStatus: CLEARED | NOT_CLEARED` (standard invoices) and `reportingStatus:
  REPORTED | NOT_REPORTED` (simplified invoices).

Only `CLEARED` (or `REPORTED`) under `PASS` or `WARNING` with no error message validates;
`ERROR`, any error message, `NOT_CLEARED`, `NOT_REPORTED` or an unknown value is `REJECTED`.

**Assumed (no public read API):** the lookup path `GET /v1/invoices/{uuid}?hash=…`, and the
`invoice` block — content decoded from the cleared UBL document, named after the UBL
elements: `issueDate`, `seller.crNumber` / `buyer.crNumber` (PartyIdentification
`schemeID=CRN`), `taxInclusiveAmount` (LegalMonetaryTotal), `invoiceLines[]{id,
lineExtensionAmount, itemName, itemNameAr, itemClassificationCode, invoicedQuantity,
unitCode}`, and `qrCode`. The trade-history call has no public analogue and speaks Sanad's
vocabulary.

The demonstration answers `CLEARED` with the `XSD_ZATCA_VALID` info message; a hash
containing `reject` is `NOT_CLEARED` with `BR-KSA-F-06`, `simplified` is `REPORTED`,
`unknown` is 404. It produces no QR stamp, so the stamp is never valid in a demonstration.

## The stamp is verified, not read (SR-016)

`stampValid` is computed by `stamp.ts` from the invoice's QR code: its hash (tag 6) must be
the hash asked about, its signer (tag 8) one of the authority keys the institution pins
(`ZatcaStampTrust`, from configuration), and its signature (tag 7) must verify. A response
flag saying the stamp is valid is ignored. No pinned key: no stamp is valid. The sandbox
confirms the tag layout on the read path and the stamping certificate (ZATCA-EINV-DEV-003).
Where the authority's endpoint requires mutual TLS, the adapter takes
`adapters/kernel/mutual-tls-transport.ts` as its transport.

## What is settled without the sandbox

- Fail closed: anything other than a literal `CLEARED`/`REPORTED` under a passing
  validation maps to `REJECTED` or `NOT_FOUND`; an unavailable authority refuses the drawdown.
- Amounts by digit manipulation, never through a float; one unparseable line refuses
  the whole invoice.
- The financed-invoice registry (SH-10) is the platform's own; this adapter never
  decides whether an invoice was already financed.
