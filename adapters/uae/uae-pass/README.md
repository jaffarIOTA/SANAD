# UAE Pass — identity authentication

**Port:** `core/ports/identity-authentication.ts`. **Vault provider:** `UAE_PASS`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox (staging) call and the findings are
written here.

## Verification item

**UAE-RAIL-UAEPASS-01** — what only a sandbox call can answer:

- the institution's onboarding as a UAE Pass service provider (client id,
  redirect URIs, scopes) and whether the flow is redirect or app-to-app push
  for a server-initiated step-up;
- the assurance levels returned and which of them count as a verified identity
  (the adapter treats `SOP1` as basic and `SOP2`/`SOP3` as verified until this
  is confirmed);
- the digital-signing flow: whether the signing intent is a separate service
  (document signing) or an authentication with a signing scope, and what
  evidence it returns for the signature record;
- the transaction expiry window.

## What is settled without the sandbox

- Purposes map to flows: `LOGIN`, `STEP_UP`, `SIGNATURE_INTENT`.
- A step-up or signing intent completed on a basic (unverified) account is
  `REFUSED` with `ASSURANCE_INSUFFICIENT`; an unknown assurance level is
  malformed, never verified.
- The Emirates ID, name, mobile and email returned by the service are dropped
  at this boundary; only the assertion id, an opaque subject reference and the
  time cross the port.
- Unreachable service → `UNAVAILABLE`, which approves nothing.
