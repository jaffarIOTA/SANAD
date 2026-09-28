# ZATCA — e-invoicing (FATOORA)

**Port:** `core/ports/e-invoicing.ts`. **Status:** `BLOCKED` — fixture transport only.

## Verification item

KSA-RAIL-ZATCA-01 — the integration path an institution uses to *read* another
taxpayer's cleared invoice (the platform is the financier, not the issuer): whether
that is the authority's API under the institution's own onboarding, or the anchor's
own e-invoicing solution exposing cleared invoices. The response fields mapped here
(`clearanceStatus`, `stampValid`, `sellerCr`, `buyerCr`, `lines[].classificationCode`)
are placeholders until then.

## What is settled without the sandbox

- Fail closed: anything other than a literal `CLEARED`/`REPORTED` maps to `REJECTED`
  or `NOT_FOUND`; an unavailable authority refuses the drawdown.
- Amounts by digit manipulation, never through a float; one unparseable line refuses
  the whole invoice.
- The financed-invoice registry (SH-10) is the platform's own; this adapter never
  decides whether an invoice was already financed.
