/**
 * Request → quote for conventional SME term finance. The rate arrives from the
 * engine's quotation (the tenant's catalogue rule); the applicant's variant,
 * purpose, grace, contribution and dates are checked against the term sheet
 * (variants.ts); the schedule is the platform's dated ACT/365 schedule
 * (core/pricing/dated-schedule.ts), the one the core banking system books; the
 * business affordability rule (size, debt-service cover, revenue share) is
 * applied before any offer exists. APR is not computed here — the platform
 * computes it from `schedule`, which is the dated schedule's cash flows plus
 * the upfront fees.
 */

import { type SizeClassification } from '@sanad/core/applicant/sme-size.ts';
import { checkBusinessAffordability } from '@sanad/core/decisioning/business-affordability.ts';
import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { Fee, Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import type { CashFlow } from '@sanad/core/pricing/apr.ts';
import { type DatedSchedule, datedAmortisingSchedule } from '@sanad/core/pricing/dated-schedule.ts';
import type { RateSnapshot } from '@sanad/core/pricing/rate.ts';

import type { SmeConventionalTerms } from './terms.ts';
import { type VariantLabel, chooseVariant } from './variants.ts';

export interface SmeConventionalQuote extends Quote {
  readonly productCode: 'sme-term-conventional';
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
  /** The level instalment of the amortising periods (the last may be lower; grace instalments are interest only). */
  readonly monthlyInstalment: Money;
  readonly interestAmount: Money;
  readonly rateSnapshot: RateSnapshot;
  readonly datedSchedule: DatedSchedule;
  readonly size: SizeClassification;
  /** Cash flow ÷ debt service after this facility, per ten thousand; recorded on the decision. */
  readonly debtServiceCoverPerTenThousand: bigint | 'NO_DEBT_SERVICE';
  readonly creditPolicyRef: string;
  readonly guaranteedPortion?: { readonly programme: string; readonly amount: Money; readonly programmeRef: string };
}

/**
 * The debt service the new facility adds over a year, at its level
 * instalment (or over its whole life, if shorter). Grace instalments are
 * lower, so this is the year after grace — the conservative figure.
 */
export const firstYearService = (instalment: Money, months: number): Money =>
  money(instalment.minorUnits * BigInt(Math.min(12, months)), instalment.currency);

/** The dated schedule's flows, plus each upfront fee as a repayment at tenor zero. */
export const flowsWithFees = (s: DatedSchedule, fees: readonly Fee[]): readonly CashFlow[] => [
  ...s.cashFlows,
  ...fees
    .filter((f) => f.when === 'UPFRONT' && f.amount.minorUnits > 0n)
    .map((f) => ({ at: { months: 0, days: 0 }, amount: f.amount, direction: 'REPAYMENT' as const })),
];

export function quoteSmeConventional(terms: SmeConventionalTerms, request: QuoteRequest): Result<SmeConventionalQuote> {
  if (request.pricing.rate === undefined)
    return reject('PLAT-03', 'RATE_REQUIRED', 'SME term finance is priced from a sourced rate');
  const definition = request.regulatory?.smeDefinition;
  if (definition === undefined)
    return reject(
      'OP-DETERMINACY',
      'SME_DEFINITION_MISSING',
      'The regulator’s SME definition was not supplied to the quote',
    );
  if (
    request.requestedAmount.currency === terms.currency &&
    request.requestedAmount.minorUnits < terms.minAmount.minorUnits
  )
    return reject('OP-LIMIT', 'AMOUNT_BELOW_PRODUCT', 'Below the product minimum', {
      min: String(terms.minAmount.minorUnits),
    });
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

  const afford = checkBusinessAffordability(
    terms.credit,
    definition,
    request.affordability?.business,
    request.requestedAmount,
    firstYearService(s.levelInstalment, c.months),
  );
  if (!afford.ok) return afford;

  const fees: Fee[] =
    terms.adminFee.minorUnits > 0n
      ? [
          {
            code: 'ADMIN',
            labelEn: 'Administration fee',
            labelAr: 'رسوم إدارية',
            amount: terms.adminFee,
            when: 'UPFRONT',
          },
        ]
      : [];
  const g = terms.guarantee;
  const currency = terms.currency;
  return ok({
    productCode: 'sme-term-conventional',
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
    schedule: flowsWithFees(s, fees),
    fees,
    totalPayable: add(s.totalPayable, terms.adminFee),
    totalCostOfCredit: add(s.totalInterest, terms.adminFee),
    monthlyInstalment: s.levelInstalment,
    interestAmount: s.totalInterest,
    rateSnapshot: request.pricing.rate,
    datedSchedule: s,
    size: afford.value.classification,
    debtServiceCoverPerTenThousand: afford.value.debtServiceCoverPerTenThousand,
    creditPolicyRef: terms.credit.policyRef,
    ...(g === undefined
      ? {}
      : {
          guaranteedPortion: {
            programme: g.programme,
            programmeRef: g.programmeRef,
            amount: money((request.requestedAmount.minorUnits * BigInt(g.coveragePerTenThousand)) / 10_000n, currency),
          },
        }),
  });
}
