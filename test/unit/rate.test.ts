import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { accrue, addBp, rate, rateInForce, roundDiv, snapshot, type RateRecord } from '@sanad/core/pricing/rate.ts';

describe('Rate', () => {
  it('is basis points as bigint with a basis and a period', () => {
    const r = rate(725n, 'REDUCING'); expect(r).toEqual({ bp: 725n, basis: 'REDUCING', period: 'ANNUAL' });
    expect(addBp(r, 150n).bp).toBe(875n);
  });
  it('accrues in integer arithmetic, half up', () => {
    // 100 000.00 at 7.25% for 30 days = 595.89 (595.8904…)
    expect(expectOk(accrue(money(10_000_000n), rate(725n, 'FLAT'), 30n)).minorUnits).toBe(59_589n);
    expect(roundDiv(5n, 2n)).toBe(3n); expect(roundDiv(-5n, 2n)).toBe(-3n); expect(roundDiv(4n, 2n)).toBe(2n);
    expect(accrue(money(1n), rate(1n, 'FLAT', 'MONTHLY'), 1n).ok).toBe(false);
  });
  it('picks the record in force and refuses when none is', () => {
    const records: RateRecord[] = [
      { rate: rate(700n, 'REDUCING'), source: 'TENANT_CATALOGUE', catalogueRef: 'cat-1', effectiveFromEpochSeconds: 100n, effectiveToEpochSeconds: 200n },
      { rate: rate(750n, 'REDUCING'), source: 'RATE_PUBLISHER', publisherReferenceId: 'pub-9', effectiveFromEpochSeconds: 200n },
    ];
    expect(expectOk(rateInForce(records, 150n)).rate.bp).toBe(700n);
    expect(expectOk(rateInForce(records, 200n)).rate.bp).toBe(750n);
    expect(rateInForce(records, 50n).ok).toBe(false);
  });
  it('a snapshot carries the source reference so the price can be reproduced', () => {
    const s = snapshot({ rate: rate(750n, 'REDUCING'), source: 'MANUAL_OVERRIDE', overriddenBy: 'stf-01', approvalRef: 'CC-2026-9', justification: 'relationship pricing', effectiveFromEpochSeconds: 1n }, 5n);
    expect(s).toEqual({ rate: rate(750n, 'REDUCING'), source: 'MANUAL_OVERRIDE', sourceRef: 'CC-2026-9', snapshottedAtEpochSeconds: 5n });
  });
});
