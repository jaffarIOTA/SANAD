/**
 * Wasl W6a on PostgreSQL — the Shariah approvals register (migration 0033).
 *
 * The register's changes are rows proposed once and decided once, by two
 * different people, and a confirmed change is projected onto
 * core.shariah_approval, the row transactions refer to. Each case below also
 * tries the table directly, as an operator with a database connection would,
 * and passes only when the database refuses:
 *
 *   - a change decided by its proposer, decided twice, rewritten or deleted;
 *   - two open proposals for one approval;
 *   - a recorded approval's terms rewritten, a withdrawn one revived, any deleted;
 *   - one tenant reading another's register.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import type { ApprovalTerms } from '@sanad/core/shariah/approvals.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';

import {
  approvalChanges,
  decideApprovalChange,
  proposeApprovalChange,
  shariahRegister,
} from '../../services/origination/src/shariah/approvals.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-8);
const T = 'bank-a';
const REF = `SSB-DB-${RUN}`;

let clock = Date.UTC(2026, 9, 26, 6, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

const terms: ApprovalTerms = {
  approvalRef: REF,
  approvingBody: 'Shariah Supervisory Board (database test)',
  members: ['Member one', 'Member two'],
  effectiveFrom: '2026-01-01',
  reviewOrExpiry: '2027-06-30',
  productCodes: ['murabaha-scf'],
  templateVersionIds: ['waad_promise@3'],
};

describe.skipIf(url === undefined)('the Shariah approvals register on PostgreSQL (Wasl W6a)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(() => {
    vi.stubEnv('SANAD_DATABASE_URL', url ?? '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const refused = (sql: string, values: readonly unknown[]) =>
    pool.query(sql, [...values]).then(
      () => undefined,
      (x: unknown) => x as { code?: string; constraint?: string },
    );

  it('records, suspends and renews through two people, and projects each onto the approval row', async () => {
    const p = expectOk(
      await proposeApprovalChange(T, 'stf-shariah-01', { change: { kind: 'RECORD', terms }, reason: 'Minute 14' }),
    );
    expect((await shariahRegister(T)).some((a) => a.approvalRef === REF)).toBe(false);
    // The database refuses a second open proposal for the same approval, whatever the application did.
    const second = await refused(
      `insert into core.shariah_approval_change (tenant_id, approval_ref, kind, change, reason, proposed_by,
         proposed_at, correlation_id)
       select tenant_id, approval_ref, kind, change, reason, 'stf-shariah-02', proposed_at, correlation_id
         from core.shariah_approval_change where id = $1::uuid`,
      [p.changeId],
    );
    expect(second?.code).toBe('23505');
    // Decided by its own proposer: refused by the table.
    const self = await refused(
      `update core.shariah_approval_change set state = 'CONFIRMED', decided_by = proposed_by, decided_at = now()
        where id = $1::uuid`,
      [p.changeId],
    );
    expect(self?.constraint).toBe('shariah_approval_change_four_eyes');

    advance(60);
    expectOk(await decideApprovalChange(T, 'stf-shariah-02', { changeId: p.changeId, confirm: true, note: '' }));
    const [row] = (
      await pool.query<{
        status: string;
        approving_members: string[];
        product_codes: string[];
        template_version_ids: string[];
        recorded_by: string;
        confirmed_by: string;
        review_or_expiry: string;
      }>(
        `select status, approving_members, product_codes, template_version_ids, recorded_by, confirmed_by,
                review_or_expiry::text
           from core.shariah_approval where approval_ref = $1`,
        [REF],
      )
    ).rows;
    expect(row).toEqual({
      status: 'IN_FORCE',
      approving_members: ['Member one', 'Member two'],
      product_codes: ['murabaha-scf'],
      template_version_ids: ['waad_promise@3'],
      recorded_by: 'stf-shariah-01',
      confirmed_by: 'stf-shariah-02',
      review_or_expiry: '2027-06-30',
    });
    expect((await shariahRegister(T)).find((a) => a.approvalRef === REF)).toMatchObject({
      ...terms,
      status: 'IN_FORCE',
    });

    // Decided once: a confirmed change is never re-decided, rewritten or deleted.
    for (const sql of [
      `update core.shariah_approval_change set state = 'REJECTED', decision_note = 'later' where id = $1::uuid`,
      `update core.shariah_approval_change set reason = 'rewritten' where id = $1::uuid`,
      `delete from core.shariah_approval_change where id = $1::uuid`,
    ])
      expect((await refused(sql, [p.changeId]))?.code).toBe('23001');

    // A recorded approval's terms do not change, and it is never deleted.
    for (const sql of [
      `update core.shariah_approval set approving_members = array['Someone else'] where approval_ref = $1`,
      `update core.shariah_approval set product_codes = array['murabaha-scf','tawarruq-personal'] where approval_ref = $1`,
      `update core.shariah_approval set effective_from = '2020-01-01' where approval_ref = $1`,
      `delete from core.shariah_approval where approval_ref = $1`,
    ])
      expect((await refused(sql, [REF]))?.code).toBe('23001');

    for (const change of [
      { kind: 'SUSPEND', approvalRef: REF },
      { kind: 'RENEW', approvalRef: REF, reviewOrExpiry: '2028-06-30' },
    ] as const) {
      advance(60);
      const c = expectOk(await proposeApprovalChange(T, 'stf-shariah-02', { change, reason: 'Board resolution' }));
      advance(60);
      expectOk(await decideApprovalChange(T, 'stf-shariah-01', { changeId: c.changeId, confirm: true, note: '' }));
    }
    const moved = (
      await pool.query<{ status: string; review_or_expiry: string }>(
        'select status, review_or_expiry::text from core.shariah_approval where approval_ref = $1',
        [REF],
      )
    ).rows[0];
    expect(moved).toEqual({ status: 'SUSPENDED', review_or_expiry: '2028-06-30' });
    expect(
      (await approvalChanges(T)).filter(
        (e) => e.change.kind !== 'RECORD' && 'approvalRef' in e.change && e.change.approvalRef === REF,
      ),
    ).toHaveLength(2);
  });

  it('a withdrawn approval stays withdrawn in the table too', async () => {
    const ref = `${REF}-W`;
    for (const change of [
      { kind: 'RECORD', terms: { ...terms, approvalRef: ref } },
      { kind: 'WITHDRAW', approvalRef: ref },
    ] as const) {
      advance(60);
      const c = expectOk(await proposeApprovalChange(T, 'stf-shariah-01', { change, reason: 'Board minute' }));
      advance(60);
      expectOk(await decideApprovalChange(T, 'stf-shariah-02', { changeId: c.changeId, confirm: true, note: '' }));
    }
    expect(
      (await refused(`update core.shariah_approval set status = 'IN_FORCE' where approval_ref = $1`, [ref]))?.code,
    ).toBe('23001');
  });

  it('one tenant never reads another’s register', async () => {
    const other = await tenantUuidByCode(pool, 'fintech-b');
    const seen = await inTenant(pool, other, (db) =>
      db.query<{ n: string }>(`select count(*)::text n from core.shariah_approval_change where approval_ref like $1`, [
        `${REF}%`,
      ]),
    );
    expect(seen.rows[0]?.n).toBe('0');
    const own = await inTenant(pool, await tenantUuidByCode(pool, T), (db) =>
      db.query<{ n: string }>(`select count(*)::text n from core.shariah_approval_change where approval_ref like $1`, [
        `${REF}%`,
      ]),
    );
    expect(Number(own.rows[0]?.n)).toBeGreaterThan(0);
  });
});
