/**
 * The assertion replay guard on PostgreSQL (`core.consumed_assertion`, migration 0020; SR-007).
 *
 * A plain INSERT in the tenant's scope. The primary key is the control: the
 * first presentation of an assertion inserts, every later one, and the loser of
 * two concurrent ones, conflicts and is a replay.
 */

import type { Pool } from 'pg';

import type { AssertionReplayGuard } from '../../../core/ports/assertion-replay.ts';

import { inTenant } from './tenant-scope.ts';

const UNIQUE_VIOLATION = '23505';

export function postgresAssertionReplayGuard(pool: Pool): AssertionReplayGuard {
  return {
    async consume(use) {
      try {
        await inTenant(pool, use.tenantId, (db) =>
          db.query(
            `insert into core.consumed_assertion (tenant_id, assertion_id, authenticated_at)
             values ($1, $2, to_timestamp($3::bigint))`,
            [use.tenantId, use.assertionId, use.authenticatedAtEpochSeconds.toString()],
          ),
        );
        return 'FRESH';
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return 'REPLAYED';
        throw error;
      }
    },
  };
}
