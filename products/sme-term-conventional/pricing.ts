/**
 * Request → quote for conventional SME term finance. The rate arrives from the
 * engine's quotation (the tenant's catalogue rule); the schedule is the
 * platform's reducing-balance function; the business affordability rule
 * (size, debt-service cover, revenue share) is applied before any offer
 * exists. APR is not computed here — the platform computes it from `schedule`.
 */

import { type SizeClassification } from '@sanad/core/applicant/sme-size.ts';
import { checkBusinessAffordability } from '@sanad/core/decisioning/business-affordability.ts';
import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import type { RateSnapshot } from '@sanad/core/pricing/rate.ts';
import { cashFlows, reducingBalanceMonthly, type Schedule } from '@sanad/core/pricing/schedule.ts';

import type { SmeConventionalTerms } from './terms.ts';

export interface SmeConventionalQuote extends Quote {
  readonly productCode: 'sme-term-conventional';
  readonly months: number;
  readonly monthlyInstalment: Money;
  readonly interestAmount: Money;
  readonly rateSnapshot: RateSnapshot;
  readonly schedule_: Schedule;
  readonly size: SizeClassification;
  /** Cash flow ÷ debt service after this facility, per ten thousand; recorded on the decision. */
  readonly debtServiceCoverPerTenThousand: bigint | 'NO_DEBT_SERVICE';
  readonly creditPolicyRef: string;
  readonly guaranteedPortion?: { readonly programme: string; readonly amount: Money; readonly programmeRef: string };
}

/** The debt service the new facility adds over its first year (or its whole life, if shorter). */
export const firstYearService = (instalment: Money, months: number): Money => money(instalment.minorUnits * BigInt(Math.min(12, months)));

export function quoteSmeConventional(terms: SmeConventionalTerms, request: QuoteRequest): Result<SmeConventionalQuote> {
  if (request.pricing.rate === undefined) return reject('PLAT-03', 'RATE_REQUIRED', 'SME term finance is priced from a sourced rate');
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

  const afford = checkBusinessAffordability(terms.credit, definition, request.affordability?.business, request.requestedAmount, firstYearService(instalment, months));
  if (!afford.ok) return afford;

  const fees = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT' as const }] : [];
  const g = terms.guarantee;
  return ok({
    productCode: 'sme-term-conventional',
    financingAmount: request.requestedAmount,
    tenorDays: months * 30,
    months,
    schedule: cashFlows(request.requestedAmount, s, fees.map((f) => f.amount)),
    fees,
    totalPayable: add(s.totalPayable, terms.adminFee),
    totalCostOfCredit: add(s.totalProfit, terms.adminFee),
    monthlyInstalment: instalment,
    interestAmount: s.totalProfit,
    rateSnapshot: request.pricing.rate,
    schedule_: s,
    size: afford.value.classification,
    debtServiceCoverPerTenThousand: afford.value.debtServiceCoverPerTenThousand,
    creditPolicyRef: terms.credit.policyRef,
    ...(g === undefined ? {} : { guaranteedPortion: { programme: g.programme, programmeRef: g.programmeRef, amount: money((request.requestedAmount.minorUnits * BigInt(g.coveragePerTenThousand)) / 10_000n) } }),
  });
}
