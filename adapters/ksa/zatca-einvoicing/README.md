# ZATCA — e-invoicing (FATOORA)

**Port:** `core/ports/e-invoicing.ts`. **Status:** `BLOCKED` — fixture transport only.

## Verification item

KSA-RAIL-ZATCA-01 — the integration path an institution uses to *read* another
taxpayer's cleared invoice (the platform is the financier, not the issuer): whether
that is the authority's API under the institution's own onboarding, or the anchor's
own e-invoicing solution exposing cleared invoices. The response fields mapped here
(`clearanceStatus`, `qrCode`, `sellerCr`, `buyerCr`, `lines[].classificationCode`)
are placeholders until then.

## The stamp is verified, not read (SR-016)

`stampValid` is computed by `stamp.ts` from the invoice's QR code: its hash (tag 6) must be
the hash asked about, its signer (tag 8) one of the authority keys the institution pins
(`ZatcaStampTrust`, from configuration), and its signature (tag 7) must verify. A response
flag saying the stamp is valid is ignored. No pinned key: no stamp is valid. The sandbox
confirms the tag layout on the read path and the stamping certificate (ZATCA-EINV-DEV-003).
Where the authority's endpoint requires mutual TLS, the adapter takes
`adapters/kernel/mutual-tls-transport.ts` as its transport.

## What is settled without the sandbox

- Fail closed: anything other than a literal `CLEARED`/`REPORTED` maps to `REJECTED`
  or `NOT_FOUND`; an unavailable authority refuses the drawdown.
- Amounts by digit manipulation, never through a float; one unparseable line refuses
  the whole invoice.
- The financed-invoice registry (SH-10) is the platform's own; this adapter never
  decides whether an invoice was already financed.
