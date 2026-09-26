import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { computeApr } from '@sanad/core/pricing/apr.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { cashFlows, flatInstalments, reducingBalanceMonthly } from '@sanad/core/pricing/schedule.ts';

describe('reducing-balance monthly schedule', () => {
  it('100 000 over 12 months at 12% reducing → 8 884.88 a month, sums exact, APR 12.68%', () => {
    const s = expectOk(reducingBalanceMonthly(money(10_000_000n), rate(1_200n, 'REDUCING'), 12));
    expect(s.instalments[0]?.amount.minorUnits).toBe(888_488n);
    expect(s.instalments.reduce((t, x) => t + x.principal.minorUnits, 0n)).toBe(10_000_000n);
    expect(s.totalPayable.minorUnits).toBe(s.instalments.reduce((t, x) => t + x.amount.minorUnits, 0n));
    expect(s.instalments[0]?.profit.minorUnits).toBe(100_000n); // 100 000 × 1%
    expect(expectOk(computeApr(cashFlows(money(10_000_000n), s))).bp).toBe(1_268n);
  });
  it('a zero rate is a straight split', () => {
    const s = expectOk(reducingBalanceMonthly(money(1_000n), rate(0n, 'REDUCING'), 3));
    expect(s.instalments.map((x) => x.amount.minorUnits)).toEqual([333n, 333n, 334n]); expect(s.totalProfit.minorUnits).toBe(0n);
  });
  it('refuses the wrong rate shape', () => {
    expect(reducingBalanceMonthly(money(1_000n), rate(100n, 'FLAT'), 3).ok).toBe(false);
  });
});

describe('flat instalments', () => {
  it('BNPL pay-in-4 at zero cost splits exactly, remainder on the last', () => {
    const s = expectOk(flatInstalments(money(100_001n), money(0n), 4, 30));
    expect(s.instalments.map((x) => x.amount.minorUnits)).toEqual([25_000n, 25_000n, 25_000n, 25_001n]);
    expect(s.instalments[3]?.at.days).toBe(120);
    expect(expectOk(computeApr(cashFlows(money(100_001n), s))).bp).toBe(0n);
  });
  it('an upfront fee appears in the cash flows and lifts the APR', () => {
    const s = expectOk(flatInstalments(money(100_000n), money(0n), 4, 30));
    expect(expectOk(computeApr(cashFlows(money(100_000n), s, [money(1_000n)]))).bp).toBeGreaterThan(0n);
  });
});
