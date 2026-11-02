/**
 * Servicing a loan the institution's loan system holds: reading where each
 * instalment stands, and posting a repayment Sanad collected into the loan's
 * servicing account for the loan system to allocate.
 *
 * For the consumer products the loan system is the system of record for the
 * schedule: Sanad keeps no instalment table of its own for them, reads the
 * position from the loan system, and decides only what to collect, through
 * which channel, and what to report. Collecting the money is not the loan
 * system's job: a rail does it (bill presentment, direct debit, card, payment
 * initiation), except where the customer's own account at the institution is
 * debited by the loan system itself.
 *
 * A port: capability-named, vendor-free. Amounts are minor-unit money; a
 * position reports the loan system's figures, which Sanad reconciles against
 * the schedule it disclosed and never adopts silently.
 */
import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export type InstalmentStanding = 'NOT_DUE' | 'DUE' | 'PAID' | 'OVERDUE';

export interface InstalmentPosition {
  readonly number: number;
  /** yyyy-mm-dd, the loan system's due date. */
  readonly dueDate: string;
  readonly amount: Money;
  readonly paid: Money;
  readonly outstanding: Money;
  readonly standing: InstalmentStanding;
  /** Days past due as the loan system counts them; zero unless OVERDUE. */
  readonly daysPastDue: number;
}

export interface LoanPosition {
  readonly contractRef: string;
  /** yyyy-mm-dd the position is as at. */
  readonly asOf: string;
  readonly instalments: readonly InstalmentPosition[];
  readonly outstanding: Money;
  readonly closed: boolean;
}

export interface LoanServicingPort {
  readonly source: 'LIVE' | 'FIXTURE';
  /**
   * Where the loan stands on `asOf`. A live loan system answers only for its own today and refuses any
   * other date; a fixture may answer for a date the demonstration chooses.
   */
  position(params: {
    readonly tenantId: string;
    readonly contractRef: string;
    readonly asOf: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<LoanPosition>>>;
  /** Post a collected repayment into the servicing account; idempotent on `idempotencyKey`. */
  postRepayment(params: {
    readonly tenantId: string;
    readonly contractRef: string;
    readonly servicingAccountRef: string;
    readonly amount: Money;
    /** The collection's settlement reference: the rail's proof the money arrived. */
    readonly settlementRef: string;
    readonly valueDate: string;
    readonly idempotencyKey: string;
    readonly correlationId: string;
  }): Promise<Result<RailOutcome<{ readonly transactionRef: string }>>>;
}
