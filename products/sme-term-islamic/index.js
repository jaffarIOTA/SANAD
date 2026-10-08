 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }











import { discloseSmeIslamic } from './disclosure.js';
import { open } from './execution.js';
import { quoteSmeIslamic } from './pricing.js';
import { parseSmeIslamicTerms } from './terms.js';












export const smeTermIslamic = {
  descriptor: {
    code: 'sme-term-islamic',
    nameEn: 'SME finance (Tawarruq)',
    nameAr: 'تمويل المنشآت (تورّق)',
    journeyShape: 'AMOUNT_FIRST',
    family: 'ISLAMIC',
    consumer: false,
    requiresBoardRuling: true,
    bookingShape: 'CORE_FACILITY',
  },
  validateTerms: parseSmeIslamicTerms,
  quote: quoteSmeIslamic,
  disclose: discloseSmeIslamic,
  execute(terms, approved, quote, context) {
    return open({
      transactionId: context.transactionId,
      tenantId: approved.core.tenantId,
      applicantRef: context.applicantRef,
      quote,
      brokerRef: terms.brokerRef,
      agency: { permitted: terms.agencyPermitted, ...(context.agencyRef === undefined ? {} : { agencyRef: context.agencyRef }) },
      bureauEnquiryRef: context.bureauEnquiryRef,
      consentId: context.consentId,
      businessRegistryRef: context.businessRegistryRef,
      guaranteeRequired: _optionalChain([terms, 'access', _ => _.guarantee, 'optionalAccess', _2 => _2.requiredBeforeDisbursement]) === true,
      correlationId: context.correlationId,
      openedAt: context.openedAt,
    });
  },
};
