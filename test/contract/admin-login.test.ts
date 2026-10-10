/**
 * SR-046: no app's login but Admin's can drive configuration. Read from the
 * catalogue: `sanad_runtime`, and `sanad_app` which it may assume, execute no
 * function that proposes, decides, sets or revokes, nor lists what Admin
 * alone reviews; `sanad_admin` executes all of them and is otherwise bound
 * like the runtime login.
 * Runs with SANAD_TEST_DATABASE_URL.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env['SANAD_TEST_DATABASE_URL'];

const ADMIN_ONLY = /^(propose_|decide_|set_integration_credential|revoke_integration_credential)/;
const ADMIN_LISTS = new Set([
  'list_revisions',
  'revision_payload',
  'list_integration_credentials',
  'list_deployment_jurisdiction_revisions',
  'list_licence_proposals',
]);

describe.skipIf(url === undefined)('Admin has its own database login (SR-046)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  const privileges = async () =>
    (
      await pool.query<{ fn: string; name: string; runtime: boolean; app: boolean; admin: boolean; anyone: boolean }>(
        `select p.oid::regprocedure::text as fn, p.proname as name,
                has_function_privilege('sanad_runtime', p.oid, 'execute') as runtime,
                has_function_privilege('sanad_app', p.oid, 'execute') as app,
                has_function_privilege('sanad_admin', p.oid, 'execute') as admin,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where a.grantee = 0 and a.privilege_type = 'EXECUTE') as anyone
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'config'`,
      )
    ).rows;

  it('no other login executes a proposing, deciding, setting or revoking function, or Admin’s lists', async () => {
    const adminOnly = (await privileges()).filter((r) => ADMIN_ONLY.test(r.name) || ADMIN_LISTS.has(r.name));
    expect(adminOnly.length).toBeGreaterThanOrEqual(13);
    const open = adminOnly.filter((r) => r.runtime || r.app || r.anyone).map((r) => r.fn);
    expect(open).toEqual([]);
    expect(adminOnly.filter((r) => !r.admin).map((r) => r.fn)).toEqual([]);
  });

  it('every app keeps what it reads at runtime', async () => {
    const byName = new Map((await privileges()).map((r) => [r.name, r]));
    for (const name of [
      'effective_revision',
      'get_integration_credential',
      'effective_deployment_jurisdiction',
      'licence_installation',
      'spend_token',
      'token_spent',
    ]) {
      expect(byName.get(name)?.runtime, name).toBe(true);
      expect(byName.get(name)?.admin, name).toBe(true);
    }
  });

  it('Admin’s login bypasses no row-level security and inherits nothing', async () => {
    const r = await pool.query<{ rolcanlogin: boolean; rolbypassrls: boolean; rolinherit: boolean; rolsuper: boolean }>(
      "select rolcanlogin, rolbypassrls, rolinherit, rolsuper from pg_roles where rolname = 'sanad_admin'",
    );
    expect(r.rows[0]).toEqual({ rolcanlogin: true, rolbypassrls: false, rolinherit: false, rolsuper: false });
  });
});
