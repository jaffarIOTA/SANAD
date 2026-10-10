/**
 * Limit reservations on PostgreSQL (`core.limit_reservation`, migration 0004; SR-014).
 *
 * A hold is an INSERT; the table's commit-time constraint trigger locks the
 * facility and refuses the commit if held plus utilised would exceed the limit.
 * Two concurrent holds that together over-commit the facility both insert, but
 * only the first to commit survives: the second's check runs after the first's
 * commit, sees it, and fails with `restrict_violation`, which is answered here
 * as a typed refusal.
 */

import type { Pool } from 'pg';

import { ok, reject, type Result } from '../../../core/kernel/result.ts';
import type { HoldRequest, LimitReservationPort } from '../../../core/ports/limit-reservation.ts';

import { inTenant } from './tenant-scope.ts';

const RESTRICT_VIOLATION = '23001';
const isOverCommit = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === RESTRICT_VIOLATION;

export function postgresLimitReservations(pool: Pool): LimitReservationPort {
  const settle = async (
    tenantId: string,
    reservationId: string,
    state: 'CONSUMED' | 'RELEASED',
    transactionId: string | null,
  ): Promise<Result<true>> => {
    const { rowCount } = await inTenant(pool, tenantId, (db) =>
      db.query(
        `update core.limit_reservation
            set state = $3, settled_at = now(), transaction_id = coalesce($4::uuid, transaction_id)
          where tenant_id = $1 and id = $2::uuid and state = 'HELD'`,
        [tenantId, reservationId, state, transactionId],
      ),
    );
    return rowCount === 1
      ? ok(true)
      : reject('OP-LIMIT', 'RESERVATION_NOT_HELD', 'This reservation is not held; it may have lapsed or settled', {
          reservationId,
        });
  };

  return {
    async hold(request: HoldRequest): Promise<Result<{ readonly reservationId: string }>> {
      if (request.holdSeconds <= 0 || !Number.isInteger(request.holdSeconds))
        return reject('OP-DETERMINACY', 'HOLD_PERIOD_INVALID', 'A hold needs a positive whole number of seconds');
      try {
        const { rows } = await inTenant(pool, request.tenantId, (db) =>
          db.query<{ id: string }>(
            `insert into core.limit_reservation (tenant_id, facility_id, transaction_id, amount_minor, expires_at, correlation_id)
             values ($1, $2::uuid, $3::uuid, $4::bigint, now() + make_interval(secs => $5), $6::uuid)
             returning id::text`,
            [
              request.tenantId,
              request.facilityId,
              request.transactionId ?? null,
              request.amount.minorUnits.toString(),
              request.holdSeconds,
              request.correlationId,
            ],
          ),
        );
        return ok({ reservationId: rows[0]?.id as string });
      } catch (error) {
        if (!isOverCommit(error)) throw error;
        return reject('OP-LIMIT', 'FACILITY_OVER_COMMITTED', 'This drawdown would take the facility over its limit', {
          facilityId: request.facilityId,
        });
      }
    },
    consume: (tenantId, reservationId, transactionId) => settle(tenantId, reservationId, 'CONSUMED', transactionId),
    release: (tenantId, reservationId) => settle(tenantId, reservationId, 'RELEASED', null),
  };
}
