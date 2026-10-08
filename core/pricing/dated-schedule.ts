/**
 * Dated amortising schedule — actual/365, level instalment, optional grace.
 *
 * The equal-monthly schedule in `schedule.ts` treats every period as one
 * twelfth of a year. A core-banking loan book does not: it accrues interest
 * on the actual number of calendar days between due dates, divided by 365.
 * This module reproduces that convention so an offer's schedule is the same
 * schedule the core banking system will book, to the minor unit.
 *
 * Conventions (each one is what the golden test in
 * `test/unit/dated-schedule.test.ts` needs to match the core-banking output
 * for AED 2,000,000.00 at 150 bp over 60 instalments, figure for figure):
 *
 *  1. Calendar. Due dates fall on `paymentDay` of each month, clamped to the
 *     last day of a shorter month. The first due date is given; each later
 *     one is the next month's payment day. Dates are ISO calendar dates and
 *     day counts come from a pure civil-day computation — no clock is read.
 *  2. Day count ACT/365. Period k runs from the previous due date (the
 *     disbursement date for k = 1) to due date k. A long or short first
 *     period is simply its actual day count (37 days in the golden case).
 *  3. Interest per period = opening balance × bp × days ÷ (10 000 × 365),
 *     rounded half up to the minor unit (`roundDiv` in rate.ts). Bigint only.
 *  4. Grace. The first `graceMonths` instalments are interest only: the
 *     instalment equals that period's interest and the principal is
 *     unchanged. Amortisation runs over the remaining instalments.
 *  5. Level instalment, found by integer search. Within the amortising
 *     periods every instalment except the last is the same amount X; the
 *     principal part is X − interest. The last instalment is whatever clears
 *     the balance (balance + its interest), so the closing balance is exactly
 *     zero. X is the SMALLEST whole minor-unit amount for which that final
 *     instalment does not exceed X. The final instalment is non-increasing in
 *     X (each step's balance + rounded interest is non-decreasing in the
 *     balance), so the rule is found by bisection. In the golden case
 *     X = 34,629.18 and the final instalment is 34,629.04; at 34,629.17 the
 *     final instalment would be 34,629.66, above the level.
 *
 *     The closed-form annuity (P·i / (1 − (1+i)^−n) at i = bp/12) gives
 *     34,619.78 for the golden case and does NOT match: the actual/365
 *     periods and the long first period both move the level, which is why the
 *     search runs over the dated schedule itself.
 *
 * The output carries `CashFlow[]` in `apr.ts`'s convention — the drawdown as
 * a DRAWDOWN flow at tenor zero, every instalment as a REPAYMENT, amounts
 * positive, tenors as whole months plus remaining days from the disbursement
 * date — so the platform APR (the one function, `computeApr`) is computed
 * from the same dated flows the customer pays.
 *
 * Nothing here is product-specific or institution-specific: the rate, term,
 * payment day and grace arrive from the tenant's term sheet.
 */

