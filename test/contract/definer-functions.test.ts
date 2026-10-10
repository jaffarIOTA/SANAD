/**
 * SR-029: no SECURITY DEFINER function resolves names through `public`, and a
 * revision's payload is read only by its own tenant.
 * Runs with SANAD_TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['SANAD_TEST_DATABASE_URL'];

describe.skipIf(url === undefined)('security-definer functions (SR-029)', () => {
  let pool: Pool;
  let tenants: Record<string, string>;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    const { rows } = await pool.query<{ code: string; id: string }>('select code, id::text from core.tenant');
    tenants = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  });
  afterAll(async () => {
    await pool.end();
  });

  it('every one sets a search_path, and none includes public', async () => {
    const { rows } = await pool.query<{ fn: string; path: string | null }>(
      `select p.oid::regprocedure::text as fn,
              (select c from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') as path
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prosecdef and n.nspname in ('core', 'config', 'audit', 'evidence', 'products')`,
    );
    expect(rows.length).toBeGreaterThan(10);
    const offenders = rows.filter((r) => r.path === null || /(^|[=, ])public($|[, ])/.test(r.path));
    expect(offenders).toEqual([]);
  });

  it("returns a revision's payload to its own tenant only", async () => {
    const id = (
      await pool.query<{ id: string }>(
        `select config.propose_revision($1::uuid, 'PARTNERS', '{"probe": "sr-029"}'::jsonb, 'contract: payload scope',
                                        timestamptz '2099-01-01', $2, $3::uuid) as id`,
        [tenants['bank-a'], `adm-${randomUUID().slice(0, 6)}`, randomUUID()],
      )
    ).rows[0]?.id as string;
    const read = async (tenant: string) =>
      (
        await pool.query<{ payload: unknown }>('select config.revision_payload($1::uuid, $2::uuid) as payload', [
          tenants[tenant],
          id,
        ])
      ).rows[0]?.payload;
    expect(await read('bank-a')).toEqual({ probe: 'sr-029' });
    expect(await read('fintech-b')).toBeNull();
    await expect(pool.query('select config.revision_payload($1::uuid)', [id])).rejects.toThrow();
  });
});
