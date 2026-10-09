# ADR 0006 — Installation licensing: annual licences, monthly POC licences

**Status:** Proposed
**Date:** 2026-10-09
**Decided by:** the product owner (enforcement model and expiry behaviour, 2026-10-09)
**Related:** `docs/AZURE-DEPLOYMENT-PLAN.md`, ADR 0005 (one deployment, one jurisdiction)

## Context

Sanad has no licensing. Every installation, hosted by IOTA or installed by an institution, must
be licensed:

- **Annual licence**: the normal commercial term, renewed yearly.
- **POC licence**: one month at a time, extended a month at a time on the institution's request.

Many institution installs are in-Kingdom and have no outbound internet, so the licence must work
offline.

## Decision

### 1. A licence is a signed file, verified offline

IOTA issues a licence as a JSON document with a detached signature. The product verifies it
against IOTA public keys compiled into the build. No call home is needed to run.

```
Licence {
  licenceId          uuid
  kind               'ANNUAL' | 'POC'
  licensee           the institution's legal name, as data (never in core/ or products/)
  installationId     uuid of the one installation it is bound to
  jurisdictions      ('SA' | 'AE')[]
  products           product module codes entitled, e.g. ['bnpl', 'sme-term-conventional']
  maxActiveTenants   integer
  notBefore          date
  notAfter           date
  graceDays          30 for ANNUAL, 7 for POC
  supersedes         licenceId of the licence this one replaces, or null
  issuedAt, issuedBy, keyId
}
```

- **Signature: ECDSA P-256 (ES256).** The IOTA signing key lives in Azure Key Vault managed
  HSM and never leaves it. Key Vault does not offer Ed25519, which is why P-256. `keyId`
  selects the public key, so keys rotate without invalidating issued licences.
- **Bound to one installation.** Each installation generates an `installationId` on first start
  and stores it in its deployment profile. A licence naming another installation is refused.
- **Term limits are checked at verification, not only at issue.** ANNUAL: at most 12 months +
  1 day. POC: at most 1 calendar month. A POC file longer than a month is refused even if signed.

### 2. POC extension

An extension is a **new POC licence** with `supersedes` set to the previous one. Its
`notBefore` is the previous `notAfter`, and its term is one month. The institution requests it
from Admin → Licence, which produces a request file (installation, current licence,
jurisdiction, version; no customer data). IOTA approves and issues. Every extension stays in
the installation's licence history, so the POC's full length is always visible. Converting a
POC to production is the issue of an ANNUAL licence that supersedes the last POC.

### 3. Optional online check-in

Where the institution allows outbound traffic, the installation checks in daily with
`licensing.iotatechnologies.io`. It sends only `licenceId`, `installationId`, product version
and licence state, with no customer, applicant or transaction data. The response may carry a
newer signed licence (a renewal picked up automatically) or a signed revocation.

- **A failed check-in changes nothing.** The offline file governs. Network trouble never stops
  an institution.
- **Revocation only by signed message**, and it takes effect as the start of the grace period,
  never as an immediate stop.

### 4. States and what each one blocks

| State | When | Effect |
|---|---|---|
| `VALID` | inside `notBefore`..`notAfter` | Nothing blocked |
| `EXPIRING` | 60, 30 and 7 days before `notAfter` (POC: 7 and 3 days) | Banner in Admin and ops; daily notification to the institution's administrators |
| `GRACE` | `notAfter` + up to `graceDays` | Nothing blocked; banner on every staff screen |
| `NEW_BUSINESS_BLOCKED` | after grace, or no licence, or an invalid one | **New business refused** (below) |

**Refused in `NEW_BUSINESS_BLOCKED`, as the typed outcome `LICENCE_NOT_ACTIVE`:**
- starting an application, by any channel (branch, digital, partner API, checkout, hand-over API)
- a quote or a new offer
- booking a facility whose offer was accepted after grace ended
- a product module or jurisdiction the licence does not name, or a tenant beyond
  `maxActiveTenants` (these are refused in every state)

**Never refused, in any state:**
- servicing, collections, repayments and early settlement of existing contracts
- booking an offer the customer accepted **before** grace ended. Stopping it would harm a
  customer who has already committed
- bureau reporting and every other regulatory duty
- audit, exports and regulator access
- sign-in, and installing a new licence

A bank must always be able to collect what it is owed and answer its regulator. A licence
dispute is IOTA's dispute with the institution, never with the institution's customers.

### 5. Where it lives

- `core/licensing/`: licence type, signature verification, the state function and the one
  gate `assertNewBusinessPermitted()`. The engine calls the gate at each entry point above.
  Like `core/pricing/apr.ts`, nothing else decides licence state.
- `config.licence`: append-only history of installed licences. Installing one is an Admin act
  under four eyes, like the jurisdiction, and writes a chained audit event.
- **Clock tampering.** The highest server time seen is stored. A clock behind it by more than
  a day is treated as `NEW_BUSINESS_BLOCKED` until corrected.
- **Admin → Licence**: state, entitlements, days remaining, history, request file, install.
- `apps/ops/src/server/modules.ts` gains a Licensing entry.
- **The issuer is not in this repository.** It is IOTA-internal tooling in a private
  repository, because it is never shipped to institutions.

## Consequences

- Compliance tests: an expired licence refuses a new application but accepts a repayment. A
  tampered signature, a licence for another installation, and a 40-day POC are each refused.
  A product outside the licence cannot be quoted. A clock rollback is detected.
- Licence enforcement in **public** source can be removed by anyone who builds from it. The
  technical control deters casual misuse and makes use visible; the contract enforces it.
  SR-040 (repository visibility) should be decided before licensing ships.
- The hosted environment (`sanad.iotatechnologies.io`) is licensed like any installation, so
  IOTA's own hosting proves the mechanism.

## Open questions for the product owner

1. ~~Is there a cap on POC extensions?~~ **Decided 2026-10-09: no cap.** Each extension is
   one month, issued on request; the supersession history keeps the POC's full length visible.
2. Should the licence limit anything beyond products, jurisdictions and tenants, such as staff
   users or applications per month? Each limit added is something an institution can hit in
   the middle of its business.
