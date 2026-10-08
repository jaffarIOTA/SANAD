/**
 * Request → quote for SME Tawarruq. The rate arrives from the engine's
 * quotation (the tenant's catalogue rule) and is used once, here, to fix the
 * deferred sale price; from the offer on, the contract is a price, not a rate.
 * The commodity cost is the financing amount and the deferred sale price is
 * the schedule's total. The business affordability rule is applied before any
 * offer exists. APR is computed by the platform from `schedule`.
 */

import { type SizeClassification } from '@sanad/core/applicant/sme-size.ts';
import { checkBusinessAffordability } from '@sanad/core/decisioning/business-affordability.ts';
import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import type { RateSnapshot } from '@sanad/core/pricing/rate.ts';
import { cashFlows, reducingBalanceMonthly, type Schedule } from '@sanad/core/pricing/schedule.ts';

import type { SmeIslamicTerms } from './terms.ts';

export interface SmeIslamicQuote extends Quote {
  readonly productCode: 'sme-term-islamic';
  readonly months: number;
  readonly commodityCost: Money;
  readonly profitAmount: Money;
  readonly deferredSalePrice: Money;
  readonly monthlyInstalment: Money;
  readonly schedule_: Schedule;
  readonly rateSnapshot: RateSnapshot;
  readonly size: SizeClassification;
  readonly debtServiceCoverPerTenThousand: bigint | 'NO_DEBT_SERVICE';
  readonly creditPolicyRef: string;
  readonly guaranteedPortion?: { readonly programme: string; readonly amount: Money; readonly programmeRef: string };
}

export function quoteSmeIslamic(terms: SmeIslamicTerms, request: QuoteRequest): Result<SmeIslamicQuote> {
  if (request.pricing.rate === undefined) return reject('PLAT-03', 'RATE_REQUIRED', 'SME Tawarruq is priced from a sourced rate');
  const definition = request.regulatory?.smeDefinition;
  if (definition === undefined) return reject('OP-DETERMINACY', 'SME_DEFINITION_MISSING', 'The regulator’s SME definition was not supplied to the quote');
  if (request.requestedAmount.minorUnits < terms.minAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_BELOW_PRODUCT', 'Below the product minimum', { min: String(terms.minAmount.minorUnits) });
  if (request.requestedAmount.minorUnits > terms.maxAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_EXCEEDS_PRODUCT', 'Above the product maximum', { max: String(terms.maxAmount.minorUnits) });
  const months = Math.round(request.requestedTenorDays / 30);
  if (months < terms.minMonths || months > terms.maxMonths) return reject('OP-DETERMINACY', 'TENOR_OUTSIDE_PRODUCT', 'Tenor outside what this product allows', { months: String(months) });

  const schedule = reducingBalanceMonthly(request.requestedAmount, { ...request.pricing.rate.rate, basis: 'REDUCING' }, months);
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const instalment = s.instalments[0]?.amount ?? money(0n);
  const firstYear = money(instalment.minorUnits * BigInt(Math.min(12, months)));

  const afford = checkBusinessAffordability(terms.credit, definition, request.affordability?.business, request.requestedAmount, firstYear);
  if (!afford.ok) return afford;

  const fees = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT' as const }] : [];
  const g = terms.guarantee;
  return ok({
    productCode: 'sme-term-islamic',
    financingAmount: request.requestedAmount,
    tenorDays: months * 30,
    months,
    schedule: cashFlows(request.requestedAmount, s, fees.map((f) => f.amount)),
    fees,
    totalPayable: add(s.totalPayable, terms.adminFee),
    totalCostOfCredit: add(s.totalProfit, terms.adminFee),
    commodityCost: request.requestedAmount,
    profitAmount: s.totalProfit,
    deferredSalePrice: s.totalPayable,
    monthlyInstalment: instalment,
    schedule_: s,
    rateSnapshot: request.pricing.rate,
    size: afford.value.classification,
    debtServiceCoverPerTenThousand: afford.value.debtServiceCoverPerTenThousand,
    creditPolicyRef: terms.credit.policyRef,
    ...(g === undefined ? {} : { guaranteedPortion: { programme: g.programme, programmeRef: g.programmeRef, amount: money((request.requestedAmount.minorUnits * BigInt(g.coveragePerTenThousand)) / 10_000n) } }),
  });
}
