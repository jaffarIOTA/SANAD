/**
 * A consumer loan's due dates as the plan was disclosed (services/origination/src/consumer-loans.ts): the
 * dates the booking checks the loan system's schedule against, and the dates the workbench offers.
 */
import { describe, expect, it } from 'vitest';

import { dueDatesOf } from '@sanad/origination/consumer-loans.ts';

describe('the due dates of a consumer loan', () => {
  it('every so many days from the first due date', () => {
    expect(dueDatesOf({ firstDueDate: '2026-12-02', numberOfInstalments: 4, intervalDays: 30 })).toEqual([
      '2026-12-02',
      '2027-01-01',
      '2027-01-31',
      '2027-03-02',
    ]);
  });

  it('monthly on the first due date’s day of the month', () => {
    expect(dueDatesOf({ firstDueDate: '2026-12-03', numberOfInstalments: 4, intervalMonths: 1 })).toEqual([
      '2026-12-03',
      '2027-01-03',
      '2027-02-03',
      '2027-03-03',
    ]);
  });

  it('on the month’s last day when the month is shorter, and back on the day after it', () => {
    expect(dueDatesOf({ firstDueDate: '2027-01-31', numberOfInstalments: 4, intervalMonths: 1 })).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
    ]);
  });

  it('every two months across a year end', () => {
    expect(dueDatesOf({ firstDueDate: '2026-11-15', numberOfInstalments: 3, intervalMonths: 2 })).toEqual([
      '2026-11-15',
      '2027-01-15',
      '2027-03-15',
    ]);
  });
});
