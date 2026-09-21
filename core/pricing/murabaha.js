import { add, equals, isNegative, isPositive, sameCurrency } from "../kernel/money.js";
import { ok, reject } from "../kernel/result.js";
function priceMurabaha(costAmount, profitAmount) {
  if (!sameCurrency(costAmount, profitAmount)) {
    return reject("SH-03", "PRICING_CURRENCY_MISMATCH", "Cost and profit must be in one currency", {
      cost: costAmount.currency,
      profit: profitAmount.currency
    });
  }
  if (!isPositive(costAmount)) {
    return reject("SH-03", "COST_NOT_POSITIVE", "The goods must have a determinate positive cost", {
      costMinorUnits: String(costAmount.minorUnits)
    });
  }
  if (isNegative(profitAmount)) {
    return reject("SH-03", "PROFIT_NEGATIVE", "The profit amount must not be negative");
  }
  return ok({
    costAmount,
    profitAmount,
    salePriceAmount: add(costAmount, profitAmount)
  });
}
function verifyPricingIntegrity(p) {
  if (!equals(p.salePriceAmount, add(p.costAmount, p.profitAmount))) {
    return reject(
      "SH-01",
      "SALE_PRICE_NOT_COST_PLUS_PROFIT",
      "The total is not the sum of cost and profit",
      {
        cost: String(p.costAmount.minorUnits),
        profit: String(p.profitAmount.minorUnits),
        total: String(p.salePriceAmount.minorUnits)
      }
    );
  }
  return ok(true);
}
function disclose(p) {
  return {
    costMinorUnits: String(p.costAmount.minorUnits),
    profitMinorUnits: String(p.profitAmount.minorUnits),
    totalMinorUnits: String(p.salePriceAmount.minorUnits),
    currency: p.salePriceAmount.currency
  };
}
export {
  disclose,
  priceMurabaha,
  verifyPricingIntegrity
};
