/**
 * SR-003: row-level security binds at runtime, against a real database.
 *
 * Runs only when SANAD_TEST_DATABASE_URL points at a database with the
 * migrations applied (CI: the "Database controls" job). Each case attempts to
 * reach another tenant's rows through the runtime path (`inTenant`, which drops
 * to `sanad_app` with the tenant set) and passes only when the attempt fails;
 * the catalogue cases assert the roles and tables the policies depend on.
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Scoped, asOutboxDispatcher, inTenant } from '../../services/origination/src/tenant-scope.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const SCHEMAS = ['core', 'config', 'evidence', 'audit', 'products'];

describe.skipIf(url === undefined)('runtime row-level security (SR-003)', () => {
  let pool: Pool;
  const A = randomUUID();
  const B = randomUUID();
  const partner = `rls-${randomUUID()}`;
  const INSERT_KEY = `insert into core.idempotency_key (tenant_id, partner_id, key, fingerprint, status)
                      values ($1, $2, $3, 'f', 'IN_FLIGHT')`;
  const insertKey = (db: Scoped, tenant: string, key: string) => db.query(INSERT_KEY, [tenant, partner, key]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    await inTenant(pool, A, (db) => insertKey(db, A, 'a-1'));
    await inTenant(pool, B, (db) => insertKey(db, B, 'b-1'));
  });
  afterAll(async () => {
    await inTenant(pool, A, (db) => db.query('delete from core.idempotency_key where partner_id = $1', [partner]));
    await inTenant(pool, B, (db) => db.query('delete from core.idempotency_key where partner_id = $1', [partner]));
    await pool.end();
  });

  it("sees only its own tenant's rows, even when it asks for every tenant", async () => {
    const seen = await inTenant(pool, A, (db) =>
      db.query<{ tenant_id: string }>('select tenant_id from core.idempotency_key where partner_id = $1', [partner]),
    );
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([A]);
  });

  it("cannot read another tenant's row by naming it", async () => {
    const named = await inTenant(pool, A, (db) =>
      db.query('select 1 from core.idempotency_key where tenant_id = $1 and partner_id = $2', [B, partner]),
    );
    expect(named.rowCount).toBe(0);
  });

  it('cannot insert a row for another tenant', async () => {
    await expect(inTenant(pool, A, (db) => insertKey(db, B, 'b-forged'))).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's row", async () => {
    const updated = await inTenant(pool, A, (db) =>
      db.query("update core.idempotency_key set status = 'COMPLETE' where partner_id = $1 and tenant_id = $2", [
        partner,
        B,
      ]),
    );
    const deleted = await inTenant(pool, A, (db) =>
      db.query('delete from core.idempotency_key where partner_id = $1 and tenant_id = $2', [partner, B]),
    );
    expect([updated.rowCount, deleted.rowCount]).toEqual([0, 0]);
    const intact = await inTenant(pool, B, (db) =>
      db.query<{ status: string }>('select status from core.idempotency_key where partner_id = $1', [partner]),
    );
    expect(intact.rows).toEqual([{ status: 'IN_FLIGHT' }]);
  });

  it('cannot move its own row into another tenant', async () => {
    await expect(
      inTenant(pool, A, (db) =>
        db.query('update core.idempotency_key set tenant_id = $1 where partner_id = $2', [B, partner]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('sees nothing as the runtime role with no tenant set', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role sanad_app');
      const r = await client.query('select 1 from core.idempotency_key where partner_id = $1', [partner]);
      expect(r.rowCount).toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('does not carry one tenant into the next transaction on the same connection', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('sanad.tenant_id', $1, true)", [A]);
      await client.query('commit');
      const r = await client.query<{ t: string | null }>("select current_setting('sanad.tenant_id', true) as t");
      expect([null, '']).toContain(r.rows[0]?.t);
    } finally {
      client.release();
    }
  });

  it('refuses a tenant code where the uuid belongs', async () => {
    await expect(inTenant(pool, 'bank-a', () => Promise.resolve(1))).rejects.toThrow(/uuid/);
  });

  it('forces row-level security on every table that carries tenant_id and a policy', async () => {
    const { rows } = await pool.query<{ t: string }>(
      `select n.nspname || '.' || c.relname as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname = any($1)
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
          and exists (select 1 from pg_policy p where p.polrelid = c.oid)
          and not (c.relrowsecurity and c.relforcerowsecurity)`,
      [SCHEMAS],
    );
    expect(rows).toEqual([]);
  });

  it('gives the runtime roles nothing on a tenant table that has no policy', async () => {
    const { rows } = await pool.query<{ t: string; r: string }>(
      `select n.nspname || '.' || c.relname as t, r.rolname as r
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join (select rolname from pg_roles where rolname in ('sanad_app', 'sanad_outbox', 'sanad_runtime')) r
        where c.relkind = 'r' and n.nspname = any($1)
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
          and not exists (select 1 from pg_policy p where p.polrelid = c.oid)
          and (has_table_privilege(r.rolname, c.oid, 'SELECT') or has_table_privilege(r.rolname, c.oid, 'INSERT')
               or has_table_privilege(r.rolname, c.oid, 'UPDATE') or has_table_privilege(r.rolname, c.oid, 'DELETE'))`,
      [SCHEMAS],
    );
    expect(rows).toEqual([]);
  });

  it('runs as roles that bypass nothing and own nothing', async () => {
    const { rows } = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean; owns: string }>(
      `select r.rolname, r.rolsuper, r.rolbypassrls,
              (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where c.relowner = r.oid and n.nspname = any($1))::text as owns
         from pg_roles r where r.rolname in ('sanad_app', 'sanad_outbox', 'sanad_runtime') order by r.rolname`,
      [SCHEMAS],
    );
    expect(rows).toEqual(
      ['sanad_app', 'sanad_outbox', 'sanad_runtime'].map((rolname) => ({
        rolname,
        rolsuper: false,
        rolbypassrls: false,
        owns: '0',
      })),
    );
  });

  it('lets the outbox dispatcher reach the outbox and nothing else', async () => {
    const { rows } = await pool.query<{ t: string }>(
      `select n.nspname || '.' || c.relname as t
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r' and n.nspname = any($1)
          and (has_table_privilege('sanad_outbox', c.oid, 'SELECT') or has_table_privilege('sanad_outbox', c.oid, 'UPDATE')
               or has_table_privilege('sanad_outbox', c.oid, 'INSERT') or has_table_privilege('sanad_outbox', c.oid, 'DELETE'))`,
      [SCHEMAS],
    );
    expect(rows.map((r) => r.t)).toEqual(['core.outbox_event']);
    await expect(
      asOutboxDispatcher(pool, (db) => db.query('select 1 from core.idempotency_key limit 1')),
    ).rejects.toThrow(/permission denied/);
  });
});