import { type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { CashFlow, Tenor } from './apr.ts';
import { BP_PER_UNIT, DAYS_PER_YEAR, type Rate, roundDiv } from './rate.ts';

export interface DatedScheduleInput {
  readonly principal: Money;
  /** Annual, REDUCING basis, integer basis points. */
  readonly annualRate: Rate;
  /** ISO calendar date YYYY-MM-DD. */
  readonly disbursementDate: string;
  /** ISO calendar date YYYY-MM-DD; must fall on `paymentDay` (clamped to month end). */
  readonly firstDueDate: string;
  /** Number of instalments, grace instalments included. */
  readonly numberOfPayments: number;
  /** Day of month 1–31; clamped to the last day of a shorter month. */
  readonly paymentDay: number;
  /** Interest-only instalments before amortisation begins. Default 0. */
  readonly graceMonths?: number;
}

export interface DatedRow {
  readonly number: number;
  /** ISO calendar date YYYY-MM-DD. */
  readonly dueDate: string;
  /** Actual days in the period (ACT/365 numerator). */
  readonly days: number;
  readonly openingBalance: Money;
  readonly principal: Money;
  readonly interest: Money;
  readonly instalment: Money;
  readonly closingBalance: Money;
  readonly grace: boolean;
}

export interface DatedSchedule {
  readonly dayCount: 'ACT/365';
  readonly rows: readonly DatedRow[];
  /** The level instalment of the amortising periods (the last may be lower). */
  readonly levelInstalment: Money;
  readonly totalPrincipal: Money;
  readonly totalInterest: Money;
  readonly totalPayable: Money;
  /** APR-ready flows, `computeApr` convention (core/pricing/apr.ts). */
  readonly cashFlows: readonly CashFlow[];
}

// -- calendar (pure integer civil-date arithmetic, no clock) ------------------

interface CivilDate {
  readonly y: number;
  readonly m: number; // 1–12
  readonly d: number; // 1–31
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function parseIso(s: string): CivilDate | undefined {
  const match = ISO_DATE.exec(s);
  if (!match) return undefined;
  const y = Number.parseInt(match[1] as string, 10);
  const m = Number.parseInt(match[2] as string, 10);
  const d = Number.parseInt(match[3] as string, 10);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return undefined;
  return { y, m, d };
}

function formatIso(c: CivilDate): string {
  return `${String(c.y).padStart(4, '0')}-${String(c.m).padStart(2, '0')}-${String(c.d).padStart(2, '0')}`;
}

/** Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant's days_from_civil). */
function dayNumber(c: CivilDate): number {
  const y = c.m <= 2 ? c.y - 1 : c.y;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (c.m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + c.d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The given month shifted by k months, on `day` clamped to that month's end. */
function monthPlus(base: CivilDate, k: number, day: number): CivilDate {
  const idx = base.y * 12 + (base.m - 1) + k;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return { y, m, d: Math.min(day, daysInMonth(y, m)) };
}

/** Whole months from `from` to `to` (day clamped), then the remaining days. */
function tenorBetween(from: CivilDate, to: CivilDate): Tenor {
  let months = (to.y - from.y) * 12 + (to.m - from.m);
  if (months > 0 && dayNumber(monthPlus(from, months, from.d)) > dayNumber(to)) months -= 1;
  if (months < 0) months = 0;
  const anchor = monthPlus(from, months, from.d);
  return { months, days: dayNumber(to) - dayNumber(anchor) };
}

// -- schedule -----------------------------------------------------------------

interface Period {
  readonly due: CivilDate;
  readonly days: bigint;
}

const YEAR_BP = BP_PER_UNIT * DAYS_PER_YEAR;

function interestFor(balance: bigint, bp: bigint, days: bigint): bigint {
  return roundDiv(balance * bp * days, YEAR_BP);
}

/** Final instalment (balance + interest) when every earlier amortising instalment is `level`. */
function finalInstalment(opening: bigint, bp: bigint, periods: readonly Period[], level: bigint): bigint {
  let balance = opening;
  const lastIdx = periods.length - 1;
  for (let k = 0; k < lastIdx; k += 1) {
    const p = periods[k] as Period;
    balance -= level - interestFor(balance, bp, p.days);
  }
  return balance + interestFor(balance, bp, (periods[lastIdx] as Period).days);
}

/** Smallest level X with finalInstalment(X) ≤ X (convention 5 in the header). */
function searchLevel(opening: bigint, bp: bigint, periods: readonly Period[]): bigint {
  if (periods.length === 1) return finalInstalment(opening, bp, periods, 0n);
  // Upper bound: the whole balance plus interest on it for every period clears it in one instalment.
  let hi = opening + periods.reduce((s, p) => s + interestFor(opening, bp, p.days), 0n);
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (finalInstalment(opening, bp, periods, mid) <= mid) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

interface Validated {
  readonly disbursed: CivilDate;
  readonly firstDue: CivilDate;
  readonly graceMonths: number;
}

function validate(input: DatedScheduleInput): Result<Validated> {
  const { principal, annualRate, numberOfPayments, paymentDay } = input;
  const graceMonths = input.graceMonths ?? 0;
  if (principal.minorUnits <= 0n) return reject('PLAT-02', 'SCHEDULE_PRINCIPAL', 'principal must be positive');
  if (annualRate.period !== 'ANNUAL' || annualRate.basis !== 'REDUCING') {
    return reject('PLAT-02', 'SCHEDULE_RATE_SHAPE', 'datedAmortisingSchedule takes an annual REDUCING rate');
  }
  if (annualRate.bp < 0n) return reject('PLAT-02', 'SCHEDULE_RATE_NEGATIVE', 'A negative rate is not a schedule');
  if (!Number.isInteger(numberOfPayments) || numberOfPayments <= 0) {
    return reject('PLAT-02', 'SCHEDULE_COUNT', 'numberOfPayments is a positive integer');
  }
  if (!Number.isInteger(graceMonths) || graceMonths < 0 || graceMonths >= numberOfPayments) {
    return reject('PLAT-02', 'SCHEDULE_GRACE', 'graceMonths is a non-negative integer below numberOfPayments');
  }
  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) {
    return reject('PLAT-02', 'SCHEDULE_PAYMENT_DAY', 'paymentDay is a day of month 1–31');
  }
  const disbursed = parseIso(input.disbursementDate);
  const firstDue = parseIso(input.firstDueDate);
  if (!disbursed || !firstDue) return reject('PLAT-02', 'SCHEDULE_DATE', 'Dates are ISO calendar dates YYYY-MM-DD');
  if (dayNumber(firstDue) <= dayNumber(disbursed)) {
    return reject('PLAT-02', 'SCHEDULE_FIRST_DUE', 'The first due date must fall after the disbursement date');
  }
  if (firstDue.d !== Math.min(paymentDay, daysInMonth(firstDue.y, firstDue.m))) {
    return reject('PLAT-02', 'SCHEDULE_FIRST_DUE_DAY', 'The first due date must fall on the payment day');
  }
  return ok({ disbursed, firstDue, graceMonths });
}

/** Principal part of row k: none in grace, the whole balance on the last row, else level − interest. */
function principalPartOf(k: number, count: number, graceMonths: number, balance: bigint, level: bigint, interest: bigint): bigint {
  if (k < graceMonths) return 0n;
  if (k === count - 1) return balance;
  return level - interest;
}

export function datedAmortisingSchedule(input: DatedScheduleInput): Result<DatedSchedule> {
  const checked = validate(input);
  if (!checked.ok) return checked;
  const { disbursed, firstDue, graceMonths } = checked.value;
  const { principal, annualRate, numberOfPayments, paymentDay } = input;
  const currency = principal.currency;

  const periods: Period[] = [];
  let previous = dayNumber(disbursed);
  for (let k = 0; k < numberOfPayments; k += 1) {
    const due = k === 0 ? firstDue : monthPlus(firstDue, k, paymentDay);
    const today = dayNumber(due);
    periods.push({ due, days: BigInt(today - previous) });
    previous = today;
  }

  const bp = annualRate.bp;
  const opening = principal.minorUnits;
  const amortising = periods.slice(graceMonths);
  const level = searchLevel(opening, bp, amortising);

  const rows: DatedRow[] = [];
  let balance = opening;
  for (let k = 0; k < numberOfPayments; k += 1) {
    const p = periods[k] as Period;
    const interest = interestFor(balance, bp, p.days);
    const grace = k < graceMonths;
    const principalPart = principalPartOf(k, numberOfPayments, graceMonths, balance, level, interest);
    const instalment = principalPart + interest;
    const closing = balance - principalPart;
    if (closing < 0n || principalPart < 0n) {
      return reject('PLAT-02', 'SCHEDULE_NOT_AMORTISING', 'The level instalment does not amortise this balance over these periods');
    }
    rows.push({
      number: k + 1,
      dueDate: formatIso(p.due),
      days: Number(p.days),
      openingBalance: money(balance, currency),
      principal: money(principalPart, currency),
      interest: money(interest, currency),
      instalment: money(instalment, currency),
      closingBalance: money(closing, currency),
      grace,
    });
    balance = closing;
  }

  const totalPrincipal = rows.reduce((s, r) => s + r.principal.minorUnits, 0n);
  const totalInterest = rows.reduce((s, r) => s + r.interest.minorUnits, 0n);
  const cashFlows: CashFlow[] = [
    { at: { months: 0, days: 0 }, amount: principal, direction: 'DRAWDOWN' },
    ...rows
      .filter((r) => r.instalment.minorUnits > 0n)
      .map((r) => ({
        at: tenorBetween(disbursed, (periods[r.number - 1] as Period).due),
        amount: r.instalment,
        direction: 'REPAYMENT' as const,
      })),
  ];

  return ok({
    dayCount: 'ACT/365',
    rows,
    levelInstalment: money(level, currency),
    totalPrincipal: money(totalPrincipal, currency),
    totalInterest: money(totalInterest, currency),
    totalPayable: money(totalPrincipal + totalInterest, currency),
    cashFlows,
  });
}
