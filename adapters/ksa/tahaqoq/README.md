# Tahaqoq — national document verification

**Port:** `core/ports/document-verification.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-TAHAQOQ-01 — the exact service scope: document classes, issuers, and the identifier each is verified by. The document-type table is provisional until then.

## Where it is used

Document intelligence D3 (`docs/DOCUMENT-INTELLIGENCE-PLAN.md`). A Saudi business application asks it about each
uploaded document whose checklist item declares `AUTHENTIC`, under the `DOCUMENT_VERIFICATION` consent the business
gave at intake (`apps/ops/src/server/business-rails.ts`, `documentAuthenticity`). The answer is a finding for the
checker. It accepts and refuses nothing.

**To learn in the sandbox:** what identifies a document to the service: a QR code, a document number, or the CR
for a CR extract. Today `documentRef` is Sanad's own reference (`obj:<application>/<hash>`), which only the
demonstration transport understands. The port takes a reference so that no identifier crosses it by value; the
answer decides whether the adapter reads the document's identifier from the stored file or from the registry
result.

## What is settled without the sandbox

- The port shape and outcomes (`ANSWERED` / `REFUSED` / `UNAVAILABLE`), tested in
  `test/adapters/ksa-rails.test.ts`.
- Consent gating where the rail is consent-gated: the adapter refuses before any
  call is made when no consent id is supplied.
- No personal identifier by value crosses the port; vendor decimals become minor
  units by digit manipulation, never through a float.
- Known deviations are declared in `adapter.ts` with their containment.

## Credentials

Stored via `config.set_integration_credential()` under the provider name in
migration 0007; read server-side at adapter construction; never logged.
