import { money } from '@sanad/core/kernel/money.ts';
import type { Disclosure, DisclosureLine } from '@sanad/core/products/module.ts';

import type { SmeConventionalQuote } from './pricing.ts';

/**
 * The full disclosure set, though an SME is not a consumer: the business owner
 * signing is usually a person, and the platform computes and shows APR on
 * every offer. Plus the guaranteed portion where a programme guarantee applies.
 *
 * With a grace period the instalments are not equal (interest only, then the
 * level instalment), so `instalmentAmount` is omitted and the grace-period
 * interest and the level instalment are shown as lines instead.
 */
export function discloseSmeConventional(q: SmeConventionalQuote): Disclosure {
  const currency = q.financingAmount.currency;
  const graceRows = q.datedSchedule.rows.filter((r) => r.grace);
  const graceLines: DisclosureLine[] = q.graceMonths === 0 ? [] : [
    { code: 'GRACE_PERIOD_INTEREST', labelEn: `Interest paid during the ${String(q.graceMonths)}-month grace period`, labelAr: `الفائدة المدفوعة خلال فترة السماح (${String(q.graceMonths)} شهرًا)`, amount: money(graceRows.reduce((s, r) => s + r.interest.minorUnits, 0n), currency) },
    { code: 'LEVEL_INSTALMENT', labelEn: 'Monthly instalment after the grace period', labelAr: 'القسط الشهري بعد فترة السماح', amount: q.monthlyInstalment },
  ];
  return {
    financingAmount: q.financingAmount,
    tenorDays: q.tenorDays,
    countOfInstalments: q.months,
    ...(q.graceMonths === 0 ? { instalmentAmount: q.monthlyInstalment } : {}),
    totalCostOfCredit: q.totalCostOfCredit,
    totalPayable: q.totalPayable,
    fees: q.fees,
    lines: [
      { code: 'PRINCIPAL', labelEn: 'Financing amount', labelAr: 'مبلغ التمويل', amount: q.financingAmount },
      { code: 'INTEREST', labelEn: 'Total interest', labelAr: 'إجمالي الفائدة', amount: q.interestAmount },
      ...graceLines,
      ...(q.guaranteedPortion === undefined ? [] : [{ code: 'GUARANTEED_PORTION', labelEn: `Portion guaranteed by ${q.guaranteedPortion.programme}`, labelAr: `الجزء المضمون من ${q.guaranteedPortion.programme}`, amount: q.guaranteedPortion.amount }]),
    ],
  };
}
