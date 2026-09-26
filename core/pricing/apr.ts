/**
 * APR — the one function on the platform that computes it (CLAUDE.md §4.2).
 *
 * The effective annual rate X that equates the present value of what the
 * customer receives with the present value of what the customer pays, fees
 * included:
 *
 *     Σ D_l · (1 + X)^(−s_l)  =  Σ R_k · (1 + X)^(−t_k)
 *
 * with s and t in years. Time is measured the way the consumer-credit
 * formulas measure it: a whole number of months is a whole number of twelfths
 * of a year, and days are 365ths of a year.
 *
 * Integer arithmetic throughout. Values are fixed-point `bigint` at 10^18;
 * `(1 + X)^(−t)` is `exp(−t · ln(1 + X))` with `ln` and `exp` as convergent
 * series in fixed point; X is found by bisection. No `Math.*`, no `number` in
 * the financial path. The result is basis points, rounded half up.
 *
 * SAMA's consumer-finance annex publishes worked examples. The golden tests
 * in `test/unit/apr.test.ts` hold analytically exact cases today; the annex
 * examples are to be transcribed from the current rulebook, with the article
 * cited, before any consumer product goes live (§3: a threshold with no
 * citation is a guess).
 */

import type { Money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import { ONE, SCALE, div, exp, ln, mul } from './fixed-point.ts';

/** When a cash flow happens, relative to the first drawdown. */
export interface Tenor {
  readonly months: number;
  readonly days: number;
}

export interface CashFlow {
  readonly at: Tenor;
  readonly amount: Money;
  readonly direction: 'DRAWDOWN' | 'REPAYMENT';
}

export interface AprResult {
  /** Basis points, annual, rounded half up. */
  readonly bp: bigint;
  readonly iterations: number;
}

const TWELVE = 12n;
const YEAR_DAYS = 365n;

/** Search bounds: 0% to 10 000% a year. Anything outside is not a consumer offer. */
const MAX_BP = 1_000_000n;
const MAX_ITERATIONS = 200;

export function computeApr(flows: readonly CashFlow[]): Result<AprResult> {
  const drawdowns = flows.filter((f) => f.direction === 'DRAWDOWN');
  const repayments = flows.filter((f) => f.direction === 'REPAYMENT');
  if (drawdowns.length === 0 || repayments.length === 0) {
    return reject('PLAT-02', 'APR_NEEDS_BOTH_SIDES', 'APR needs at least one drawdown and one repayment');
  }
  for (const f of flows) {
    if (f.amount.minorUnits <= 0n) return reject('PLAT-02', 'APR_NON_POSITIVE_FLOW', 'Every cash flow must be positive');
    if (f.at.months < 0 || f.at.days < 0 || !Number.isInteger(f.at.months) || !Number.isInteger(f.at.days)) {
      return reject('PLAT-02', 'APR_MALFORMED_TENOR', 'Tenor is whole non-negative months and days');
    }
  }
  const currency = flows[0]?.amount.currency;
  if (flows.some((f) => f.amount.currency !== currency)) {
    return reject('PLAT-02', 'APR_MIXED_CURRENCY', 'All cash flows must share a currency');
  }

  const paid = repayments.reduce((s, f) => s + f.amount.minorUnits, 0n);
  const received = drawdowns.reduce((s, f) => s + f.amount.minorUnits, 0n);
  if (paid < received) {
    return reject('PLAT-02', 'APR_NEGATIVE', 'The customer repays less than was advanced; APR would be negative');
  }
  if (paid === received) return ok({ bp: 0n, iterations: 0 });

  // f(X) = PV(repayments) − PV(drawdowns): positive at X = 0, decreasing in X.
  const f = (x: bigint): bigint => {
    const lnOnePlusX = ln(ONE + x);
    let pv = 0n;
    for (const flow of flows) {
      const t = years(flow.at);
      const factor = exp(-mul(t, lnOnePlusX));
      const v = mul(flow.amount.minorUnits * SCALE, factor);
      pv += flow.direction === 'REPAYMENT' ? v : -v;
    }
    return pv;
  };

  // Bisection over X in fixed point. Precision well beyond a hundredth of a bp.
  let lo = 0n;
  let hi = (MAX_BP * SCALE) / 10_000n;
  if (f(hi) > 0n) return reject('PLAT-02', 'APR_OUT_OF_RANGE', 'APR exceeds the search bound');
  let iterations = 0;
  while (iterations < MAX_ITERATIONS && hi - lo > SCALE / 10n ** 12n) {
    const mid = (lo + hi) / 2n;
    if (f(mid) > 0n) lo = mid;
    else hi = mid;
    iterations += 1;
  }
  const x = (lo + hi) / 2n;
  // to basis points, half up
  const bp = (x * 10_000n + SCALE / 2n) / SCALE;
  return ok({ bp, iterations });
}

function years(t: Tenor): bigint {
  return div(BigInt(t.months) * SCALE, TWELVE * SCALE) + div(BigInt(t.days) * SCALE, YEAR_DAYS * SCALE);
}
