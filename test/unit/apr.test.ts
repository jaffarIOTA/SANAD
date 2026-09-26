/**
 * APR golden tests — cases whose answers are known analytically, to the bp.
 *
 * The SAMA annex worked examples are to be added here from the current
 * rulebook with their article cited (CLAUDE.md §3, §11). Until then these
 * pin the arithmetic: the platform reproduces the closed-form answer, in
 * integers, without a float.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeApr, type CashFlow } from '@sanad/core/pricing/apr.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

const draw = (amount: bigint, months = 0, days = 0): CashFlow => ({ at: { months, days }, amount: money(amount), direction: 'DRAWDOWN' });
const pay = (amount: bigint, months = 0, days = 0): CashFlow => ({ at: { months, days }, amount: money(amount), direction: 'REPAYMENT' });

describe('computeApr', () => {
  it('1 000 advanced, 1 100 repaid after one year → 10.00%', () => {
    expect(expectOk(computeApr([draw(100_000n), pay(110_000n, 12)])).bp).toBe(1_000n);
  });
  it('1 000 advanced, 1 100 repaid after two years → (1.1)^(1/2) − 1 = 4.88%', () => {
    expect(expectOk(computeApr([draw(100_000n), pay(110_000n, 24)])).bp).toBe(488n);
  });
  it('1 000 advanced, 1 210 repaid after two years → exactly 10.00%', () => {
    expect(expectOk(computeApr([draw(100_000n), pay(121_000n, 24)])).bp).toBe(1_000n);
  });
  it('twelve equal monthly instalments at 1% a month → 12.68% effective', () => {
    // Payment for 100 000 over 12 months at 1%/month: 8 884.88 (rounded to minor units).
    const flows = [draw(10_000_000n), ...Array.from({ length: 12 }, (_, i) => pay(888_488n, i + 1))];
    expect(expectOk(computeApr(flows)).bp).toBe(1_268n);
  });
  it('a 365-day tenor and a 12-month tenor are the same year', () => {
    const byMonths = expectOk(computeApr([draw(100_000n), pay(110_000n, 12)])).bp;
    const byDays = expectOk(computeApr([draw(100_000n), pay(110_000n, 0, 365)])).bp;
    expect(byDays).toBe(byMonths);
  });
  it('an upfront fee raises the APR above the nominal rate', () => {
    // 1 000 advanced, 20 fee taken on day 0, 1 100 repaid after a year: effectively 980 → 1 100 = 12.24%.
    const r = expectOk(computeApr([draw(100_000n), pay(2_000n), pay(110_000n, 12)]));
    expect(r.bp).toBe(1_224n);
  });
  it('zero-cost BNPL is 0.00%', () => {
    expect(expectOk(computeApr([draw(300_000n), pay(100_000n, 1), pay(100_000n, 2), pay(100_000n, 3)])).bp).toBe(0n);
  });
  it('refuses a schedule that repays less than was advanced, or without both sides', () => {
    expect(computeApr([draw(100_000n), pay(90_000n, 12)]).ok).toBe(false);
    expect(computeApr([draw(100_000n)]).ok).toBe(false);
  });
});

describe('the APR module is integer arithmetic', () => {
  const src = readFileSync(fileURLToPath(new URL('../../core/pricing/apr.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  it('uses no float helper', () => {
    expect(src).not.toMatch(/\bMath\.\w+/); expect(src).not.toMatch(/\bparseFloat\b|\btoFixed\b/);
  });
  it('types no amount or rate as number', () => {
    expect(src).not.toMatch(/\b(bp|amount|minorUnits)\s*:\s*number\b/);
  });
});
