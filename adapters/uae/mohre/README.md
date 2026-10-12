# MOHRE — WPS salary report

**Port:** `core/ports/employment-verification.ts`. **Vault provider:** `MOHRE`. **Status:** `BLOCKED` — fixture transport only.

The Ministry of Human Resources and Emiratisation; the Wage Protection System.
A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-MOHRE-01** — what only a sandbox call can answer:

- the access route open to a lender (direct ministry service, a WPS agent
  bank's salary certificate, or a licensed intermediary) and the consent it
  requires — none is published for lenders today;
- the report shape (everything below is an assumed contract): how many months,
  paid versus contracted salary, and how allowances are separated;
- coverage of free-zone employers, which are outside the ministry's WPS;
- the employment status vocabulary;
- the exact article of the WPS compliance rule before a credit policy relies
  on it.

## Demonstration and assumed contract

The records are modelled on the **WPS Salary Information File (SIF)**, whose
layout the agent banks and exchange houses publish in their WPS guides: the
**SCR** (salary control record — employer id, salary month `MMYYYY`, EDR count,
total salary, currency) and the **EDR** (employee detail record — person id,
routing code, IBAN, pay start / end, days in period, fixed income, variable
income, days on leave). The JSON names and the report envelope are Sanad's
assumption:

```
POST /v1/wps/salary-reports         { applicantRef, consentRef }
→ { report: { reference, generated_at },
    employee: { employment_status: ACTIVE|ON_LEAVE|TERMINATED|CANCELLED|ABSCONDED,
                establishment_ref, contract_start_date, person_id, labour_card_number },
    salary_records: [{ scr: { salary_month, edr_count, total_salary, currency, employer_id },
                       edr: { fixed_income, variable_income, iban, … } }] }

POST /v1/wps/establishment-reports  { tradeLicenceNumber, consentRef }
→ { report, establishment: { establishment_ref, employer_id },
    salary_control_records: [{ salary_month, employees_due, edr_count, total_salary, currency }] }
```

**These field names are not MOHRE's published specification** (there is none
for lenders); they remain the verification item. The SIF record contents are
public; their JSON spelling is not. The demonstration answers cast employees
from the cast's WPS establishment (an owner who is not on the payroll is HTTP
404); a reference containing `unemployed` is terminated; a licence starting
`LATE-` paid 7 of 10 in its latest month.

## What is settled without the sandbox

- Consent-gated: no consent id, no call (`CONSENT_MISSING`), for both reports.
- The port's registered salary is the most recent SIF month's **fixed** income
  in AED minor units, stored with the report reference; variable income is
  left out because it does not recur. A month that cannot be read refuses the
  whole report rather than being skipped. How a tenant's affordability policy
  uses the figure is credit policy, not this adapter's.
- The establishment is mapped as an opaque reference; person id, labour card,
  routing code, IBAN and employer id are dropped.
- `establishmentCompliance()` (adapter method, not on the port) judges each
  month against the rule that an establishment has paid at least 85% of its
  employees due (Ministerial Resolution 340/2026, as recorded in
  `docs/rails/public-structures.md`), in integers: `paid × 100 ≥ due × 85`.
