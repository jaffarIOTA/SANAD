/**
 * Late charges on overdue instalments (Servicing S3). Pure.
 *
 * One charge per instalment that has been overdue for longer than the
 * tenant's grace days, at the tenant's amount (configuration, ILLUSTRATIVE
 * until the institution's policy and its regulator's cap are cited). For an
 * Islamic facility the same amount is a charity obligation: collected as a
 * deterrent, paid to charity, never the institution's income (SH-13).
 */
import { type CurrencyCode, type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import { type FacilityPosition, civilDay } from './instalment-position.ts';

export interface ServicingPolicy {
  readonly policyRef: string;
  readonly lateCharge: { readonly graceDays: number; readonly amountMinorUnits: bigint };
  readonly restructuring: { readonly maxPayments: number };
}

export function parseServicingPolicy(raw: unknown): Result<ServicingPolicy> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const lc = (r['lateCharge'] ?? {}) as Record<string, unknown>;
  const rs = (r['restructuring'] ?? {}) as Record<string, unknown>;
  const grace = lc['graceDays'];
  const amount = lc['amountMinorUnits'];
  const max = rs['maxPayments'];
  if (typeof r['policyRef'] !== 'string' || r['policyRef'] === '')
    return reject('OP-DETERMINACY', 'SERVICING_POLICY_INVALID', 'The servicing policy names its source');
  if (typeof grace !== 'number' || !Number.isInteger(grace) || grace < 0 || grace > 90)
    return reject('OP-DETERMINACY', 'SERVICING_POLICY_INVALID', 'Grace days are a whole number up to 90');
  if (typeof amount !== 'string' || !/^\d{1,12}$/.test(amount))
    return reject('OP-DETERMINACY', 'SERVICING_POLICY_INVALID', 'The late charge is a whole number of minor units');
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 120)
    return reject(
      'OP-DETERMINACY',
      'SERVICING_POLICY_INVALID',
      'The restructured schedule has at most 120 instalments',
    );
  return ok({
    policyRef: r['policyRef'],
    lateCharge: { graceDays: grace, amountMinorUnits: BigInt(amount) },
    restructuring: { maxPayments: max },
  });
}

export interface LateChargeDue {
  readonly scheduleNumber: number;
  readonly amount: Money;
  readonly treatment: 'INCOME' | 'CHARITY';
}

/** The instalments now chargeable that have not been charged before. */
export function lateChargesDue(
  position: FacilityPosition,
  policy: ServicingPolicy,
  alreadyCharged: ReadonlySet<number>,
  islamic: boolean,
  currency: CurrencyCode,
): readonly LateChargeDue[] {
  const today = civilDay(position.asOf) ?? 0;
  return position.instalments
    .filter(
      (i) =>
        i.state === 'OVERDUE' &&
        today - (civilDay(i.dueDate) ?? today) > policy.lateCharge.graceDays &&
        !alreadyCharged.has(i.number),
    )
    .map((i) => ({
      scheduleNumber: i.number,
      amount: money(policy.lateCharge.amountMinorUnits, currency),
      treatment: islamic ? 'CHARITY' : 'INCOME',
    }));
}
