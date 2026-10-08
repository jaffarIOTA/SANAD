




import { open } from './execution.js';
import { discloseBnpl, quoteBnpl } from './pricing.js';
import { parseBnplTerms } from './terms.js';












export const bnpl = {
  descriptor: { code: 'bnpl', nameEn: 'Buy now, pay later', nameAr: 'اشترِ الآن وادفع لاحقاً', journeyShape: 'AMOUNT_FIRST', family: 'CONVENTIONAL', consumer: true, requiresBoardRuling: false, bookingShape: 'CORE_FACILITY' },
  validateTerms: parseBnplTerms,
  quote: quoteBnpl,
  disclose: discloseBnpl,
  execute(_terms, approved, quote, context) {
    return open({ transactionId: context.transactionId, tenantId: approved.core.tenantId, applicantRef: context.applicantRef, merchantRef: context.merchantRef, quote, bureauEnquiryRef: context.bureauEnquiryRef, consentId: context.consentId, eligibility: context.eligibility, correlationId: context.correlationId, openedAt: context.openedAt });
  },
};
