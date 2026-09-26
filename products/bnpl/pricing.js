 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } } function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }import { add, money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';

import { roundDiv } from '../../core/pricing/rate.js';
import { cashFlows, flatInstalments, } from '../../core/pricing/schedule.js';












export function quoteBnpl(terms, request) {
  if (request.requestedAmount.minorUnits <= 0n) return reject('OP-DETERMINACY', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'A basket has a positive amount');
  if (request.pricing.profitAmount !== undefined && request.pricing.profitAmount.minorUnits !== 0n) {
    return reject('OP-DETERMINACY', 'BNPL_CONSUMER_COST_REFUSED', 'The consumer pays the basket price and nothing more (B-1)');
  }
  const outstanding = _nullishCoalesce(_optionalChain([request, 'access', _ => _.affordability, 'optionalAccess', _2 => _2.outstandingSameClass]), () => ( money(0n)));
  if (add(outstanding, request.requestedAmount).minorUnits > terms.consumerLimit.minorUnits) {
    return reject('OP-LIMIT', 'BNPL_CONSUMER_LIMIT_EXCEEDED', 'This basket would take the consumer over the limit the tenant applies', {
      limit: String(terms.consumerLimit.minorUnits), outstanding: String(outstanding.minorUnits), citation: terms.citation,
    });
  }
  const schedule = flatInstalments(request.requestedAmount, money(0n), terms.instalments, terms.intervalDays);
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const merchantFee = { code: 'MERCHANT_DISCOUNT', labelEn: 'Merchant discount', labelAr: 'خصم التاجر', amount: money(roundDiv(request.requestedAmount.minorUnits * BigInt(terms.merchantDiscountPerTenThousand), 10_000n)), when: 'UPFRONT' };
  return ok({
    productCode: 'bnpl',
    financingAmount: request.requestedAmount,
    tenorDays: terms.instalments * terms.intervalDays,
    schedule: cashFlows(request.requestedAmount, s),
    fees: [],
    totalPayable: request.requestedAmount,
    totalCostOfCredit: money(0n),
    basket: request.requestedAmount,
    instalmentAmount: _nullishCoalesce(_optionalChain([s, 'access', _3 => _3.instalments, 'access', _4 => _4[0], 'optionalAccess', _5 => _5.amount]), () => ( money(0n))),
    merchantFee,
    schedule_: s,
  });
}

export function discloseBnpl(q) {
  return {
    financingAmount: q.basket,
    tenorDays: q.tenorDays,
    instalmentCount: q.schedule_.instalments.length,
    ...(q.schedule_.instalments.every((i) => i.amount.minorUnits === q.instalmentAmount.minorUnits) ? { instalmentAmount: q.instalmentAmount } : {}),
    totalCostOfCredit: q.totalCostOfCredit,
    totalPayable: q.totalPayable,
    fees: [],
    lines: [{ code: 'BASKET', labelEn: 'Purchase amount', labelAr: 'قيمة المشتريات', amount: q.basket }],
  };
}
