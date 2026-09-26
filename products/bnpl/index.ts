import type { Approved } from '@sanad/core/origination/request.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import type { ProductModule } from '@sanad/core/products/module.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

import { type Draft, open } from './execution.ts';
import { type BnplQuote, discloseBnpl, quoteBnpl } from './pricing.ts';
import { type BnplTerms, parseBnplTerms } from './terms.ts';

export interface BnplExecutionContext {
  readonly transactionId: string;
  readonly applicantRef: string;
  readonly merchantRef: string;
  readonly bureauEnquiryRef: string;
  readonly consentId: string;
  readonly openedAt: TsaInstant;
  readonly correlationId: string;
}

export const bnpl: ProductModule<BnplTerms, BnplQuote, BnplExecutionContext, Draft> = {
  descriptor: { code: 'bnpl', nameEn: 'Buy now, pay later', nameAr: 'اشترِ الآن وادفع لاحقاً', journeyShape: 'AMOUNT_FIRST', family: 'CONVENTIONAL', consumer: true, requiresBoardRuling: false },
  validateTerms: parseBnplTerms,
  quote: quoteBnpl,
  disclose: discloseBnpl,
  execute(_terms, approved: Approved, quote, context): Result<Draft> {
    return open({ transactionId: context.transactionId, tenantId: approved.core.tenantId, applicantRef: context.applicantRef, merchantRef: context.merchantRef, quote, bureauEnquiryRef: context.bureauEnquiryRef, consentId: context.consentId, correlationId: context.correlationId, openedAt: context.openedAt });
  },
};
