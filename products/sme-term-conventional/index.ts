/**
 * Conventional SME term finance as the engine sees it: amount-first, a
 * business applicant, priced by a rate, booked under a core banking product
 * type the tenant maps in its catalogue.
 */

import type { Approved } from '@sanad/core/origination/request.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import type { ProductModule } from '@sanad/core/products/module.ts';

import { discloseSmeConventional } from './disclosure.ts';
import { type Draft, type SmeExecutionContext, open } from './execution.ts';
import { type SmeConventionalQuote, quoteSmeConventional } from './pricing.ts';
import { type SmeConventionalTerms, parseSmeConventionalTerms } from './terms.ts';

export const smeTermConventional: ProductModule<
  SmeConventionalTerms,
  SmeConventionalQuote,
  SmeExecutionContext,
  Draft
> = {
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
  execute(terms, approved: Approved, quote, context): Result<Draft> {
    return open(terms, approved.core.tenantId, quote, context);
  },
};
