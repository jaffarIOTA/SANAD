# UAE integration rails

ADR 0005 made Sanad serve both Saudi Arabia (SAR) and the UAE (AED). These are
the UAE rails, built to the same anatomy as `adapters/ksa/`: a capability-named
port in `core/ports/`, a fixture transport for tests, the shared rail kernel
(`adapters/kernel/rail-adapter.ts`, which currently re-exports the Saudi
implementation), a circuit breaker, credentials from the vault, and a README
naming the verification item.

| Rail | Directory | Port | Vault provider code | Status |
|---|---|---|---|---|
| Al Etihad Credit Bureau | `aecb/` | `credit-bureau` | `AECB` | BLOCKED |
| UAE Pass | `uae-pass/` | `identity-authentication` | `UAE_PASS` | BLOCKED |
| Emirates ID (ICP) | `icp/` | `identity-verification` | `ICP` | BLOCKED |
| National Economic Register | `ner/` | `business-registry` | `NER` | BLOCKED |
| MOHRE WPS salary report | `mohre/` | `employment-verification` | `MOHRE` | BLOCKED |
| Federal Tax Authority | `fta/` | `tax-compliance` | `FTA` | BLOCKED |
| Partner bank | `partner-bank/` | `payments` | `PARTNER_BANK` | BLOCKED |

All seven are on fixture transports. **A fixture transport is not an
integration**: each stays `BLOCKED` until its live transport has made a
verified sandbox call and its README records what was learned.

## What is shared across the UAE rails

- **Dirhams at the boundary.** `kernel/dirham.ts` turns every vendor amount
  into a `Money` in AED minor units (fils) by digit manipulation. A fractional
  JSON number is refused, not converted; an answer stating another currency is
  malformed. Instructions and bureau reports the platform sends must be in AED
  or are refused with `CURRENCY_MISMATCH`.
- **Unknown vocabulary fails closed.** `kernel/vocabulary.ts` maps a rail's
  status codes by own keys only; an unknown status is `UNAVAILABLE`
  (`response malformed`), never the favourable value.
- **Consent first.** AECB, ICP and MOHRE refuse before any call when no consent
  id is supplied (`CONSENT_MISSING`).
- **Saudi-named port fields.** `BureauRequest.commercialRegistration`,
  `BusinessRegistryPort.lookup({ commercialRegistration })` and
  `TaxCompliancePort.certificateStatus({ crNumber })` carry the UAE trade
  licence number (or, for FTA, the TRN). The ports are not renamed; the naming
  debt is recorded against ADR 0005.

## Credentials

Stored via `config.set_integration_credential()` under the provider codes in
migration 0015. A UAE tenant's capability resolves to its configured adapter's
code through `vaultProviderResolverFromRails` in
`adapters/kernel/credentials-vault.ts`; never logged.

Tests: `test/adapters/uae-rails.test.ts`.
