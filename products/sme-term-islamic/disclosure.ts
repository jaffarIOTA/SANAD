import type { Disclosure } from '@sanad/core/products/module.ts';

import type { SmeIslamicQuote } from './pricing.ts';

/** What makes this a sale — commodity cost, profit, deferred price — plus the guaranteed portion where a programme guarantee applies. APR is added by the platform. */
export function discloseSmeIslamic(q: SmeIslamicQuote): Disclosure {
  return {
    financingAmount: q.financingAmount,
    tenorDays: q.tenorDays,
    countOfInstalments: q.months,
    instalmentAmount: q.monthlyInstalment,
    totalCostOfCredit: q.totalCostOfCredit,
    totalPayable: q.totalPayable,
    fees: q.fees,
    lines: [
      { code: 'COMMODITY_COST', labelEn: 'Commodity purchase price', labelAr: 'ثمن شراء السلعة', amount: q.commodityCost },
      { code: 'PROFIT', labelEn: 'Profit', labelAr: 'الربح', amount: q.profitAmount },
      { code: 'DEFERRED_SALE_PRICE', labelEn: 'Deferred sale price', labelAr: 'ثمن البيع المؤجل', amount: q.deferredSalePrice },
      ...(q.guaranteedPortion === undefined ? [] : [{ code: 'GUARANTEED_PORTION', labelEn: `Portion guaranteed by ${q.guaranteedPortion.programme}`, labelAr: `الجزء المضمون من ${q.guaranteedPortion.programme}`, amount: q.guaranteedPortion.amount }]),
    ],
  };
}
