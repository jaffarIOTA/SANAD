/**
 * Servicing S1 — a facility's position against its signed schedule, pure:
 * oldest instalment first, charge before principal; due today is due, not
 * late; days past due from the oldest overdue instalment; paid ahead and
 * overpaid kept apart; integer civil-date arithmetic.
 */
import { describe, expect, it } from 'vitest';

import { money } from '../../core/kernel/money.ts';
import { civilDay, delinquencyBucket, facilityPosition } from '../../core/servicing/instalment-position.ts';

const sar = (v: bigint) => money(v, 'SAR');
// Three instalments of 1,000.00: 100.00 charge + 900.00 principal each.
const schedule = [1, 2, 3].map((n) => ({
  number: n,
  dueDate: `2027-0${String(n)}-10`,
  principal: sar(90_000n),
  charge: sar(10_000n),
}));
const pay = (id: string, receivedOn: string, minor: bigint) => ({ repaymentId: id, receivedOn, amount: sar(minor) });

describe('civil days', () => {
  it('counts days without a clock, across months and leap years', () => {
    expect(civilDay('1970-01-01')).toBe(0);
    expect((civilDay('2028-03-01') ?? 0) - (civilDay('2028-02-28') ?? 0)).toBe(2);
    expect((civilDay('2027-03-01') ?? 0) - (civilDay('2027-02-28') ?? 0)).toBe(1);
    expect(civilDay('2027-13-01')).toBeUndefined();
  });
});

describe('the position', () => {
  it('nothing paid: the first instalment is due on its day and overdue the day after', () => {
    expect(facilityPosition(schedule, [], '2027-01-10', 'SAR').instalments[0]?.state).toBe('DUE');
    const late = facilityPosition(schedule, [], '2027-01-11', 'SAR');
    expect(late.instalments[0]?.state).toBe('OVERDUE');
    expect(late.daysPastDue).toBe(1);
    expect(late.arrears.minorUnits).toBe(100_000n);
  });

  it('allocates oldest first, charge before principal', () => {
    const p = facilityPosition(schedule, [pay('r1', '2027-01-10', 150_000n)], '2027-02-11', 'SAR');
    expect(p.instalments[0]).toMatchObject({ state: 'PAID' });
    expect(p.instalments[1]).toMatchObject({ state: 'OVERDUE', paidCharge: sar(10_000n), paidPrincipal: sar(40_000n), outstanding: sar(50_000n) });
    expect(p.arrears.minorUnits).toBe(50_000n);
    expect(p.daysPastDue).toBe(1);
    expect(p.outstandingPrincipal.minorUnits).toBe(270_000n - 90_000n - 40_000n);
  });

  it('counts days past due from the oldest overdue instalment', () => {
    const p = facilityPosition(schedule, [], '2027-03-15', 'SAR');
    expect(p.daysPastDue).toBe((civilDay('2027-03-15') ?? 0) - (civilDay('2027-01-10') ?? 0));
    expect(p.arrears.minorUnits).toBe(300_000n);
    expect(delinquencyBucket(p.daysPastDue)).toBe('60-89');
  });

  it('ignores a receipt dated after the day; pays ahead before overpaying', () => {
    expect(facilityPosition(schedule, [pay('r1', '2027-02-01', 100_000n)], '2027-01-20', 'SAR').totalPaid.minorUnits).toBe(0n);
    const ahead = facilityPosition(schedule, [pay('r1', '2027-01-05', 250_000n)], '2027-01-20', 'SAR');
    expect(ahead.instalments.map((i) => i.state)).toEqual(['PAID', 'PAID', 'PART_PAID']);
    expect(ahead.nextDue).toMatchObject({ number: 3, outstanding: sar(50_000n) });
    const over = facilityPosition(schedule, [pay('r1', '2027-01-05', 310_000n)], '2027-01-20', 'SAR');
    expect(over.overpaid.minorUnits).toBe(10_000n);
    expect(over.outstandingTotal.minorUnits).toBe(0n);
    expect(over.nextDue).toBeUndefined();
  });

  it('buckets days past due', () => {
    expect([0, 1, 29, 30, 59, 60, 89, 90].map(delinquencyBucket)).toEqual(['CURRENT', '1-29', '1-29', '30-59', '30-59', '60-89', '60-89', '90+']);
  });
});
