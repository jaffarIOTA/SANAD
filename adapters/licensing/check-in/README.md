# Licence check-in — the issuer's licensing server

**Port:** `core/ports/licence-check-in.ts`. **Status:** `BLOCKED` — fixture transport only
(`fixture.ts`). The issuer's server (`licensing.iotatechnologies.io`, ADR 0006 §3) does not
exist yet, so there is no live transport.

A fixture transport is not an integration. This adapter becomes `LIVE` when a live transport
(`adapters/kernel/http-transport.ts`, through the institution's egress, where the institution
permits outbound traffic at all) has checked in against the issuer's server and the findings
are written here.

## Verification item

LIC-CHECKIN-01 — the server's endpoint, its authentication of the installation, the answer
envelope (a list of signed files, each `{"licence":…,"signature":…}` or
`{"revocation":…,"signature":…}`), and its behaviour when there is nothing new.

## What is settled without the server

- **The payload is four fields** — `licenceId`, `installationId`, `productVersion`, `state` —
  and the request type is closed. No customer, applicant, transaction or staff data.
- **The transport is trusted for nothing.** Every file returned is verified against the
  compiled-in keyring (`core/licensing/keys.ts`) exactly as an uploaded file is
  (`core/licensing/check-in.ts`). A file that does not verify is refused and reported.
- **A failed check-in changes nothing.** The offline licence governs; network trouble never
  stops an institution.
- **A revocation starts the grace period**, never an immediate stop.

## Credentials

None yet. When the live transport is built, any installation credential is stored via
`config.set_integration_credential()` and read server-side; never logged.
