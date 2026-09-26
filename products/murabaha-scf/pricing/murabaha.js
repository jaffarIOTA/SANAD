/**
 * Murabaha pricing.
 *
 *   sale_price_amount = cost_amount + profit_amount
 *
 * That is the whole of it. The profit is an amount, decided once at quotation
 * time and immutable thereafter. A benchmark may have informed how the amount was
 * arrived at; nothing about that benchmark is persisted against the transaction
 * and nothing recomputes the amount afterwards (SH-01).
 *
 * There is no function here that takes a percentage, a tenor multiplier or a
 * period count and returns an amount. The absence is the control.
 *
 * Disclosure of the original cost and the markup is a validity condition of the
 * Murabaha, not a consumer-protection courtesy (SH-15), so the disclosure block
 * is produced from the same values that render into the instrument — the screen
 * and the contract cannot disagree.
 */

import { add, equals, isNegative, isPositive, sameCurrency } from '../../../core/kernel/money.js';
import { ok, reject } from '../../../core/kernel/result.js';








export function priceMurabaha(costAmount, profitAmount) {
  if (!sameCurrency(costAmount, profitAmount)) {
    return reject('SH-03', 'PRICING_CURRENCY_MISMATCH', 'Cost and profit must be in one currency', {
      cost: costAmount.currency,
      profit: profitAmount.currency,
    });
  }
  if (!isPositive(costAmount)) {
    return reject('SH-03', 'COST_NOT_POSITIVE', 'The goods must have a determinate positive cost', {
      costMinorUnits: String(costAmount.minorUnits),
    });
  }
  if (isNegative(profitAmount)) {
    return reject('SH-03', 'PROFIT_NEGATIVE', 'The profit amount must not be negative');
  }

  return ok({
    costAmount,
    profitAmount,
    salePriceAmount: add(costAmount, profitAmount),
  });
}

/**
 * Re-derive and check. Used on read paths and by the continuous Shariah review,
 * so a row that drifted from the identity is caught rather than trusted.
 */
export function verifyPricingIntegrity(p) {
  if (!equals(p.salePriceAmount, add(p.costAmount, p.profitAmount))) {
    return reject(
      'SH-01',
      'SALE_PRICE_NOT_COST_PLUS_PROFIT',
      'The total is not the sum of cost and profit',
      {
        cost: String(p.costAmount.minorUnits),
        profit: String(p.profitAmount.minorUnits),
        total: String(p.salePriceAmount.minorUnits),
      },
    );
  }
  return ok(true);
}

/**
 * The disclosure block. Amounts only — there is no field here for a rate, and
 * adding one would be a change to the Murabaha's validity conditions, not a
 * presentational tweak.
 */







export function disclose(p) {
  return {
    costMinorUnits: String(p.costAmount.minorUnits),
    profitMinorUnits: String(p.profitAmount.minorUnits),
    totalMinorUnits: String(p.salePriceAmount.minorUnits),
    currency: p.salePriceAmount.currency,
  };
}
