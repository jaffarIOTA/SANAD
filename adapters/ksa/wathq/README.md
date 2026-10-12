# Wathq — business registry

**Port:** `core/ports/business-registry.ts`. **Status:** `BLOCKED` — fixture transport only.

## Verification item

KSA-RAIL-WATHQ-01 — the subscription scope (which CR attributes are returned), the
status vocabulary, and the rate limits. Also the decision to split the port into
`business-registry` and `counterparty-master` (WATHQ-DEV-001).

## Demonstration and assumed contract

**Source: third-party** — the portal is public (`https://developer.wathq.sa`), the
specification is behind login. The shape follows a third-party summary of the sandbox
specification v6.7.0 (noqta.tn) and the Lean Technologies wrapper. Row "Wathq" in
`docs/rails/public-structures.md`.

Endpoints under `/v5/commercialregistration`: `/info/{id}`, `/fullinfo/{id}`,
`/owners/{id}`, `/managers/{id}`. The adapter calls **`/fullinfo/{id}`** with the ten-digit
CR number or CR national number (700…) and reads:

| Field | Use |
|---|---|
| `crNationalNumber`, `crNumber` | the answer must be about the number asked |
| `name`, `nameEn` | legal name; an English name is optional on a Saudi CR, so the Arabic name stands in |
| `status{id, name}` | own-key lookup in `WATHQ_STATUS` |
| `entityType{id, name, formId, formName}` | legal form (`formName`, else `name`) |
| `activities[]{id, name}` | activity codes (ISIC-based); one without an `id` refuses the record |
| `parties[]`, `management.managers[]` | identities **dropped**; each manager becomes `wathq:{crNationalNumber}:manager:{n}` |
| `capital.stockCapital.paidAmount`, `issueDateGregorian` | optional; decimal → minor units |

**Published errors:** `400.1.1`–`400.1.7` (request validation) and `404.2.1` (not found);
the live transport surfaces the HTTP status only, and a 404 is `REFUSED NOT_FOUND`.

**Status ids.** Only `1` "Active" (نشط) is published. These are this adapter's
**assumptions**, to be confirmed: `2` Suspended (موقوف) → `SUSPENDED`, `3` Struck off /
cancelled (مشطوب) → `CANCELLED`, `4` Expired → `EXPIRED`. Any other id — including an
inherited object key such as `constructor`, which a plain index once resolved to
`Object.prototype.constructor` — is `UNAVAILABLE`.

**Unconfirmed, and the verification item:** every field name above, the status ids
beyond 1, and whether the lookup accepts both numbers.

The demonstration transport answers the three cast companies; a CR ending `9999` is struck
off, `8888` suspended, `0000` not on the register.

## What is settled without the sandbox

- A ten-digit CR is required before any call; a 404 is "unknown", not an error.
- Party and manager national identifiers are dropped at the boundary (WATHQ-DEV-002).
- `get()` and `beginOnboarding()` are typed refusals, not silent no-ops.
