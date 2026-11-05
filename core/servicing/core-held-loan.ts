/**
 * Servicing a consumer loan whose schedule the institution's loan system holds
 * (BNPL first). Pure: given the loan, what has happened to it, and the loan
 * system's position on a date, decide what happens next. No clock, no port,
 * no store.
 *
 * Who does what:
 * - the loan system holds the schedule and allocates repayments; Sanad reads
 *   its position and never keeps an instalment table of its own;
 * - Sanad collects each due instalment through the channel the customer chose
 *   (bill presentment, direct debit, card, payment initiation), on the
 *   transactional outbox, and posts each settled collection into the loan's
 *   servicing account;
 * - on the OWN_ACCOUNT channel the loan system debits the customer's account
 *   itself, and Sanad only reads the result;
 * - an instalment the loan system reports overdue is reported to the bureau and
 *   the customer reminded, once each; a loan paid in full is reported closed.
 *
 * Instalments are identified by `scheduleNumber`, their place in the schedule
 * (as SME servicing does). Every effect carries an idempotency key derived from
 * the loan, the schedule number and the attempt, so running servicing twice for
 * the same day plans nothing twice.
 */
import type { CollectionChannel } from '../jurisdiction/profile.ts';
import type { Money } from '../kernel/money.ts';
import type { LoanPosition } from '../ports/loan-servicing.ts';

export interface CoreHeldLoan {
  readonly loanRef: string;
  readonly productCode: string;
  readonly applicantRef: string;
  readonly collectionChannel: CollectionChannel;
  /** The rail's own record of the customer's authority to collect: a bill account, mandate, token, consent or account. */
  readonly collectionMandateRef: string;
}

export type CoreHeldLoanEventKind =
  | 'BOOKED_IN_LOAN_SYSTEM'
  | 'COLLECTION_QUEUED'
  | 'COLLECTION_SETTLED'
  | 'COLLECTION_RETURNED'
  | 'REPAYMENT_POSTED'
  | 'INSTALMENT_OVERDUE'
  | 'LOAN_CLOSED';

export interface CoreHeldLoanEvent {
  readonly kind: CoreHeldLoanEventKind;
  /** Which instalment, by its place in the schedule; absent for the loan as a whole. */
  readonly scheduleNumber?: number;
  readonly idempotencyKey: string;
  readonly detail: Readonly<Record<string, string>>;
}

/** A collection to queue on the outbox, through the loan's channel. */
export interface PlannedCollection {
  readonly scheduleNumber: number;
  readonly due: Money;
  readonly dueDate: string;
  readonly attemptNumber: number;
  readonly idempotencyKey: string;
}

/** A settled collection not yet posted into the loan system. */
export interface PlannedPosting {
  readonly scheduleNumber: number;
  readonly received: Money;
  readonly settlementRef: string;
  readonly valueDate: string;
  /** The settled collection's key: the posting is keyed from it, so one settlement posts once. */
  readonly collectionKey: string;
  readonly idempotencyKey: string;
}

export interface OverdueSchedule {
  readonly scheduleNumber: number;
  readonly outstanding: Money;
  readonly daysPastDue: number;
}

export interface ServicingPlan {
  readonly collections: readonly PlannedCollection[];
  readonly postings: readonly PlannedPosting[];
  /** Instalments newly overdue: report to the bureau and remind the customer, once each. */
  readonly overdue: readonly OverdueSchedule[];
  readonly close: boolean;
  /** Schedule numbers whose collections have used every attempt: no more are queued; arrears handling takes over. */
  readonly exhausted: readonly number[];
}

export const collectionKey = (loanRef: string, scheduleNumber: number, attemptNumber: number): string =>
  `loan:${loanRef}:collect:I${String(scheduleNumber)}${attemptNumber > 0 ? `:R${String(attemptNumber)}` : ''}`;

/**
 * What to do on the position's date. `maxAttempts` is the tenant's servicing retry policy: a returned
 * collection is tried again with a new key until the attempts are used.
 */
