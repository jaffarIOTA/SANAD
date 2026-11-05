/**
 * Where a BNPL loan stands, read from what Sanad itself recorded: its events.
 * Pure, so the list, the filter chips and the side panel agree, and so it can
 * be tested without a database.
 *
 * This is Sanad's own account (repayments it posted, overdue it reported),
 * never a schedule of its own: the loan system holds the schedule and the
 * panel shows its position separately.
 */
import { type ConsumerLoanView, dueDatesOf } from '@sanad/origination/consumer-loans.ts';

export type LoanStage = 'NOT_BOOKED' | 'AWAITING_ACTIVATION' | 'ACTIVE' | 'OVERDUE' | 'PAID_IN_FULL';

/** The filter chips, in the order they are shown. */
export const LOAN_FILTERS = ['ALL', 'NOT_BOOKED', 'ACTIVE', 'OVERDUE', 'PAID_IN_FULL'] as const;
export type LoanFilter = (typeof LOAN_FILTERS)[number];

export interface LoanStanding {
  readonly stage: LoanStage;
  /** How many instalments a repayment has been posted against, as Sanad recorded it. */
  readonly paidCount: number;
  /** How many instalments the plan has (a count, not money). */
  readonly planLength: number;
  /** The next due date of the plan as disclosed; absent once paid in full. */
  readonly nextDue?: string;
  readonly bookedAt?: string;
}

export function standingOf(view: ConsumerLoanView): LoanStanding {
  const { loan, events } = view;
  const planLength = loan.numberOfInstalments;
  const booking = events.find((e) => e.kind === 'BOOKED_IN_LOAN_SYSTEM');
  const closed = events.some((e) => e.kind === 'LOAN_CLOSED');
  const posted = new Set(
    events.filter((e) => e.kind === 'REPAYMENT_POSTED' && e.scheduleNumber !== undefined).map((e) => e.scheduleNumber),
  );
  const paidCount = closed ? planLength : Math.min(posted.size, planLength);
  const overdue = events.some(
    (e) => e.kind === 'INSTALMENT_OVERDUE' && e.scheduleNumber !== undefined && !posted.has(e.scheduleNumber),
  );
  const stage: LoanStage =
    booking === undefined
      ? 'NOT_BOOKED'
      : closed
        ? 'PAID_IN_FULL'
        : overdue
          ? 'OVERDUE'
          : booking.detail['loanState'] === 'AWAITING_ACTIVATION'
            ? 'AWAITING_ACTIVATION'
            : 'ACTIVE';
  const nextDue = closed ? undefined : dueDatesOf(loan).find((_, i) => !posted.has(i + 1));
  return {
    stage,
    paidCount,
    planLength,
    ...(nextDue === undefined ? {} : { nextDue }),
    ...(booking === undefined ? {} : { bookedAt: booking.createdAt }),
  };
}

/** Whether a loan at this stage is listed under a chip. Awaiting activation counts as active: it is booked. */
export function matchesFilter(stage: LoanStage, filter: LoanFilter): boolean {
  if (filter === 'ALL') return true;
  if (filter === 'ACTIVE') return stage === 'ACTIVE' || stage === 'AWAITING_ACTIVATION';
  return stage === filter;
}

export const isLoanFilter = (v: string | undefined): v is LoanFilter =>
  v !== undefined && (LOAN_FILTERS as readonly string[]).includes(v);
