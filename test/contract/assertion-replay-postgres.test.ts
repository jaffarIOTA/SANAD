/**
 * SR-007 in the database: of ten concurrent presentations of one assertion,
 * exactly one is accepted; another tenant's identical assertion id is its own;
 * a consumed assertion is never released. Runs with SANAD_TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { postgresAssertionReplayGuard } from '../../services/origination/src/assertion-replay-postgres.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];

describe.skipIf(url === undefined)('consumed assertions in the database (SR-007)', () => {
  let pool: Pool;
  let tenants: Record<string, string>;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 12 });
    const { rows } = await pool.query<{ code: string; id: string }>('select code, id::text from core.tenant');
    tenants = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  });
  afterAll(async () => {
    await pool.end();
  });

  it('accepts exactly one of ten concurrent presentations', async () => {
    const guard = postgresAssertionReplayGuard(pool);
    const assertionId = `asr-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        guard.consume({
          tenantId: tenants['bank-a'] as string,
          assertionId,
          authenticatedAtEpochSeconds: 1_800_000_000n,
        }),
      ),
    );
    expect(results.filter((r) => r === 'FRESH')).toHaveLength(1);
    expect(results.filter((r) => r === 'REPLAYED')).toHaveLength(9);
  });

  it("keeps each tenant's assertions apart", async () => {
    const guard = postgresAssertionReplayGuard(pool);
    const assertionId = `asr-${randomUUID()}`;
    const use = (tenant: string) =>
      guard.consume({ tenantId: tenants[tenant] as string, assertionId, authenticatedAtEpochSeconds: 1_800_000_000n });
    expect(await use('bank-a')).toBe('FRESH');
    expect(await use('fintech-b')).toBe('FRESH');
    expect(await use('bank-a')).toBe('REPLAYED');
  });

  it('never releases a consumed assertion', async () => {
    const assertionId = `asr-${randomUUID()}`;
    await postgresAssertionReplayGuard(pool).consume({
      tenantId: tenants['bank-a'] as string,
      assertionId,
      authenticatedAtEpochSeconds: 1_800_000_000n,
    });
    for (const sql of [
      'delete from core.consumed_assertion where assertion_id = $1',
      "update core.consumed_assertion set assertion_id = 'x' where assertion_id = $1",
    ])
      await expect(pool.query(sql, [assertionId])).rejects.toMatchObject({ code: '23001' });
  });
});
