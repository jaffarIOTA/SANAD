/**
 * Repayment schedules in integer arithmetic.
 *
 * Two shapes cover the amount-first products: equal instalments on a
 * reducing balance (an annuity — personal finance, term loans) and equal
 * instalments of a fixed total (flat — BNPL, and any product whose total is
 * fixed at inception). Every instalment is whole minor units and the
 * instalments sum exactly to what is owed: the rounding remainder lands on
 * the last instalment, never silently anywhere.
 *
 * A schedule says *what* is paid *when*. The profit/principal split of a
 * reducing-balance instalment is computed alongside so a product can
 * disclose it; it is derived from the same integers and sums to the same
 * totals.
 */

import { type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { CashFlow } from './apr.ts';
import { ONE, SCALE, div, mul, powInt } from './fixed-point.ts';
import { BP_PER_UNIT, type Rate } from './rate.ts';

export interface Instalment {
  readonly number: number;
  readonly at: { readonly months: number; readonly days: number };
  readonly amount: Money;
  readonly principal: Money;
  readonly profit: Money;
}

export interface Schedule {
  readonly instalments: readonly Instalment[];
  readonly totalPayable: Money;
  readonly totalProfit: Money;
}

/**
 * Equal monthly instalments on a reducing balance at an annual rate.
 * Payment = P · i / (1 − (1 + i)^−n), i = annual bp / 12 in fixed point.
 * The per-period profit is balance × i, rounded half up; the last instalment
 * absorbs the rounding so the principal sums exactly to P.
 */
export function reducingBalanceMonthly(principal: Money, annual: Rate, months: number): Result<Schedule> {
  if (!Number.isInteger(months) || months <= 0) return reject('PLAT-02', 'SCHEDULE_MONTHS', 'months is a positive integer');
  if (annual.period !== 'ANNUAL' || annual.basis !== 'REDUCING') return reject('PLAT-02', 'SCHEDULE_RATE_SHAPE', 'reducingBalanceMonthly takes an annual REDUCING rate');
  if (annual.bp < 0n) return reject('PLAT-02', 'SCHEDULE_RATE_NEGATIVE', 'A negative rate is not a schedule');
  if (principal.minorUnits <= 0n) return reject('PLAT-02', 'SCHEDULE_PRINCIPAL', 'principal must be positive');

  const n = BigInt(months);
  const i = div(annual.bp * SCALE, BP_PER_UNIT * 12n * SCALE); // monthly rate, fixed point
  const P = principal.minorUnits * SCALE;
  let payment: bigint;
  if (i === 0n) {
    payment = P / n;
  } else {
    const factor = powInt(ONE + i, n);
    payment = div(mul(P, i), ONE - div(ONE, factor));
  }
  const paymentMinor = (payment + SCALE / 2n) / SCALE;

  const instalments: Instalment[] = [];
  let balance = principal.minorUnits;
  for (let k = 1; k <= months; k += 1) {
    const profit = (mul(balance * SCALE, i) + SCALE / 2n) / SCALE;
    const last = k === months;
    const principalPart = last ? balance : paymentMinor - profit;
    const amount = last ? balance + profit : paymentMinor;
    instalments.push({ number: k, at: { months: k, days: 0 }, amount: money(amount, principal.currency), principal: money(principalPart, principal.currency), profit: money(profit, principal.currency) });
    balance -= principalPart;
  }
  const totalPayable = instalments.reduce((s, x) => s + x.amount.minorUnits, 0n);
  const totalProfit = instalments.reduce((s, x) => s + x.profit.minorUnits, 0n);
  return ok({ instalments, totalPayable: money(totalPayable, principal.currency), totalProfit: money(totalProfit, principal.currency) });
}

/** A fixed total split into equal instalments at a fixed interval; the remainder on the last. */
export function flatInstalments(principal: Money, totalProfit: Money, count: number, intervalDays: number): Result<Schedule> {
  if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(intervalDays) || intervalDays <= 0) return reject('PLAT-02', 'SCHEDULE_SHAPE', 'count and intervalDays are positive integers');
  if (totalProfit.minorUnits < 0n || principal.minorUnits <= 0n) return reject('PLAT-02', 'SCHEDULE_AMOUNTS', 'principal positive, profit non-negative');
  const n = BigInt(count);
  const total = principal.minorUnits + totalProfit.minorUnits;
  const base = total / n;
  const baseP = principal.minorUnits / n;
  const baseF = totalProfit.minorUnits / n;
  const instalments: Instalment[] = Array.from({ length: count }, (_, idx) => {
    const last = idx === count - 1;
    const amount = last ? total - base * (n - 1n) : base;
    const principalPart = last ? principal.minorUnits - baseP * (n - 1n) : baseP;
    const profit = last ? totalProfit.minorUnits - baseF * (n - 1n) : baseF;
    return { number: idx + 1, at: { months: 0, days: intervalDays * (idx + 1) }, amount: money(amount, principal.currency), principal: money(principalPart, principal.currency), profit: money(profit, principal.currency) };
  });
  return ok({ instalments, totalPayable: money(total, principal.currency), totalProfit });
}

/** The cash flows the APR is computed from: the drawdown, every instalment, every fee. */
export function cashFlows(principal: Money, schedule: Schedule, upfrontFees: readonly Money[] = []): readonly CashFlow[] {
  return [
    { at: { months: 0, days: 0 }, amount: principal, direction: 'DRAWDOWN' },
    ...upfrontFees.filter((f) => f.minorUnits > 0n).map((f) => ({ at: { months: 0, days: 0 }, amount: f, direction: 'REPAYMENT' as const })),
    ...schedule.instalments.map((x) => ({ at: x.at, amount: x.amount, direction: 'REPAYMENT' as const })),
  ];
}
