# UAE integration rails

ADR 0005 made Sanad serve both Saudi Arabia (SAR) and the UAE (AED). These are
the UAE rails, built to the same anatomy as `adapters/ksa/`: a capability-named
port in `core/ports/`, a fixture transport for tests, the shared rail kernel
(`adapters/kernel/rail-adapter.ts`, which currently re-exports the Saudi
implementation), a circuit breaker, credentials from the vault, and a README
naming the verification item.

| Rail | Directory | Port | Vault provider code | Assumed contract modelled on | Status |
|---|---|---|---|---|---|
| Al Etihad Credit Bureau | `aecb/` | `credit-bureau` | `AECB` | common international bureau report layout; AECB's published 300–900 score | BLOCKED |
| UAE Pass | `uae-pass/` | `identity-authentication` | `UAE_PASS` | docs.uaepass.ae (OIDC claims, signer processes) — published | BLOCKED |
| Emirates ID (ICP) | `icp/` | `identity-verification` | `ICP` | UAE Pass published userinfo attribute names | BLOCKED |
| National Economic Register | `ner/` | `business-registry` | `NER` | UK Companies House public API, plus NER's published fields | BLOCKED |
| MOHRE WPS salary report | `mohre/` | `employment-verification` | `MOHRE` | WPS Salary Information File (SCR / EDR records) | BLOCKED |
| Federal Tax Authority | `fta/` | `tax-compliance` | `FTA` | EU VIES VAT validation | BLOCKED |
| Partner bank | `partner-bank/` | `payments` | `PARTNER_BANK` | ISO 20022 pain.001 / pain.002 / pacs.002 | BLOCKED |
| UAE Open Finance | `open-finance/` | `account-information` | — (needs a migration) | CBUAE Open Finance v2.1 Account Information — published | BLOCKED |

All eight are on fixture transports. **A fixture transport is not an
integration**: each stays `BLOCKED` until its live transport has made a
verified sandbox call and its README records what was learned. Only UAE Pass
and Open Finance publish their contracts; every other rail's field names are
an analogue of the named public standard, chosen so a synthetic demonstration
is realistic, and remain that rail's verification item.

## The demonstration

`demonstration/transport.ts` answers every operation of every UAE adapter in
its assumed contract, from a fixed synthetic cast (`demonstration/cast.ts`:
three companies with their owners, managers, bureau files, WPS records and
twelve months of bank statements) or by documented steering prefixes. It runs
only where a synthetic demonstration is permitted (SR-005), and every answer is
labelled FIXTURE. Tests: `test/adapters/uae-demonstration.test.ts`.

## What is shared across the UAE rails

- **Dirhams at the boundary.** `kernel/dirham.ts` turns every vendor amount
  into a `Money` in AED minor units (fils) by digit manipulation. A fractional
  JSON number is refused, not converted; an answer stating another currency is
  malformed. Instructions and bureau reports the platform sends must be in AED
  or are refused with `CURRENCY_MISMATCH`.
- **Unknown vocabulary fails closed.** `kernel/vocabulary.ts` maps a rail's
  status codes by own keys only; an unknown status is `UNAVAILABLE`
  (`response malformed`), never the favourable value.
- **Consent first.** AECB, ICP, MOHRE and Open Finance refuse before any call
  when no consent id is supplied (`CONSENT_MISSING`).
- **ISO 8601 times.** `kernel/iso-time.ts` reads the standards' date-times
  strictly (a zone is required; an impossible date is malformed).
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
