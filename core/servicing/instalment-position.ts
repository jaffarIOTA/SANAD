/**
 * Where a disbursed facility stands against its signed schedule (Servicing
 * S1): each instalment paid, part-paid, due or overdue; the arrears; the days
 * past due; what is still owed.
 *
 * Pure and product-agnostic: the schedule is the signed offer's dated
 * schedule (interest for a term loan, profit for a Tawarruq — the same
 * column), the repayments are the confirmed receipts. Integer arithmetic only:
 * amounts are minor units, dates are civil dates (yyyy-mm-dd) turned into day
 * numbers without a clock.
 *
 * Allocation: a repayment goes to the oldest unpaid instalment first, and
 * within an instalment to its charge before its principal. Money beyond what
 * is due on the day settles the next instalments in order (paid ahead); a
 * prepayment that changes the schedule is a restructuring (S3), not this.
 *
 * An instalment is overdue the day after its due date: a payment due today is
 * due, not late. Days past due count from the oldest overdue instalment.
 */
import { type CurrencyCode, type Money, money } from '../kernel/money.ts';

export interface ScheduledInstalment {
  readonly number: number;
  /** yyyy-mm-dd. */
  readonly dueDate: string;
  readonly principal: Money;
  /** Interest (term loan) or profit (Tawarruq). */
  readonly charge: Money;
}

export interface Repayment {
  readonly repaymentId: string;
  /** yyyy-mm-dd: the value date the money was received. */
  readonly receivedOn: string;
  readonly amount: Money;
}

export type InstalmentState = 'PAID' | 'PART_PAID' | 'DUE' | 'OVERDUE' | 'FUTURE';

export interface InstalmentPosition {
  readonly number: number;
  readonly dueDate: string;
  readonly amount: Money;
  readonly paid: Money;
  readonly paidCharge: Money;
  readonly paidPrincipal: Money;
  readonly outstanding: Money;
  readonly state: InstalmentState;
}

export interface FacilityPosition {
  readonly asOf: string;
  readonly instalments: readonly InstalmentPosition[];
  /** Overdue and unpaid, on the day. */
  readonly arrears: Money;
  /** Days since the oldest overdue instalment fell due; 0 when nothing is overdue. */
  readonly daysPastDue: number;
  readonly totalPaid: Money;
  /** Principal not yet repaid. */
  readonly outstandingPrincipal: Money;
  /** Everything still owed, due or not. */
  readonly outstandingTotal: Money;
  /** Received beyond everything owed (a refund owed to the customer); normally zero. */
  readonly overpaid: Money;
  /** The next instalment not yet paid in full, if any. */
  readonly nextDue?: { readonly number: number; readonly dueDate: string; readonly outstanding: Money };
}

/** Days since 1970-01-01 for a civil date (Hinnant's days-from-civil), or undefined if malformed. */
export function civilDay(iso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return undefined;
  let y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  y -= mo <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

const sum = (xs: readonly bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

export function facilityPosition(
  schedule: readonly ScheduledInstalment[],
  repayments: readonly Repayment[],
  asOf: string,
  currency: CurrencyCode,
): FacilityPosition {
  const today = civilDay(asOf) ?? 0;
  const m = (v: bigint): Money => money(v, currency);
  // Receipts in value-date order; only those received on or before the day count.
  const received = sum(
    [...repayments]
      .filter((r) => (civilDay(r.receivedOn) ?? Number.MAX_SAFE_INTEGER) <= today)
      .map((r) => r.amount.minorUnits),
  );
  let pool = received;
  const instalments: InstalmentPosition[] = [];
  for (const row of [...schedule].sort((a, b) => a.number - b.number)) {
    const charge = row.charge.minorUnits;
    const principal = row.principal.minorUnits;
    const toCharge = pool < charge ? pool : charge;
    pool -= toCharge;
    const toPrincipal = pool < principal ? pool : principal;
    pool -= toPrincipal;
    const amount = charge + principal;
    const paid = toCharge + toPrincipal;
    const due = civilDay(row.dueDate) ?? 0;
    const state: InstalmentState =
      paid === amount ? 'PAID' : due < today ? 'OVERDUE' : due === today ? 'DUE' : paid > 0n ? 'PART_PAID' : 'FUTURE';
    instalments.push({
      number: row.number,
      dueDate: row.dueDate,
      amount: m(amount),
      paid: m(paid),
      paidCharge: m(toCharge),
      paidPrincipal: m(toPrincipal),
      outstanding: m(amount - paid),
      state,
    });
  }
  const overdue = instalments.filter((i) => i.state === 'OVERDUE');
  const oldest = overdue[0];
  const next = instalments.find((i) => i.state !== 'PAID');
  return {
    asOf,
    instalments,
    arrears: m(sum(overdue.map((i) => i.outstanding.minorUnits))),
    daysPastDue: oldest === undefined ? 0 : today - (civilDay(oldest.dueDate) ?? today),
    totalPaid: m(received - pool),
    outstandingPrincipal: m(
      sum(schedule.map((r) => r.principal.minorUnits)) - sum(instalments.map((i) => i.paidPrincipal.minorUnits)),
    ),
    outstandingTotal: m(sum(instalments.map((i) => i.outstanding.minorUnits))),
    overpaid: m(pool),
    ...(next === undefined
      ? {}
      : { nextDue: { number: next.number, dueDate: next.dueDate, outstanding: next.outstanding } }),
  };
}

/** The bucket a days-past-due count falls in, as bureaus and provisioning read it. */
export function delinquencyBucket(daysPastDue: number): 'CURRENT' | '1-29' | '30-59' | '60-89' | '90+' {
  if (daysPastDue <= 0) return 'CURRENT';
  if (daysPastDue < 30) return '1-29';
  if (daysPastDue < 60) return '30-59';
  if (daysPastDue < 90) return '60-89';
  return '90+';
}
