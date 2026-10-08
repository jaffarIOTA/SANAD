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

Variants (attacked in `test/compliance/sme-variants.test.ts`):

- **S-10 One currency per term sheet.** A request in another currency is refused.
- **S-11 The variant governs.** No quote without a known variant; the amount, tenor, grace,
  owner contribution, years in operation and purpose are each checked against it and refused
  with a typed reason when outside. A variant only narrows: the module's minimum, credit rule
  and guarantee still apply.
- **S-12 Dated, never defaulted.** The schedule is the dated ACT/365 schedule; the disbursement
  and first due dates come from the request, and a quote without them is refused.
- **S-13 Illustrative says so.** A variant value not taken from the institution's product paper
  is named in the variant's `note`.
- **S-14 One variant code, two copies.** `variants.ts` here and in `sme-term-islamic/` are
  identical below their header comments; the test compares them.
