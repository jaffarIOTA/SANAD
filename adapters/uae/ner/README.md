# NER — National Economic Register

**Port:** `core/ports/business-registry.ts`. **Vault provider:** `NER`. **Status:** `BLOCKED` — fixture transport only.

A fixture transport is not an integration. This adapter becomes `LIVE` when its
live transport has made a verified sandbox call and the findings are written
here.

## Verification item

**UAE-RAIL-NER-01** — what only a sandbox call can answer:

- whether the register offers an API to a lender at all, and its real field
  names (everything below is an assumed contract — see the next section);
- whether a lookup needs the issuing authority (each emirate's economic
  department, each free zone) beside the licence number, and the licence number
  formats per authority;
- coverage of free-zone licences in the register;
- the licence status vocabulary (the adapter maps the Companies House values
  plus expired, suspended, frozen, cancelled, revoked; anything else is
  malformed);
- the legal-form vocabulary, and whether activities are always ISIC4;
- whether share capital is returned, and in which currency;
- how owners and managers are referenced, and whether lists paginate.

## Demonstration and assumed contract

The register publishes no API specification (u.ae lists only its public search
website). The assumed contract is modelled on the **UK Companies House public
data API** — <https://developer.company-information.service.gov.uk/> — whose
company profile, officers and persons-with-significant-control resources are a
published, widely used register shape:

| Read | Path | Fields read |
|---|---|---|
| Profile | `GET /company/{licence}` | `company_name`, `company_number` (must echo the licence), `company_status`, `type`, `date_of_creation`, `etag` (lookup reference), plus the NER's own published facts as `company_name_ar`, `licence_expiry_date`, `isic4_activities[].code`, `share_capital{amount,currency}`. `economic_register_number`, `issuing_authority` and `registered_office_address` are received and dropped (the port has no field). |
| Officers | `GET /company/{licence}/officers` | `items[].links.officer.appointments` (the reference), `resigned_on`, `total_results`; names, nationality, identification dropped |
| Controllers | `GET /company/{licence}/persons-with-significant-control` | `items[].links.self` (the reference), `ceased_on`, `total_results`; `natures_of_control`, names, dates of birth dropped |

**These field names are not the register's published specification.** They are
an analogue chosen so a demonstration looks like a real register, and they stay
the verification item until a sandbox call replaces them. The demonstration
transport (`../demonstration/transport.ts`) answers in this shape from the
synthetic cast (`../demonstration/cast.ts`) or by its steering prefixes
(`UNK-`, `EXP-`, `SUS-`).

## What is settled without the sandbox

- The trade licence number travels in the port's `commercialRegistration`
  field (naming debt, ADR 0005). The adapter checks shape only: 3–30 letters,
  digits, hyphens or slashes.
- An unknown licence (HTTP 404) is `REFUSED` with `NOT_FOUND`.
- An "active" licence whose expiry date is before the retrieval is `EXPIRED`.
- Officers' and controllers' identifiers and attributes are dropped at this
  boundary; they become opaque signatory references. A resigned officer or a
  ceased controller is not a signatory. An entry without a reference, or a
  truncated list, refuses the lookup.
- Share capital becomes AED minor units without a float; capital in another
  currency is left out rather than relabelled.
- Ownership percentages (`natures_of_control`), the economic register number
  and the issuing authority do not cross: the port has no field for them
  (`NER-DEV-004`).
