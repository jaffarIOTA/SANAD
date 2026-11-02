/**
 * Which instalments attract a late amount (Wasl W4b-2). Pure.
 *
 * An instalment still unpaid more than the board's grace days after it fell
 * due attracts one late amount, at the amount the board ruled, once. The
 * amount is a proposal and nothing more: an officer assesses whether the
 * distributor was able but unwilling or unable, a second person confirms, and
 * only an able-but-unwilling assessment is billed (SH-14). What is collected
 * goes to the segregated charity liability (`charity.ts`, SH-13). Nothing
 * here touches the obligation: a late amount is never part of the sale price
 * and never reduces or adds to what the distributor owes for the goods (M-2).
 *
 * Where the board has ruled no late amounts, none is ever due.
 */

import { type CurrencyCode, type Money, money } from '@sanad/core/kernel/money.ts';
import { type FacilityPosition, civilDay } from '@sanad/core/servicing/instalment-position.ts';

import type { LateAmountPositions } from '../structures/board-positions.ts';

export interface LateAmountDue {
  readonly sequenceNumber: number;
  /** yyyy-mm-dd: the instalment's due date. */
  readonly dueDate: string;
  /** Whole days past the due date on the day of the proposal. */
  readonly daysPastDue: number;
  readonly amount: Money;
  readonly computationBasisKey: string;
  readonly graceDays: number;
}

/**
 * The instalments overdue beyond the grace on the position's day that have
 * not been proposed before. `alreadyProposed` holds every instalment ever
 * proposed, whatever became of the proposal: one late amount per instalment.
 */
export function lateAmountsDue(
  position: FacilityPosition,
  ruling: LateAmountPositions | undefined,
  alreadyProposed: ReadonlySet<number>,
  currency: CurrencyCode,
): readonly LateAmountDue[] {
  if (ruling === undefined) return [];
  const today = civilDay(position.asOf);
  if (today === undefined) return [];
  return position.instalments.flatMap((i) => {
    const due = civilDay(i.dueDate);
    if (due === undefined || i.state !== 'OVERDUE' || i.outstanding.minorUnits <= 0n) return [];
    const days = today - due;
    if (days <= ruling.graceDays || alreadyProposed.has(i.number)) return [];
    return [
      {
        sequenceNumber: i.number,
        dueDate: i.dueDate,
        daysPastDue: days,
        amount: money(ruling.amountPerInstalmentMinorUnits, currency),
        computationBasisKey: ruling.computationBasisKey,
        graceDays: ruling.graceDays,
      },
    ];
  });
}
