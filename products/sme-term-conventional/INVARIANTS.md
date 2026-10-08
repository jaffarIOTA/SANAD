# `sme-term-conventional` — invariants

Each is enforced in code and attacked in `test/compliance/sme-products.test.ts`.

- **S-1 Sourced rate.** No quote without a rate the engine resolved from the tenant's
  catalogue rule (`PLAT-03`). The module never invents or defaults a rate.
- **S-2 Regulator's size definition.** The enterprise is classified by the definition the
  engine supplies from configuration; revenue decides, employees only without revenue
  history; an enterprise that cannot be classified is refused, never guessed.
- **S-3 Business affordability before any offer.** Size eligibility, debt-service cover and
  the revenue share are checked at quotation. A failure is an `OP-LIMIT` refusal naming the
  policy reference.
- **S-4 The institution's limits say they are the institution's.** A credit rule without
  `source: TENANT_CREDIT_POLICY` and a policy reference does not parse.
- **S-5 Sourced figures.** Business figures carry the reference of the statements or rail they
  came from; unsourced figures are refused.
- **S-6 No approval without** a commercial bureau enquiry, its consent, and the registry check
  of the enterprise and its signatories.
- **S-7 One disbursement, one bureau report**, both outbox events keyed on the transaction.
- **S-8 Guarantee first, where required.** If the term sheet requires the programme guarantee
  before disbursement, no disbursement without its reference.
- **S-9 APR is the platform's.** The module supplies the cash flows; `core/pricing/apr.ts`
  computes the APR.
