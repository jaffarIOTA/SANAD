










import { discloseTawarruq } from './disclosure.js';
import { open } from './execution.js';
import { quoteTawarruq } from './pricing.js';
import { parseTawarruqTerms } from './terms.js';











export const tawarruqPersonal = {
  descriptor: {
    code: 'tawarruq-personal',
    nameEn: 'Personal finance (Tawarruq)',
    nameAr: 'التمويل الشخصي (تورّق)',
    journeyShape: 'AMOUNT_FIRST',
    family: 'ISLAMIC',
    consumer: true,
    requiresBoardRuling: true,
  },
  validateTerms: parseTawarruqTerms,
  quote: quoteTawarruq,
  disclose: discloseTawarruq,
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
      correlationId: context.correlationId,
      openedAt: context.openedAt,
    });
  },
};
