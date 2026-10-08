 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }








import { checkBusinessAffordability } from '../../core/decisioning/business-affordability.js';
import { add, money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';


import { cashFlows, reducingBalanceMonthly, } from '../../core/pricing/schedule.js';

















/** The debt service the new facility adds over its first year (or its whole life, if shorter). */
export const firstYearService = (instalment, months) => money(instalment.minorUnits * BigInt(Math.min(12, months)));

export function quoteSmeConventional(terms, request) {
  if (request.pricing.rate === undefined) return reject('PLAT-03', 'RATE_REQUIRED', 'SME term finance is priced from a sourced rate');
  const definition = _optionalChain([request, 'access', _ => _.regulatory, 'optionalAccess', _2 => _2.smeDefinition]);
  if (definition === undefined) return reject('OP-DETERMINACY', 'SME_DEFINITION_MISSING', 'The regulator’s SME definition was not supplied to the quote');
  if (request.requestedAmount.minorUnits < terms.minAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_BELOW_PRODUCT', 'Below the product minimum', { min: String(terms.minAmount.minorUnits) });
  if (request.requestedAmount.minorUnits > terms.maxAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_EXCEEDS_PRODUCT', 'Above the product maximum', { max: String(terms.maxAmount.minorUnits) });
  const months = Math.round(request.requestedTenorDays / 30);
  if (months < terms.minMonths || months > terms.maxMonths) return reject('OP-DETERMINACY', 'TENOR_OUTSIDE_PRODUCT', 'Tenor outside what this product allows', { months: String(months) });

  const schedule = reducingBalanceMonthly(request.requestedAmount, { ...request.pricing.rate.rate, basis: 'REDUCING' }, months);
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const instalment = _nullishCoalesce(_optionalChain([s, 'access', _3 => _3.instalments, 'access', _4 => _4[0], 'optionalAccess', _5 => _5.amount]), () => ( money(0n)));

  const afford = checkBusinessAffordability(terms.credit, definition, _optionalChain([request, 'access', _6 => _6.affordability, 'optionalAccess', _7 => _7.business]), request.requestedAmount, firstYearService(instalment, months));
  if (!afford.ok) return afford;

  const fees = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT'  }] : [];
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
