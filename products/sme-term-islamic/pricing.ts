/**
 * Request → quote for SME Tawarruq. The rate arrives from the engine's
 * quotation (the tenant's catalogue rule) and is used once, here, to fix the
 * deferred sale price; from the offer on, the contract is a price, not a rate.
 * The applicant's variant, purpose, grace, contribution and dates are checked
 * against the term sheet (variants.ts). The schedule is the platform's dated
 * ACT/365 schedule (core/pricing/dated-schedule.ts); grace instalments carry
 * profit only. The commodity cost is the financing amount and the deferred
 * sale price is the schedule's total. The business affordability rule is
 * applied before any offer exists. APR is computed by the platform from
 * `schedule`.
 */

import { type SizeClassification } from '@sanad/core/applicant/sme-size.ts';
import { checkBusinessAffordability } from '@sanad/core/decisioning/business-affordability.ts';
import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Fee, Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import type { CashFlow } from '@sanad/core/pricing/apr.ts';
import { type DatedSchedule, datedAmortisingSchedule } from '@sanad/core/pricing/dated-schedule.ts';
import type { RateSnapshot } from '@sanad/core/pricing/rate.ts';

import type { SmeIslamicTerms } from './terms.ts';
import { type VariantLabel, chooseVariant } from './variants.ts';

export interface SmeIslamicQuote extends Quote {
  readonly productCode: 'sme-term-islamic';
  readonly variantCode: string;
  readonly variantNameEn: string;
  readonly variantNameAr: string;
  readonly purpose: VariantLabel;
  /** Instalments, grace instalments included. */
  readonly months: number;
  readonly graceMonths: number;
  readonly contributionPerTenThousand: number;
  readonly yearsInOperation?: number;
  readonly documentChecklistRef?: string;
  readonly collateral: readonly VariantLabel[];
  readonly commodityCost: Money;
  readonly profitAmount: Money;
  readonly deferredSalePrice: Money;
  /** The level instalment of the amortising periods (the last may be lower; grace instalments are profit only). */
  readonly monthlyInstalment: Money;
  readonly datedSchedule: DatedSchedule;
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

  const afford = checkBusinessAffordability(terms.credit, definition, request.affordability?.business, request.requestedAmount, firstYear);
  if (!afford.ok) return afford;

  const fees: Fee[] = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT' }] : [];
  const flows: CashFlow[] = [...s.cashFlows, ...fees.map((f) => ({ at: { months: 0, days: 0 }, amount: f.amount, direction: 'REPAYMENT' as const }))];
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
