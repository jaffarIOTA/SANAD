/**
 * The schedule an executed Murabaha books (products/murabaha-scf/index.ts,
 * `repaymentSchedule`): the same split the quote disclosed, dated from the
 * maturity stored at opening by integer civil-date arithmetic — no Date, so
 * no clock — and summing exactly to the fixed sale price.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { repaymentSchedule } from '@sanad/products/murabaha-scf/index.ts';
import { priceMurabaha } from '@sanad/products/murabaha-scf/pricing/murabaha.ts';

const pricing = expectOk(priceMurabaha(money(9_800_000n), money(136_933n)));
const hijri = (iso: string) => `h:${iso}`;
const bullet = { instalments: 'BULLET', structureCode: 'MURABAHA', maxTenorDays: 180 } as const;

/** The reference: civil dates through UTC milliseconds, as a test may compute them. */
const plusDays = (iso: string, days: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe('the repayment schedule a Murabaha books', () => {
  it('a bullet falls due on the maturity, for the whole sale price', () => {
    expect(repaymentSchedule(bullet, pricing, 60, '2026-12-17', hijri)).toEqual([
      {
        sequenceNumber: 1,
        dueDateGregorian: '2026-12-17',
        dueDateHijri: 'h:2026-12-17',
        amount: pricing.salePriceAmount,
      },
    ]);
  });

  it('instalments sum exactly to the sale price, the remainder on the last, the last on the maturity', () => {
    const s = repaymentSchedule({ ...bullet, instalments: { count: 3 } }, pricing, 90, '2027-03-01', hijri);
    expect(s.map((i) => i.sequenceNumber)).toEqual([1, 2, 3]);
    expect(s.reduce((t, i) => t + i.amount.minorUnits, 0n)).toBe(pricing.salePriceAmount.minorUnits);
    expect(s.at(-1)?.dueDateGregorian).toBe('2027-03-01');
    // 2027-03-01 less 90 days is 2026-12-01; then every 30 days.
    expect(s.map((i) => i.dueDateGregorian)).toEqual(['2026-12-31', '2027-01-30', '2027-03-01']);
    expect(s[0]?.amount.minorUnits).toBe(pricing.salePriceAmount.minorUnits / 3n);
  });

  it('dates agree with calendar arithmetic across month ends and leap years', () => {
    for (const [maturity, tenor] of [
      ['2028-03-01', 30],
      ['2024-02-29', 365],
      ['2100-03-01', 2],
      ['2030-01-01', 1],
    ] as const) {
      const s = repaymentSchedule({ ...bullet, instalments: { count: 2 } }, pricing, tenor, maturity, hijri);
      const start = plusDays(maturity, -tenor);
      expect(s[0]?.dueDateGregorian).toBe(plusDays(start, Math.floor(tenor / 2)));
      expect(s[1]?.dueDateGregorian).toBe(maturity);
    }
  });
});
