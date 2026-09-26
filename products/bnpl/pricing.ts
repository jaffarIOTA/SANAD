import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Disclosure, Fee, Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import { roundDiv } from '@sanad/core/pricing/rate.ts';
import { cashFlows, flatInstalments, type Schedule } from '@sanad/core/pricing/schedule.ts';

import type { BnplTerms } from './terms.ts';

export interface BnplQuote extends Quote {
  readonly productCode: 'bnpl';
  readonly basket: Money;
  readonly instalmentAmount: Money;
  /** Borne by the merchant. Not in the consumer's cash flows, not in the disclosure's fees. */
  readonly merchantFee: Fee;
  readonly schedule_: Schedule;
}

export function quoteBnpl(terms: BnplTerms, request: QuoteRequest): Result<BnplQuote> {
  if (request.requestedAmount.minorUnits <= 0n) return reject('OP-DETERMINACY', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'A basket has a positive amount');
  if (request.pricing.profitAmount !== undefined && request.pricing.profitAmount.minorUnits !== 0n) {
    return reject('OP-DETERMINACY', 'BNPL_CONSUMER_COST_REFUSED', 'The consumer pays the basket price and nothing more (B-1)');
  }
  const outstanding = request.affordability?.outstandingSameClass ?? money(0n);
  if (add(outstanding, request.requestedAmount).minorUnits > terms.consumerLimit.minorUnits) {
    return reject('OP-LIMIT', 'BNPL_CONSUMER_LIMIT_EXCEEDED', 'This basket would take the consumer over the limit the tenant applies', {
      limit: String(terms.consumerLimit.minorUnits), outstanding: String(outstanding.minorUnits), citation: terms.citation,
    });
  }
  const schedule = flatInstalments(request.requestedAmount, money(0n), terms.instalments, terms.intervalDays);
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const merchantFee: Fee = { code: 'MERCHANT_DISCOUNT', labelEn: 'Merchant discount', labelAr: 'خصم التاجر', amount: money(roundDiv(request.requestedAmount.minorUnits * BigInt(terms.merchantDiscountPerTenThousand), 10_000n)), when: 'UPFRONT' };
  return ok({
    productCode: 'bnpl',
    financingAmount: request.requestedAmount,
    tenorDays: terms.instalments * terms.intervalDays,
    schedule: cashFlows(request.requestedAmount, s),
    fees: [],
    totalPayable: request.requestedAmount,
    totalCostOfCredit: money(0n),
    basket: request.requestedAmount,
    instalmentAmount: s.instalments[0]?.amount ?? money(0n),
    merchantFee,
    schedule_: s,
  });
}

export function discloseBnpl(q: BnplQuote): Disclosure {
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
