import type { Disclosure } from '@sanad/core/products/module.ts';

import type { SmeConventionalQuote } from './pricing.ts';

/**
 * The full disclosure set, though an SME is not a consumer: the business owner
 * signing is usually a person, and the platform computes and shows APR on
 * every offer. Plus the guaranteed portion where a programme guarantee applies.
 */
export function discloseSmeConventional(q: SmeConventionalQuote): Disclosure {
  return {
    financingAmount: q.financingAmount,
    tenorDays: q.tenorDays,
    countOfInstalments: q.months,
    instalmentAmount: q.monthlyInstalment,
    totalCostOfCredit: q.totalCostOfCredit,
    totalPayable: q.totalPayable,
    fees: q.fees,
    lines: [
      { code: 'PRINCIPAL', labelEn: 'Financing amount', labelAr: 'مبلغ التمويل', amount: q.financingAmount },
      { code: 'INTEREST', labelEn: 'Total interest', labelAr: 'إجمالي الفائدة', amount: q.interestAmount },
      ...(q.guaranteedPortion === undefined ? [] : [{ code: 'GUARANTEED_PORTION', labelEn: `Portion guaranteed by ${q.guaranteedPortion.programme}`, labelAr: `الجزء المضمون من ${q.guaranteedPortion.programme}`, amount: q.guaranteedPortion.amount }]),
    ],
  };
}
