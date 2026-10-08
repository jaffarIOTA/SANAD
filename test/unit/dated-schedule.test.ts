/**
 * Dated ACT/365 amortising schedule — golden test against a core-banking
 * system's own output (AED 2,000,000.00, 150 bp reducing, 60 instalments on
 * the 10th, disbursed 2029-08-04, first due 2029-09-10), reproduced to the fil.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { computeApr } from '@sanad/core/pricing/apr.ts';
import { type DatedScheduleInput, datedAmortisingSchedule } from '@sanad/core/pricing/dated-schedule.ts';
import { rate } from '@sanad/core/pricing/rate.ts';

const golden: DatedScheduleInput = {
  principal: money(200_000_000n, 'AED'),
  annualRate: rate(150n, 'REDUCING'),
  disbursementDate: '2029-08-04',
  firstDueDate: '2029-09-10',
  numberOfPayments: 60,
  paymentDay: 10,
};

type Expected = [number, bigint, bigint, bigint, bigint | null, bigint];
// [row, opening, principal, interest, instalment, closing] in minor units (fils)
const tuumRows: Expected[] = [
  [1, 200_000_000n, 3_158_808n, 304_110n, 3_462_918n, 196_841_192n],
  [2, 196_841_192n, 3_220_237n, 242_681n, 3_462_918n, 193_620_955n],
  [3, 193_620_955n, 3_216_250n, 246_668n, null, 190_404_705n],
  [4, 190_404_705n, 3_228_172n, 234_746n, null, 187_176_533n],
  [5, 187_176_533n, 3_224_460n, 238_458n, null, 183_952_073n],
  [58, 10_362_609n, 3_449_716n, 13_202n, null, 6_912_893n],
  [59, 6_912_893n, 3_454_395n, 8_523n, null, 3_458_498n],
  [60, 3_458_498n, 3_458_498n, 4_406n, 3_462_904n, 0n],
];

describe('datedAmortisingSchedule — golden (core-banking output, AED, conventional)', () => {
  const s = expectOk(datedAmortisingSchedule(golden));

  it('first period is 37 days and the level instalment is 34,629.18', () => {
    expect(s.rows[0]?.days).toBe(37);
    expect(s.rows[0]?.dueDate).toBe('2029-09-10');
    expect(s.levelInstalment.minorUnits).toBe(3_462_918n);
    expect(s.dayCount).toBe('ACT/365');
  });

  it.each(tuumRows)('row %i matches to the fil', (n, opening, principal, interest, instalment, closing) => {
    const r = s.rows[n - 1];
    expect(r?.number).toBe(n);
    expect(r?.openingBalance.minorUnits).toBe(opening);
    expect(r?.principal.minorUnits).toBe(principal);
    expect(r?.interest.minorUnits).toBe(interest);
    expect(r?.instalment.minorUnits).toBe(instalment ?? principal + interest);
    expect(r?.closingBalance.minorUnits).toBe(closing);
  });

  it('due dates: row 58 on 2034-06-10, row 60 on 2034-08-10', () => {
    expect(s.rows[57]?.dueDate).toBe('2034-06-10');
    expect(s.rows[59]?.dueDate).toBe('2034-08-10');
  });

  it('every amortising row but the last pays the level instalment', () => {
    expect(s.rows.slice(0, 59).every((r) => r.instalment.minorUnits === 3_462_918n)).toBe(true);
  });

  it('totals: principal 2,000,000.00, interest 77,750.66, payable 2,077,750.66', () => {
    expect(s.totalPrincipal.minorUnits).toBe(200_000_000n);
    expect(s.totalInterest.minorUnits).toBe(7_775_066n);
    expect(s.totalPayable.minorUnits).toBe(207_775_066n);
  });

  it('currency is preserved: AED in, AED out', () => {
    expect(
      s.rows.every((r) =>
        [r.openingBalance, r.principal, r.interest, r.instalment, r.closingBalance].every((m) => m.currency === 'AED'),
      ),
    ).toBe(true);
    expect(s.totalPayable.currency).toBe('AED');
    expect(s.cashFlows.every((f) => f.amount.currency === 'AED')).toBe(true);
  });

  it('cash flows feed the platform APR: drawdown at zero, first repayment at 1 month 6 days', () => {
    expect(s.cashFlows[0]).toEqual({
      at: { months: 0, days: 0 },
      amount: money(200_000_000n, 'AED'),
      direction: 'DRAWDOWN',
    });
    expect(s.cashFlows[1]?.at).toEqual({ months: 1, days: 6 });
    expect(s.cashFlows[60]?.at).toEqual({ months: 60, days: 6 });
    expect(s.cashFlows).toHaveLength(61);
    const apr = expectOk(computeApr(s.cashFlows)).bp;
    // 1.50% nominal, compounded about monthly → about 1.51% effective.
    expect(apr).toBeGreaterThanOrEqual(150n);
    expect(apr).toBeLessThanOrEqual(152n);
  });
});

describe('datedAmortisingSchedule — grace', () => {
  const s = expectOk(datedAmortisingSchedule({ ...golden, graceMonths: 6 }));

  it('six interest-only rows leave the principal untouched', () => {
    for (const r of s.rows.slice(0, 6)) {
      expect(r.grace).toBe(true);
      expect(r.principal.minorUnits).toBe(0n);
      expect(r.instalment.minorUnits).toBe(r.interest.minorUnits);
      expect(r.openingBalance.minorUnits).toBe(200_000_000n);
      expect(r.closingBalance.minorUnits).toBe(200_000_000n);
    }
    expect(s.rows[0]?.interest.minorUnits).toBe(304_110n); // same 37-day first period
  });

  it('then amortises over the remaining 54 to exactly zero with a level instalment', () => {
    const amortising = s.rows.slice(6);
    expect(amortising).toHaveLength(54);
    expect(amortising.every((r) => !r.grace)).toBe(true);
    expect(amortising.slice(0, 53).every((r) => r.instalment.minorUnits === s.levelInstalment.minorUnits)).toBe(true);
    const last = s.rows[59];
    expect(last?.closingBalance.minorUnits).toBe(0n);
    expect(last?.instalment.minorUnits).toBeLessThanOrEqual(s.levelInstalment.minorUnits);
    expect(s.totalPrincipal.minorUnits).toBe(200_000_000n);
    expect(s.totalPayable.minorUnits).toBe(s.rows.reduce((t, r) => t + r.instalment.minorUnits, 0n));
    // a longer effective tenor at the same balance costs more interest
    expect(s.totalInterest.minorUnits).toBeGreaterThan(7_775_066n);
  });

  it('the level is the smallest one whose final instalment does not exceed it', () => {
    expect(s.levelInstalment.minorUnits).toBeGreaterThan(3_462_918n);
  });
});

describe('datedAmortisingSchedule — refusals', () => {
  const reason = (i: DatedScheduleInput): string | undefined => {
    const r = datedAmortisingSchedule(i);
    return r.ok ? undefined : r.error.reason;
  };

  it('refuses a non-positive principal', () => {
    expect(reason({ ...golden, principal: money(0n, 'AED') })).toBe('SCHEDULE_PRINCIPAL');
    expect(reason({ ...golden, principal: money(-1n, 'AED') })).toBe('SCHEDULE_PRINCIPAL');
  });
  it('refuses a first due date on or before disbursement', () => {
    expect(reason({ ...golden, disbursementDate: '2029-09-11' })).toBe('SCHEDULE_FIRST_DUE');
    expect(reason({ ...golden, disbursementDate: '2029-09-10' })).toBe('SCHEDULE_FIRST_DUE');
  });
  it('refuses zero instalments', () => {
    expect(reason({ ...golden, numberOfPayments: 0 })).toBe('SCHEDULE_COUNT');
  });
  it('refuses grace equal to or above the instalment count', () => {
    expect(reason({ ...golden, graceMonths: 60 })).toBe('SCHEDULE_GRACE');
    expect(reason({ ...golden, graceMonths: 61 })).toBe('SCHEDULE_GRACE');
  });
  it('refuses malformed dates, a first due date off the payment day, and a non-reducing rate', () => {
    expect(reason({ ...golden, firstDueDate: '2029-02-30' })).toBe('SCHEDULE_DATE');
    expect(reason({ ...golden, paymentDay: 15 })).toBe('SCHEDULE_FIRST_DUE_DAY');
    expect(reason({ ...golden, annualRate: rate(150n, 'FLAT') })).toBe('SCHEDULE_RATE_SHAPE');
  });
});

describe('datedAmortisingSchedule — calendar', () => {
  it('clamps a 31st payment day to month end and counts actual days', () => {
    const s = expectOk(
      datedAmortisingSchedule({
        ...golden,
        principal: money(1_200_000n, 'SAR'),
        disbursementDate: '2028-01-01',
        firstDueDate: '2028-01-31',
        numberOfPayments: 3,
        paymentDay: 31,
      }),
    );
    expect(s.rows.map((r) => r.dueDate)).toEqual(['2028-01-31', '2028-02-29', '2028-03-31']);
    expect(s.rows.map((r) => r.days)).toEqual([30, 29, 31]);
    expect(s.rows[2]?.closingBalance.minorUnits).toBe(0n);
    expect(s.totalPayable.currency).toBe('SAR');
  });
  it('a single instalment repays principal plus its interest', () => {
    const s = expectOk(datedAmortisingSchedule({ ...golden, numberOfPayments: 1 }));
    expect(s.rows[0]?.instalment.minorUnits).toBe(200_000_000n + 304_110n);
    expect(s.rows[0]?.closingBalance.minorUnits).toBe(0n);
  });
  it('a zero rate splits the principal with the remainder last', () => {
    const s = expectOk(
      datedAmortisingSchedule({
        ...golden,
        principal: money(1_000n, 'AED'),
        annualRate: rate(0n, 'REDUCING'),
        numberOfPayments: 3,
      }),
    );
    expect(s.rows.map((r) => r.instalment.minorUnits)).toEqual([334n, 334n, 332n]);
  });
});
