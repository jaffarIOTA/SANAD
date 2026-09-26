 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }/**
 * Request → quote. The rate arrives from the engine's quotation (the tenant's
 * catalogue rule); the schedule is the platform's reducing-balance function;
 * the commodity cost is the financing amount and the deferred sale price is
 * the schedule's total. The affordability rule is applied here, before any
 * offer exists.
 */

import { add, money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';

import { cashFlows, reducingBalanceMonthly, } from '../../core/pricing/schedule.js';















export function quoteTawarruq(terms, request) {
  if (request.pricing.rate === undefined) return reject('PLAT-03', 'RATE_REQUIRED', 'Personal Tawarruq is priced from a sourced rate');
  if (request.requestedAmount.minorUnits <= 0n) return reject('OP-DETERMINACY', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'The financing amount must be positive');
  if (request.requestedAmount.minorUnits > terms.maxAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_EXCEEDS_PRODUCT', 'Above the product maximum', { max: String(terms.maxAmount.minorUnits) });
  const months = Math.round(request.requestedTenorDays / 30);
  if (months < terms.minMonths || months > terms.maxMonths) return reject('OP-DETERMINACY', 'TENOR_OUTSIDE_PRODUCT', 'Tenor outside what this product allows', { months: String(months) });

  const schedule = reducingBalanceMonthly(request.requestedAmount, { ...request.pricing.rate.rate, basis: 'REDUCING' }, months);
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const instalment = _nullishCoalesce(_optionalChain([s, 'access', _ => _.instalments, 'access', _2 => _2[0], 'optionalAccess', _3 => _3.amount]), () => ( money(0n)));

  // Affordability: (this instalment + existing obligations) / income ≤ cap. Integer, per ten thousand.
  const a = request.affordability;
  if (_optionalChain([a, 'optionalAccess', _4 => _4.monthlyIncome]) === undefined || a.existingMonthlyObligations === undefined) {
    return reject('OP-DETERMINACY', 'AFFORDABILITY_FACTS_MISSING', 'Income and existing obligations are required before a personal finance quote');
  }
  if (a.monthlyIncome.minorUnits <= 0n) return reject('OP-DETERMINACY', 'INCOME_NOT_POSITIVE', 'No income, no instalment');
  const deduction = (add(instalment, a.existingMonthlyObligations).minorUnits * 10_000n) / a.monthlyIncome.minorUnits;
  if (deduction > BigInt(terms.affordability.maxDeductionPerTenThousand)) {
    return reject('OP-LIMIT', 'DEDUCTION_RATIO_EXCEEDED', 'The instalment would take more of the applicant\'s income than the tenant\'s responsible-lending rule allows', {
      deductionPerTenThousand: String(deduction), cap: String(terms.affordability.maxDeductionPerTenThousand), citation: terms.affordability.citation,
    });
  }

  const fees = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT'  }] : [];
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
