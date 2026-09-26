/**
 * Request → quote. The rate arrives from the engine's quotation (the tenant's
 * catalogue rule); the schedule is the platform's reducing-balance function;
 * the commodity cost is the financing amount and the deferred sale price is
 * the schedule's total. The affordability rule is applied here, before any
 * offer exists.
 */

import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import { cashFlows, reducingBalanceMonthly, type Schedule } from '@sanad/core/pricing/schedule.ts';
import type { RateSnapshot } from '@sanad/core/pricing/rate.ts';

import type { TawarruqTerms } from './terms.ts';

export interface TawarruqQuote extends Quote {
  readonly productCode: 'tawarruq-personal';
  readonly months: number;
  readonly commodityCost: Money;
  readonly profitAmount: Money;
  readonly deferredSalePrice: Money;
  readonly monthlyInstalment: Money;
  readonly schedule_: Schedule;
  readonly rateSnapshot: RateSnapshot;
}

export function quoteTawarruq(terms: TawarruqTerms, request: QuoteRequest): Result<TawarruqQuote> {
  if (request.pricing.rate === undefined) return reject('PLAT-03', 'RATE_REQUIRED', 'Personal Tawarruq is priced from a sourced rate');
  if (request.requestedAmount.minorUnits <= 0n) return reject('OP-DETERMINACY', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'The financing amount must be positive');
  if (request.requestedAmount.minorUnits > terms.maxAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_EXCEEDS_PRODUCT', 'Above the product maximum', { max: String(terms.maxAmount.minorUnits) });
  const months = Math.round(request.requestedTenorDays / 30);
  if (months < terms.minMonths || months > terms.maxMonths) return reject('OP-DETERMINACY', 'TENOR_OUTSIDE_PRODUCT', 'Tenor outside what this product allows', { months: String(months) });

  const schedule = reducingBalanceMonthly(request.requestedAmount, { ...request.pricing.rate.rate, basis: 'REDUCING' }, months);
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const instalment = s.instalments[0]?.amount ?? money(0n);

  // Affordability: (this instalment + existing obligations) / income ≤ cap. Integer, per ten thousand.
  const a = request.affordability;
  if (a?.monthlyIncome === undefined || a.existingMonthlyObligations === undefined) {
    return reject('OP-DETERMINACY', 'AFFORDABILITY_FACTS_MISSING', 'Income and existing obligations are required before a personal finance quote');
  }
  if (a.monthlyIncome.minorUnits <= 0n) return reject('OP-DETERMINACY', 'INCOME_NOT_POSITIVE', 'No income, no instalment');
  const deduction = (add(instalment, a.existingMonthlyObligations).minorUnits * 10_000n) / a.monthlyIncome.minorUnits;
  if (deduction > BigInt(terms.affordability.maxDeductionPerTenThousand)) {
    return reject('OP-LIMIT', 'DEDUCTION_RATIO_EXCEEDED', 'The instalment would take more of the applicant\'s income than the tenant\'s responsible-lending rule allows', {
      deductionPerTenThousand: String(deduction), cap: String(terms.affordability.maxDeductionPerTenThousand), citation: terms.affordability.citation,
    });
  }

  const fees = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT' as const }] : [];
  return ok({
    productCode: 'tawarruq-personal',
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
  });
}