export function planServicing(
  loan: CoreHeldLoan,
  events: readonly CoreHeldLoanEvent[],
  position: LoanPosition,
  maxAttempts: number,
): ServicingPlan {
  const ofKind = (kind: CoreHeldLoanEventKind, n: number) =>
    events.filter((e) => e.kind === kind && e.scheduleNumber === n);
  const collections: PlannedCollection[] = [];
  const postings: PlannedPosting[] = [];
  const overdue: OverdueSchedule[] = [];
  const exhausted: number[] = [];

  // Settled collections not yet posted into the loan system: post them first, so the position read next
  // reflects them.
  for (const settled of events.filter((e) => e.kind === 'COLLECTION_SETTLED')) {
    const collected = settled.detail['collectionKey'] ?? '';
    const postingKey = `${collected}:post`;
    if (events.some((e) => e.kind === 'REPAYMENT_POSTED' && e.idempotencyKey === postingKey)) continue;
    const minor = settled.detail['minorUnits'];
    const currency = settled.detail['currency'];
    if (minor === undefined || !/^\d+$/.test(minor) || currency === undefined) continue;
    postings.push({
      scheduleNumber: settled.scheduleNumber ?? 0,
      received: { minorUnits: BigInt(minor), currency: currency as Money['currency'] },
      settlementRef: settled.detail['settlementRef'] ?? collected,
      valueDate: settled.detail['valueDate'] ?? position.asOf,
      collectionKey: collected,
      idempotencyKey: postingKey,
    });
  }

  for (const i of position.instalments) {
    if (i.outstanding.minorUnits <= 0n) continue;
    if (i.standing === 'OVERDUE' && ofKind('INSTALMENT_OVERDUE', i.number).length === 0)
      overdue.push({ scheduleNumber: i.number, outstanding: i.outstanding, daysPastDue: i.daysPastDue });
    // The loan system debits the customer's own account itself; Sanad collects nothing.
    if (loan.collectionChannel === 'OWN_ACCOUNT') continue;
    if (i.standing !== 'DUE' && i.standing !== 'OVERDUE') continue;
    const queued = ofKind('COLLECTION_QUEUED', i.number);
    const resolved = new Set(
      [...ofKind('COLLECTION_SETTLED', i.number), ...ofKind('COLLECTION_RETURNED', i.number)].map(
        (e) => e.detail['collectionKey'],
      ),
    );
    // One in flight at a time: an instalment with a collection neither settled nor returned waits for it.
    if (queued.some((q) => !resolved.has(q.idempotencyKey))) continue;
    // Settled but not yet reflected in the position (it is posted in this same run): no second collection.
    if (postings.some((p) => p.scheduleNumber === i.number)) continue;
    const attemptNumber = queued.length;
    if (attemptNumber >= maxAttempts) {
      exhausted.push(i.number);
      continue;
    }
    collections.push({
      scheduleNumber: i.number,
      due: i.outstanding,
      dueDate: i.dueDate,
      attemptNumber,
      idempotencyKey: collectionKey(loan.loanRef, i.number, attemptNumber),
    });
  }

  const close = position.closed && postings.length === 0 && !events.some((e) => e.kind === 'LOAN_CLOSED');
  return { collections, postings, overdue, close, exhausted };
}

/** The outbox event kind each collection channel is carried on. OWN_ACCOUNT has none: the loan system debits. */
export function collectionEventKind(
  channel: CollectionChannel,
): 'BILL_PRESENT' | 'PAYMENT_COLLECT' | 'PAYMENT_INITIATE' | undefined {
  switch (channel) {
    case 'BILL_PRESENTMENT':
      return 'BILL_PRESENT';
    case 'DIRECT_DEBIT':
    case 'CARD':
      return 'PAYMENT_COLLECT';
    case 'PAYMENT_INITIATION':
      return 'PAYMENT_INITIATE';
    case 'OWN_ACCOUNT':
      return undefined;
  }
}
