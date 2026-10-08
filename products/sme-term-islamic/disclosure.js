import { money } from '../../core/kernel/money.js';




/**
 * What makes this a sale — commodity cost, profit, deferred price — plus the
 * guaranteed portion where a programme guarantee applies. APR is added by the
 * platform. With a grace period the instalments are not equal (profit only,
 * then the level instalment), so `instalmentAmount` is omitted and the
 * grace-period profit and the level instalment are shown as lines instead.
 */
export function discloseSmeIslamic(q) {
  const currency = q.financingAmount.currency;
  const graceRows = q.datedSchedule.rows.filter((r) => r.grace);
  const graceLines = q.graceMonths === 0 ? [] : [
    { code: 'GRACE_PERIOD_PROFIT', labelEn: `Profit paid during the ${String(q.graceMonths)}-month grace period`, labelAr: `الربح المدفوع خلال فترة السماح (${String(q.graceMonths)} شهرًا)`, amount: money(graceRows.reduce((s, r) => s + r.interest.minorUnits, 0n), currency) },
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
      { code: 'COMMODITY_COST', labelEn: 'Commodity purchase price', labelAr: 'ثمن شراء السلعة', amount: q.commodityCost },
      { code: 'PROFIT', labelEn: 'Profit', labelAr: 'الربح', amount: q.profitAmount },
      { code: 'DEFERRED_SALE_PRICE', labelEn: 'Deferred sale price', labelAr: 'ثمن البيع المؤجل', amount: q.deferredSalePrice },
      ...graceLines,
      ...(q.guaranteedPortion === undefined ? [] : [{ code: 'GUARANTEED_PORTION', labelEn: `Portion guaranteed by ${q.guaranteedPortion.programme}`, labelAr: `الجزء المضمون من ${q.guaranteedPortion.programme}`, amount: q.guaranteedPortion.amount }]),
    ],
  };
}
