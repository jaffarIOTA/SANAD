 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }













import { checkBusinessAffordability } from '../../core/decisioning/business-affordability.js';
import { add, money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';


import { datedAmortisingSchedule } from '../../core/pricing/dated-schedule.js';



import { chooseVariant } from './variants.js';



























export function quoteSmeIslamic(terms, request) {
  if (request.pricing.rate === undefined) return reject('PLAT-03', 'RATE_REQUIRED', 'SME Tawarruq is priced from a sourced rate');
  const definition = _optionalChain([request, 'access', _ => _.regulatory, 'optionalAccess', _2 => _2.smeDefinition]);
  if (definition === undefined) return reject('OP-DETERMINACY', 'SME_DEFINITION_MISSING', 'The regulator’s SME definition was not supplied to the quote');
  if (request.requestedAmount.currency === terms.currency && request.requestedAmount.minorUnits < terms.minAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_BELOW_PRODUCT', 'Below the product minimum', { min: String(terms.minAmount.minorUnits) });
  const chosen = chooseVariant(terms.variants, terms.currency, request);
  if (!chosen.ok) return chosen;
  const c = chosen.value;

  const schedule = datedAmortisingSchedule({
    principal: request.requestedAmount,
    annualRate: { ...request.pricing.rate.rate, basis: 'REDUCING' },
    disbursementDate: c.disbursementDate,
    firstDueDate: c.firstDueDate,
    numberOfPayments: c.months,
    paymentDay: c.paymentDay,
    graceMonths: c.graceMonths,
  });
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const currency = terms.currency;
  // A year of debt service at the level instalment: the year after grace, the conservative figure.
  const firstYear = money(s.levelInstalment.minorUnits * BigInt(Math.min(12, c.months)), currency);

  const afford = checkBusinessAffordability(terms.credit, definition, _optionalChain([request, 'access', _3 => _3.affordability, 'optionalAccess', _4 => _4.business]), request.requestedAmount, firstYear);
  if (!afford.ok) return afford;

  const fees = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT' }] : [];
  const flows = [...s.cashFlows, ...fees.map((f) => ({ at: { months: 0, days: 0 }, amount: f.amount, direction: 'REPAYMENT'  }))];
  const g = terms.guarantee;
  return ok({
    productCode: 'sme-term-islamic',
    variantCode: c.variant.code,
    variantNameEn: c.variant.nameEn,
    variantNameAr: c.variant.nameAr,
    purpose: c.purpose,
    financingAmount: request.requestedAmount,
    tenorDays: s.rows.reduce((d, r) => d + r.days, 0),
    months: c.months,
    graceMonths: c.graceMonths,
    contributionPerTenThousand: c.contributionPerTenThousand,
    ...(c.yearsInOperation === undefined ? {} : { yearsInOperation: c.yearsInOperation }),
    ...(c.variant.documentChecklistRef === undefined ? {} : { documentChecklistRef: c.variant.documentChecklistRef }),
    collateral: c.variant.collateral,
    schedule: flows,
    fees,
    totalPayable: add(s.totalPayable, terms.adminFee),
    totalCostOfCredit: add(s.totalInterest, terms.adminFee),
    commodityCost: request.requestedAmount,
    profitAmount: s.totalInterest,
    deferredSalePrice: s.totalPayable,
    monthlyInstalment: s.levelInstalment,
    datedSchedule: s,
    rateSnapshot: request.pricing.rate,
    size: afford.value.classification,
    debtServiceCoverPerTenThousand: afford.value.debtServiceCoverPerTenThousand,
    creditPolicyRef: terms.credit.policyRef,
    ...(g === undefined ? {} : { guaranteedPortion: { programme: g.programme, programmeRef: g.programmeRef, amount: money((request.requestedAmount.minorUnits * BigInt(g.coveragePerTenThousand)) / 10_000n, currency) } }),
  });
}
