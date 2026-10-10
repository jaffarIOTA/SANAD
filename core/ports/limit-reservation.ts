/**
 * Limit reservation.
 *
 * A drawdown holds part of a facility's limit before it executes, so two
 * drawdowns cannot both spend the last of it. The adapter is a repository over
 * a table whose commit-time check (held plus utilised never exceeds the limit)
 * is the actual enforcement; an application-side sum would race (SEC-TM04).
 *
 * A hold that would over-commit the facility is refused with a typed outcome,
 * never partially granted.
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';

export interface HoldRequest {
  readonly tenantId: string;
  readonly facilityId: string;
  readonly amount: Money;
  /** How long the hold stands before it lapses unused. */
  readonly holdSeconds: number;
  readonly correlationId: string;
  /** The transaction the hold is for, once it exists. */
  readonly transactionId?: string;
}

export interface LimitReservationPort {
  /** Refused with `FACILITY_OVER_COMMITTED` when held plus utilised would exceed the limit. */
  hold(request: HoldRequest): Promise<Result<{ readonly reservationId: string }>>;
  /** The drawdown executed: the hold becomes utilisation's record. */
  consume(tenantId: string, reservationId: string, transactionId: string): Promise<Result<true>>;
  /** The drawdown did not go ahead: the limit is free again. */
  release(tenantId: string, reservationId: string): Promise<Result<true>>;
}
