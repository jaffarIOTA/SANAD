# `sme-term-islamic` — invariants

Each is enforced in code and attacked in `test/compliance/sme-products.test.ts`.

- **SI-1 Board ruling.** Not enabled for a tenant without that tenant's board ruling reference
  (`SH-18`, at the catalogue parser and so at the Admin screen).
- **SI-2 A price, not a rate, after the offer.** The rate fixes the deferred sale price at
  quotation; the contract carries the price.
- **SI-3 Ownership before sale, title before onward sale, proceeds before disbursement**, each
  attested strictly after its predecessor (`OP-CHAIN`).
- **SI-4 The lot bought is the cost quoted** (`SH-03`).
- **SI-5 Agency only where the board permits it** (`SH-18`).
- **SI-6 to SI-9** as the conventional module's S-2 to S-5: the regulator's size definition,
  business affordability before any offer, the institution's limits labelled as its own,
  sourced figures.
- **SI-10 No approval without** a commercial bureau enquiry, its consent, and the registry
  check of the enterprise and its signatories.
- **SI-11 One disbursement, one bureau report**, keyed on the transaction; the programme
  guarantee first where the term sheet requires it.
- **SI-12 APR is the platform's**, from the cash flows the module supplies.
