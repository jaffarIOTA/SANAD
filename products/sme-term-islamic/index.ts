/**
 * SME finance by Tawarruq as the engine sees it: Islamic, amount-first, a
 * business applicant; enabled for a tenant only under that tenant's board
 * ruling (the catalogue parser refuses otherwise). Booked under a core
 * banking product type the tenant maps in its catalogue.
 */

import type { Approved } from '@sanad/core/origination/request.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import type { ProductModule } from '@sanad/core/products/module.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

import { discloseSmeIslamic } from './disclosure.ts';
import { type Draft, open } from './execution.ts';
import { type SmeIslamicQuote, quoteSmeIslamic } from './pricing.ts';
import { type SmeIslamicTerms, parseSmeIslamicTerms } from './terms.ts';

export interface SmeIslamicExecutionContext {
  readonly transactionId: string;
  readonly applicantRef: string;
  readonly bureauEnquiryRef: string;
  readonly consentId: string;
  readonly businessRegistryRef: string;
  readonly agencyRef?: string;
  readonly openedAt: TsaInstant;
  readonly correlationId: string;
}

export const smeTermIslamic: ProductModule<SmeIslamicTerms, SmeIslamicQuote, SmeIslamicExecutionContext, Draft> = {
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
  execute(terms, approved: Approved, quote, context): Result<Draft> {
    return open({
      transactionId: context.transactionId,
      tenantId: approved.core.tenantId,
      applicantRef: context.applicantRef,
      quote,
      brokerRef: terms.brokerRef,
      agency: {
        permitted: terms.agencyPermitted,
        ...(context.agencyRef === undefined ? {} : { agencyRef: context.agencyRef }),
      },
      bureauEnquiryRef: context.bureauEnquiryRef,
      consentId: context.consentId,
      businessRegistryRef: context.businessRegistryRef,
      guaranteeRequired: terms.guarantee?.requiredBeforeDisbursement === true,
      correlationId: context.correlationId,
      openedAt: context.openedAt,
    });
  },
};
