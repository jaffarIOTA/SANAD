/**
 * `npm run audit:verify`: every tenant's audit chain, verified twice (SR-011).
 *
 * Once by the database's `audit.verify_chain()` and once independently in this
 * process (`audit-verify.ts`). One line per tenant: its code, the rows checked,
 * and the first broken row and reason if any — no event content. Exits 1 when
 * any chain is broken or the two verifiers disagree, 2 when it cannot run, so a
 * scheduler (cron, a Container Apps job) alerts on a non-zero exit.
 */

import { Pool } from 'pg';

import { verifyAuditChain } from './audit-verify.ts';
import { inTenant } from './tenant-scope.ts';

const url = (process.env['SANAD_DATABASE_URL'] ?? process.env['SANAD_TEST_DATABASE_URL'] ?? '').trim();
if (url.length === 0) {
  process.stderr.write('audit:verify needs SANAD_DATABASE_URL\n');
  process.exit(2);
}

const pool = new Pool({ connectionString: url, max: 2 });
let broken = false;
try {
  const tenants = await pool.query<{ id: string; code: string }>(
    'select id::text, code from core.tenant order by code',
  );
  for (const t of tenants.rows) {
    const inDatabase = (
      await pool.query<{ checked: string; first_broken_id: string | null; reason: string | null }>(
        'select checked::text, first_broken_id::text, reason from audit.verify_chain($1::uuid)',
        [t.id],
      )
    ).rows[0];
    const here = await inTenant(pool, t.id, (db) => verifyAuditChain(db, t.id));
    const hereBroken = here.ok ? null : here.firstBrokenId;
    const agree = (inDatabase?.first_broken_id ?? null) === hereBroken;
    const ok = here.ok && agree;
    if (!ok) broken = true;
    process.stdout.write(
      `audit ${t.code} ${ok ? 'OK' : 'BROKEN'} checked=${String(here.checked)}` +
        (here.ok ? '' : ` first_broken_id=${here.firstBrokenId} reason=${here.reason}`) +
        (agree ? '' : ` database_says=${inDatabase?.first_broken_id ?? 'intact'}`) +
        '\n',
    );
  }
} catch (error) {
  // The message can carry a host or a role name; the class of failure is enough here.
  process.stderr.write(`audit:verify could not run: ${error instanceof Error ? error.name : 'unknown'}\n`);
  await pool.end();
  process.exit(2);
}
await pool.end();
process.exit(broken ? 1 : 0);
