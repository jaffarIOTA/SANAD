# ICP — Emirates ID verification

**Port:** `core/ports/identity-verification.ts`. **Vault provider:** `ICP`. **Status:** `BLOCKED` — fixture transport only.

The Federal Authority for Identity, Citizenship, Customs & Port Security.
A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-ICP-01** — what only a sandbox call can answer:

- the access route available to the institution (direct ICP integration, the
  card-reader / NFC verification toolkit, or a licensed intermediary) and which
  of them returns a register match rather than only a card read;
- the card status vocabulary (valid, expired, cancelled, lost) and its codes;
- which attributes can be matched and how a mismatch is reported;
- the consent artefact the authority expects and its reference format.

## What is settled without the sandbox

- Consent-gated: no consent id, no call (`CONSENT_MISSING`).
- The verification is true only when the attributes match **and** the card is
  valid; an invalid card adds the mismatch `card_status`; an unknown card
  status is malformed, never valid.
- Attribute values (name, nationality, date of birth, card expiry) are dropped
  at this boundary; only the result, mismatched field names and the reference
  are stored.
