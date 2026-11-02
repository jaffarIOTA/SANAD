/**
 * Restructuring a facility (Servicing S3): what is still owed on the day,
 * arrears included, re-spread over a new run of instalments. Pure.
 *
 * - A term loan is re-amortised on its outstanding principal at its signed
 *   rate (core/pricing/dated-schedule.ts): longer terms cost more interest,
 *   which the approver sees before approving.
 * - A Tawarruq is a debt of a fixed price: the outstanding principal and
 *   profit are re-spread as they are, and the total owed never increases
 *   (products/sme-term-islamic SI-2; the same rule as Murabaha's). The new
 *   due dates come from the same dated-schedule builder at a zero rate.
 */
import { type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import { datedAmortisingSchedule } from '../pricing/dated-schedule.ts';
import { rate } from '../pricing/rate.ts';
import type { ScheduledInstalment } from './instalment-position.ts';

export interface RestructureTerms {
  /** yyyy-mm-dd: the day the new schedule takes over; repayments from then count against it. */
  readonly effectiveDate: string;
  readonly firstDueDate: string;
  readonly numberOfPayments: number;
  readonly paymentDay: number;
}

const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);

function check(t: RestructureTerms, maxPayments: number): Result<true> {
  if (!Number.isInteger(t.numberOfPayments) || t.numberOfPayments < 1 || t.numberOfPayments > maxPayments)
    return bad('RESTRUCTURE_TERMS_INVALID', 'The new schedule has a whole number of instalments within the policy’s limit');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.effectiveDate) || !/^\d{4}-\d{2}-\d{2}$/.test(t.firstDueDate) || t.firstDueDate <= t.effectiveDate)
    return bad('RESTRUCTURE_TERMS_INVALID', 'The first new instalment falls after the effective date');
  return ok(true);
}

/** A term loan: outstanding principal re-amortised at the signed rate. */
export function reamortise(
  outstandingPrincipal: Money,
  annualRateBp: bigint,
  terms: RestructureTerms,
  maxPayments: number,
): Result<readonly ScheduledInstalment[]> {
  const c = check(terms, maxPayments);
  if (!c.ok) return c;
  if (outstandingPrincipal.minorUnits <= 0n) return bad('NOTHING_TO_RESTRUCTURE', 'Nothing is owed');
  const s = datedAmortisingSchedule({
    principal: outstandingPrincipal,
    annualRate: rate(annualRateBp, 'REDUCING'),
    disbursementDate: terms.effectiveDate,
    firstDueDate: terms.firstDueDate,
    numberOfPayments: terms.numberOfPayments,
    paymentDay: terms.paymentDay,
  });
  if (!s.ok) return s;
  return ok(s.value.rows.map((r) => ({ number: r.number, dueDate: r.dueDate, principal: r.principal, charge: r.interest })));
}

/** A deferred-price debt: outstanding principal and profit re-spread; the total owed is exactly what was owed. */
export function respreadPrice(
  outstandingPrincipal: Money,
  outstandingCharge: Money,
  terms: RestructureTerms,
  maxPayments: number,
): Result<readonly ScheduledInstalment[]> {
  const c = check(terms, maxPayments);
  if (!c.ok) return c;
  if (outstandingPrincipal.minorUnits + outstandingCharge.minorUnits <= 0n) return bad('NOTHING_TO_RESTRUCTURE', 'Nothing is owed');
  // Zero rate: the builder gives the dates and the principal split, and adds nothing.
  const s = datedAmortisingSchedule({
    principal: outstandingPrincipal.minorUnits > 0n ? outstandingPrincipal : money(1n, outstandingPrincipal.currency),
    annualRate: rate(0n, 'REDUCING'),
    disbursementDate: terms.effectiveDate,
    firstDueDate: terms.firstDueDate,
    numberOfPayments: terms.numberOfPayments,
    paymentDay: terms.paymentDay,
  });
  if (!s.ok) return s;
  const n = BigInt(s.value.rows.length);
  const share = outstandingCharge.minorUnits / n;
  const rows = s.value.rows.map((r, i) => ({
    number: r.number,
    dueDate: r.dueDate,
    principal: outstandingPrincipal.minorUnits > 0n ? r.principal : money(0n, outstandingPrincipal.currency),
    // The profit in equal shares, the remainder on the last instalment: nothing added, nothing lost.
    charge: money(i === s.value.rows.length - 1 ? outstandingCharge.minorUnits - share * (n - 1n) : share, outstandingCharge.currency),
  }));
  const total = rows.reduce((a, r) => a + r.principal.minorUnits + r.charge.minorUnits, 0n);
  if (total !== outstandingPrincipal.minorUnits + outstandingCharge.minorUnits)
    return reject('SH-02', 'TOTAL_WOULD_CHANGE', 'A deferred-price debt is re-spread without changing what is owed');
  return ok(rows);
}
