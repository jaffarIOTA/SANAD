



/** The SAMA consumer set plus what makes this a sale: commodity cost, profit, deferred price. APR is added by the platform. */
export function discloseTawarruq(q) {
  return {
    financingAmount: q.financingAmount,
    tenorDays: q.tenorDays,
    instalmentCount: q.months,
    instalmentAmount: q.monthlyInstalment,
    totalCostOfCredit: q.totalCostOfCredit,
    totalPayable: q.totalPayable,
    fees: q.fees,
    lines: [
      { code: 'COMMODITY_COST', labelEn: 'Commodity purchase price', labelAr: 'ثمن شراء السلعة', amount: q.commodityCost },
      { code: 'PROFIT', labelEn: 'Profit', labelAr: 'الربح', amount: q.profitAmount },
      { code: 'DEFERRED_SALE_PRICE', labelEn: 'Deferred sale price', labelAr: 'ثمن البيع المؤجل', amount: q.deferredSalePrice },
    ],
  };
}
