/**
 * Personal Tawarruq as the engine sees it. Islamic, consumer, amount-first;
 * enabled for a tenant only under that tenant's board ruling (the catalogue
 * parser refuses otherwise).
 */

import type { Approved } from '@sanad/core/origination/request.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import type { ProductModule } from '@sanad/core/products/module.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

import { discloseTawarruq } from './disclosure.ts';
import { type Draft, open } from './execution.ts';
import { type TawarruqQuote, quoteTawarruq } from './pricing.ts';
import { type TawarruqTerms, parseTawarruqTerms } from './terms.ts';

export interface TawarruqExecutionContext {
  readonly transactionId: string;
  readonly applicantRef: string;
  readonly bureauEnquiryRef: string;
  readonly consentId: string;
  readonly agencyRef?: string;
  readonly openedAt: TsaInstant;
  readonly correlationId: string;
}

export const tawarruqPersonal: ProductModule<TawarruqTerms, TawarruqQuote, TawarruqExecutionContext, Draft> = {
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
  execute(terms, approved: Approved, quote, context): Result<Draft> {
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
