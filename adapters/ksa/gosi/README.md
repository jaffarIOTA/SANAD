# GOSI — employment and registered salary

**Port:** `core/ports/employment-verification.ts`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport (`adapters/kernel/http-transport.ts`, through the institution's
egress) has made a verified sandbox call and the findings are written here.

## Verification item

KSA-RAIL-GOSI-01 — the consent artefact the service requires, and whether salary is returned as a figure or a band.

## Demonstration and assumed contract

**Source: none published for lenders.** The shape is modelled on the contents of the public
GOSI wage (salary) certificate e-service (`https://www.gosi.gov.sa`): the certificate
number, and per employment the employer establishment (number and name), the joining date,
the registered wage (basic wage, housing allowance, other allowances, total) and the
employment status. The **likely live route** is Wathq's "Employee Information (MASDR/GOSI)"
service (`https://developer.wathq.sa`), not a direct GOSI connection. Row "GOSI" in
`docs/rails/public-structures.md`.

What the adapter now speaks: `POST /gosi/v1/wage-certificates` with `{applicantRef,
consentRef}`, answered by `{certificateNumber, issueDate, contributor{…}, employments[]
{establishmentNumber, establishmentName, joiningDate, employmentStatus, wage{currency,
basicWage, housingAllowance, otherAllowances, totalWage}}}`.

- `contributor` is dropped. The primary employment is the `ACTIVE` one with the highest
  wage; `employerRef` is `gosi-establishment:{establishmentNumber}`; the registered salary is
  `totalWage`, or basic + housing + other where no total is given; `employedSince` is the
  joining date. No active employment is `employed: false`.
- One employment that does not read (unknown status, a decimal that does not parse, another
  currency) refuses the certificate. A 404 is `REFUSED NOT_FOUND`.

**Unconfirmed, and the verification item:** the route (Wathq vs. GOSI), every field name,
the employment status vocabulary, and whether the wage is a figure or a band.

The demonstration answers each cast person (their registered wage equals the payroll
credit their bank shows); `unemployed` and `unknown` steer the failures.

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
