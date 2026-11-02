/**
 * The assertion replay guard for the Wasl surfaces (SR-007): each identity
 * assertion is accepted once per tenant. On PostgreSQL the guard
 * (`core.consumed_assertion`, migration 0020) runs in the tenant's scope,
 * which is the tenant's uuid; the identity adapters speak in tenant codes, so
 * the code is resolved here, inside the trust boundary, before the guard sees
 * it. Without a database, one guard per process.
 */
import type { AssertionReplayGuard } from '@sanad/core/ports/assertion-replay.ts';
import { inMemoryAssertionReplayGuard } from '@sanad/core/ports/assertion-replay.ts';

import { postgresAssertionReplayGuard } from '../assertion-replay-postgres.ts';
import { tenantUuidByCode } from '../credentials.ts';
import { waslPool } from './book.ts';

const KEY = Symbol.for('sanad.wasl.assertionReplay');

export function assertionReplayGuard(): AssertionReplayGuard {
  const pool = waslPool();
  if (pool === undefined) {
    const g = globalThis as { [KEY]?: AssertionReplayGuard };
    g[KEY] ??= inMemoryAssertionReplayGuard();
    return g[KEY];
  }
  const guard = postgresAssertionReplayGuard(pool);
  return {
    consume: async (use) => guard.consume({ ...use, tenantId: await tenantUuidByCode(pool, use.tenantId) }),
  };
}
