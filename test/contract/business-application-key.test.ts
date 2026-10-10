/**
 * SR-017: `APPLICATION_ID_TAKEN` is not a cross-tenant oracle. A business
 * application is keyed by `(tenant_id, application_id)`, so the same id is
 * taken in two tenants, each in its own book; within one tenant it is taken
 * once, which the tenant's own `business:read` already shows.
 * Runs with SANAD_TEST_DATABASE_URL, as the runtime role under each tenant.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inTenant } from '../../services/origination/src/tenant-scope.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];

describe.skipIf(url === undefined)('a business application id is per tenant (SR-017)', () => {
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

  // Rows of this table are never deleted, so each run takes a fresh id.
  const app = `FR-${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
  const handOver = (code: string, currency: string, upstreamRef: string) => {
    const tenant = tenants[code] as string;
    return inTenant(pool, tenant, (db) =>
      db.query(
        `insert into core.business_application (tenant_id, application_id, upstream_ref, stage, status, product_code,
           variant_code, currency, requested_minor, tenor_months, grace_months, record, correlation_id, created_by)
         values ($1, $2, $3, 5, 'RECEIVED', 'sme-term-conventional', 'SMALL_LOAN', $4, 25000000, 24, 0,
                 '{"status":"RECEIVED"}'::jsonb, $2, 'upstream')`,
        [tenant, app, upstreamRef, currency],
      ),
    );
  };

  it('is taken in two tenants, and once within each', async () => {
    await handOver('sme-fund-ae', 'AED', `up-${app}-ae`);
    await handOver('bank-a', 'SAR', `up-${app}-sa`);
    await expect(handOver('sme-fund-ae', 'AED', `up-${app}-again`)).rejects.toThrow(/duplicate key/);
  });
});
