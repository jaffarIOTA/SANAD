/**
 * From a tenant's pricing rule to the inputs a product module quotes with.
 *
 * Pure: the benchmark, when the rule needs one, has already been fetched
 * through the Rate Publisher port and is passed in. A missing benchmark is a
 * refusal, never a default.
 */

import type { Money } from '../kernel/money.ts';
import { money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { PricingInputs } from '../products/module.ts';
import type { PricingRule } from '../products/catalogue.ts';
import type { MarketRange, PublishedBenchmark } from '../ports/rate-publisher.ts';
import { accrue, addBp, rate, type RateSnapshot } from './rate.ts';

export interface QuotationContext {
  readonly principal: Money;
  readonly tenorDays: number;
  readonly asOfEpochSeconds: bigint;
  readonly benchmark?: PublishedBenchmark;
  readonly marketRange?: MarketRange;
}

export function resolvePricingInputs(rule: PricingRule, ctx: QuotationContext): Result<PricingInputs> {
  switch (rule.kind) {
    case 'FIXED_PROFIT_AMOUNT':
      return ok({ profitAmount: money(BigInt(rule.profitMinorUnits), ctx.principal.currency) });
    case 'CATALOGUE_RATE': {
      const snap: RateSnapshot = { rate: rate(BigInt(rule.bp), rule.basis), source: 'TENANT_CATALOGUE', sourceRef: rule.catalogueRef, snapshottedAtEpochSeconds: ctx.asOfEpochSeconds };
      return withProfit(snap, ctx);
    }
    case 'BENCHMARK_PLUS_MARGIN': {
      if (ctx.benchmark === undefined || ctx.benchmark.code !== rule.benchmarkCode) {
        return reject('PLAT-03', 'BENCHMARK_UNAVAILABLE', 'The benchmark this product is priced from is not available; quotation refused', { benchmarkCode: rule.benchmarkCode });
      }
      let r = addBp({ ...ctx.benchmark.rate, basis: rule.basis }, BigInt(rule.marginBp));
      if (rule.boundByMarketRange === true) {
        if (ctx.marketRange === undefined) return reject('PLAT-03', 'MARKET_RANGE_UNAVAILABLE', 'The market range this product is bounded by is not available; quotation refused');
        if (r.bp > ctx.marketRange.highBp) r = { ...r, bp: ctx.marketRange.highBp };
        if (r.bp < ctx.marketRange.lowBp) r = { ...r, bp: ctx.marketRange.lowBp };
      }
      const snap: RateSnapshot = { rate: r, source: 'RATE_PUBLISHER', sourceRef: ctx.benchmark.referenceId, snapshottedAtEpochSeconds: ctx.asOfEpochSeconds };
      return withProfit(snap, ctx);
    }
  }
}

/** A rate-priced input also carries the profit amount it implies over the tenor, for amount-priced products. */
function withProfit(snap: RateSnapshot, ctx: QuotationContext): Result<PricingInputs> {
  const profit = accrue(ctx.principal, snap.rate, BigInt(ctx.tenorDays));
  if (!profit.ok) return profit;
  return ok({ rate: snap, profitAmount: profit.value });
}
