









import { discloseSmeConventional } from './disclosure.js';
import { open } from './execution.js';
import { quoteSmeConventional } from './pricing.js';
import { parseSmeConventionalTerms } from './terms.js';

export const smeTermConventional = {
  descriptor: {
    code: 'sme-term-conventional',
    nameEn: 'SME term finance',
    nameAr: 'تمويل المنشآت لأجل',
    journeyShape: 'AMOUNT_FIRST',
    family: 'CONVENTIONAL',
    consumer: false,
    requiresBoardRuling: false,
    bookingShape: 'CORE_FACILITY',
  },
  validateTerms: parseSmeConventionalTerms,
  quote: quoteSmeConventional,
  disclose: discloseSmeConventional,
  execute(terms, approved, quote, context) {
    return open(terms, approved.core.tenantId, quote, context);
  },
};
