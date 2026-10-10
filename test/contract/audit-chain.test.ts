/**
 * SR-009 to SR-012: the audit chain cannot be bypassed, forked or quietly
 * altered, and every decision is in it. Against a real database.
 *
 * Runs only when SANAD_TEST_DATABASE_URL points at a database with the
 * migrations applied (CI: "Database controls"), connected as the owner, as
 * migrations are. Tampering is done inside a transaction that is rolled back.
 */
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type AuditChainResult, verifyAuditChain } from '../../services/origination/src/audit-verify.ts';
import { type Scoped, inTenant } from '../../services/origination/src/tenant-scope.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];

describe.skipIf(url === undefined)('the audit chain (SR-009 to SR-012)', () => {
  let pool: Pool;
  let bankA: string;
  let smeFund: string;

  const record = (db: Scoped | Pool, tenant: string, event: string, actor = 'stf-x') =>
    (db as Scoped).query(
      'select audit.record_event($1::uuid, $2, gen_random_uuid(), $3, null, $4::jsonb, $5, gen_random_uuid())',
      [tenant, 'test.subject', event, JSON.stringify({ n: event }), actor],
    );
  const sqlVerify = async (db: Pool | PoolClient, tenant: string) =>
    (
      await db.query<{ checked: string; first_broken_id: string | null; reason: string | null }>(
        'select checked::text, first_broken_id::text, reason from audit.verify_chain($1::uuid)',
        [tenant],
      )
    ).rows[0];
  const tsVerify = (db: PoolClient, tenant: string): Promise<AuditChainResult> =>
    verifyAuditChain({ query: (t, v) => db.query(t, v as unknown[]) }, tenant);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 25 });
    const t = await pool.query<{ code: string; id: string }>('select code, id::text from core.tenant');
    bankA = t.rows.find((r) => r.code === 'bank-a')?.id as string;
    smeFund = t.rows.find((r) => r.code === 'sme-fund-ae')?.id as string;
  });
  afterAll(async () => {
    await pool.end();
  });

  describe('SR-009: written only through the chain', () => {
    it('refuses a direct INSERT, UPDATE or DELETE by the runtime role, by grant', async () => {
      for (const sql of [
        `insert into audit.audit_event (tenant_id, subject_type, subject_id, event_type, actor, correlation_id, content_hash)
         values ('${bankA}', 'x', gen_random_uuid(), 'FORGED', 'x', gen_random_uuid(), 'x')`,
        "update audit.audit_event set actor = 'someone-else'",
        'delete from audit.audit_event',
      ])
        await expect(
          inTenant(pool, bankA, (db) => db.query(sql)),
          sql.slice(0, 6),
        ).rejects.toThrow(/permission denied/);
    });

    it('rechains a row the owner writes directly: a forged link and hash are overwritten', async () => {
      const { rows } = await pool.query<{ prev_hash: string | null; content_hash: string; hash_version: number }>(
        `insert into audit.audit_event (tenant_id, subject_type, subject_id, event_type, actor, correlation_id, prev_hash, content_hash)
         values ($1, 'test.subject', gen_random_uuid(), 'OWNER_WRITE', 'owner', gen_random_uuid(), 'forged-prev', 'forged')
         returning prev_hash, content_hash, hash_version`,
        [bankA],
      );
      expect(rows[0]?.content_hash).not.toBe('forged');
      expect(rows[0]?.prev_hash).not.toBe('forged-prev');
      expect(rows[0]?.hash_version).toBe(2);
      expect((await sqlVerify(pool, bankA))?.first_broken_id).toBeNull();
    });

    it("refuses an event for another tenant from this tenant's scope", async () => {
      await expect(inTenant(pool, bankA, (db) => record(db, smeFund, 'CROSS_TENANT'))).rejects.toThrow(
        /another tenant/,
      );
    });
  });

  describe('SR-010: one linear chain, whatever the concurrency and the time zone', () => {
    it('chains 20 concurrent writers for one tenant into one line', async () => {
      const tenant = randomUUID();
      await Promise.all(Array.from({ length: 20 }, (_, i) => record(pool, tenant, `CONCURRENT_${String(i)}`)));
      const v = await sqlVerify(pool, tenant);
      expect(v).toEqual({ checked: '20', first_broken_id: null, reason: null });
      const { rows } = await pool.query<{ n: string; links: string }>(
        'select count(*)::text as n, count(distinct prev_hash)::text as links from audit.audit_event where tenant_id = $1',
        [tenant],
      );
      // 19 distinct predecessors and one null: no two rows share a parent.
      expect(rows[0]).toEqual({ n: '20', links: '19' });
    });

    it('verifies the same under different session time zones', async () => {
      const tenant = randomUUID();
      for (const i of [1, 2, 3]) await record(pool, tenant, `TZ_${String(i)}`);
      for (const zone of ['UTC', 'Asia/Riyadh', 'America/New_York', 'Pacific/Chatham']) {
        const client = await pool.connect();
        try {
          await client.query(`set time zone '${zone}'`);
          expect((await sqlVerify(client, tenant))?.first_broken_id, zone).toBeNull();
          expect((await tsVerify(client, tenant)).ok, zone).toBe(true);
        } finally {
          await client.query('reset time zone');
          client.release();
        }
      }
    });
  });

  describe('SR-011: both verifiers name the first broken row', () => {
    const tamper = async (
      change: (client: PoolClient, ids: readonly string[]) => Promise<void>,
    ): Promise<{ ids: readonly string[]; sql: Awaited<ReturnType<typeof sqlVerify>>; ts: AuditChainResult }> => {
      const tenant = randomUUID();
      for (const i of [1, 2, 3, 4]) await record(pool, tenant, `ROW_${String(i)}`);
      const client = await pool.connect();
      try {
        await client.query('begin');
        const { rows } = await client.query<{ id: string }>(
          'select id::text from audit.audit_event where tenant_id = $1 order by id',
          [tenant],
        );
        const ids = rows.map((r) => r.id);
        await client.query('alter table audit.audit_event disable trigger trg_audit_event_append_only');
        await change(client, ids);
        return { ids, sql: await sqlVerify(client, tenant), ts: await tsVerify(client, tenant) };
      } finally {
        await client.query('rollback');
        client.release();
      }
    };

    it('passes a clean chain', async () => {
      const tenant = randomUUID();
      for (const i of [1, 2, 3]) await record(pool, tenant, `CLEAN_${String(i)}`);
      expect(await sqlVerify(pool, tenant)).toEqual({ checked: '3', first_broken_id: null, reason: null });
      const client = await pool.connect();
      try {
        expect(await tsVerify(client, tenant)).toEqual({ ok: true, checked: 3 });
      } finally {
        client.release();
      }
    });

    it('names an altered row', async () => {
      const r = await tamper((c, ids) =>
        c.query("update audit.audit_event set actor = 'someone-else' where id = $1", [ids[1]]).then(() => undefined),
      );
      expect(r.sql).toMatchObject({ first_broken_id: r.ids[1], reason: 'CONTENT_HASH_MISMATCH' });
      expect(r.ts).toMatchObject({ ok: false, firstBrokenId: r.ids[1], reason: 'CONTENT_HASH_MISMATCH' });
    });

    it('names the row after a deleted one', async () => {
      const r = await tamper((c, ids) =>
        c.query('delete from audit.audit_event where id = $1', [ids[1]]).then(() => undefined),
      );
      expect(r.sql).toMatchObject({ first_broken_id: r.ids[2], reason: 'PREV_HASH_MISMATCH' });
      expect(r.ts).toMatchObject({ ok: false, firstBrokenId: r.ids[2], reason: 'PREV_HASH_MISMATCH' });
    });

    it('names the first of two reordered rows', async () => {
      const r = await tamper(async (c, ids) => {
        await c.query('update audit.audit_event set id = -id where id = $1', [ids[1]]);
        await c.query('update audit.audit_event set id = $1 where id = $2', [ids[1], ids[2]]);
        await c.query('update audit.audit_event set id = $1 where id = $2', [ids[2], `-${String(ids[1])}`]);
      });
      expect(r.sql).toMatchObject({ first_broken_id: r.ids[1], reason: 'PREV_HASH_MISMATCH' });
      expect(r.ts).toMatchObject({ ok: false, firstBrokenId: r.ids[1], reason: 'PREV_HASH_MISMATCH' });
    });
  });

  describe('SR-012: every decision writes a chained event naming its actor, in the same transaction', () => {
    const events = async (tenant: string, subjectText: string) =>
      (
        await pool.query<{ event_type: string; actor: string }>(
          `select event_type, actor from audit.audit_event
            where tenant_id = $1 and subject_id = audit.as_uuid($2) order by id`,
          [tenant, subjectText],
        )
      ).rows.map((r) => `${r.event_type}:${r.actor}`);

    it('an origination request: raised by its maker, approved by its checker, a document presented', async () => {
      const id = `REQ-AUDIT-${randomUUID()}`;
      const req = (state: string, extra: Record<string, unknown> = {}) =>
        JSON.stringify({ state, maker: { principalId: 'stf-maker-01' }, ...extra });
      await inTenant(pool, bankA, async (db) => {
        await db.query(
          `insert into core.origination_request (tenant_id, request_id, partner_id, state, request, correlation_id, created_by)
           values ($1, $2, 'workbench', 'AWAITING_REVIEW', $3::jsonb, $2, 'workbench')`,
          [bankA, id, req('AWAITING_REVIEW')],
        );
        await db.query(
          `insert into evidence.presented_document (tenant_id, request_id, document_type, validation_status, captured_at_epoch,
             captured_tsa_digest, captured_tsa_authority, position, correlation_id, created_by)
           values ($1, $2, 'TRADE_LICENCE', 'PENDING', 1, 'd', 'test', 0, $2, 'stf-maker-01')`,
          [bankA, id],
        );
        await db.query(
          "update core.origination_request set state = 'APPROVED', request = $3::jsonb where tenant_id = $1 and request_id = $2",
          [bankA, id, req('APPROVED', { checker: { principalId: 'stf-checker-01' } })],
        );
      });
      expect(await events(bankA, id)).toEqual([
        'ORIGINATION_REQUEST_AWAITING_REVIEW:stf-maker-01',
        'DOCUMENT_PRESENTED:stf-maker-01',
        'ORIGINATION_REQUEST_APPROVED:stf-checker-01',
      ]);
    });

    it('a consumer offer accepted, and a checkout session through its states', async () => {
      const offer = `OFR-AUDIT-${randomUUID()}`;
      const session = `CHK-AUDIT-${randomUUID()}`;
      await inTenant(pool, bankA, async (db) => {
        await db.query(
          `insert into core.offer (tenant_id, offer_id, applicant_ref, product_code, body, disclosure_version, expires_at_epoch, correlation_id, created_by)
           values ($1, $2, 'applicant-audit', 'bnpl', '{}'::jsonb, 'v1', 1, $2, 'applicant-audit')`,
          [bankA, offer],
        );
        await db.query(
          `insert into core.offer_acceptance (tenant_id, acceptance_id, offer_id, disclosure_version, identity_assertion_id,
             locale_shown, accepted_at_epoch, accepted_tsa_digest, accepted_tsa_authority, correlation_id, created_by)
           values ($1, $2, $3, 'v1', 'asr-audit', 'en-SA', 1, 'd', 'test', $2, 'asr-audit')`,
          [bankA, `ACC-${offer}`, offer],
        );
        await db.query(
          `insert into core.checkout_session (tenant_id, session_id, merchant_id, state, session, correlation_id, created_by)
           values ($1, $2, 'mer-audit', 'OPEN', '{"state":"OPEN"}'::jsonb, $2, 'mer-audit')`,
          [bankA, session],
        );
        await db.query(
          `update core.checkout_session set state = 'BOOKED', session = '{"state":"BOOKED"}'::jsonb
            where tenant_id = $1 and session_id = $2`,
          [bankA, session],
        );
      });
      expect(await events(bankA, offer)).toEqual(['OFFER_ACCEPTED:asr-audit']);
      expect(await events(bankA, session)).toEqual(['CHECKOUT_OPEN:mer-audit', 'CHECKOUT_BOOKED:mer-audit']);
    });

    it('an SME application: the committee decision and the disbursement, each by its own actor', async () => {
      const app = `FR-${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`;
      const event = (type: string, from: number, to: number, actor: string) =>
        [
          `insert into core.business_application_event (tenant_id, application_id, event_type, from_stage, to_stage, actor, detail, occurred_at_epoch, correlation_id)
         values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, 1, $2)`,
          [smeFund, app, type, from, to, actor],
        ] as const;
      await inTenant(pool, smeFund, async (db) => {
        await db.query(
          `insert into core.business_application (tenant_id, application_id, upstream_ref, stage, status, product_code, variant_code,
             currency, requested_minor, tenor_months, grace_months, record, correlation_id, created_by)
           values ($1, $2, $3, 5, 'RECEIVED', 'sme-term-conventional', 'SMALL_LOAN', 'AED', 25000000, 24, 0,
                   '{"status":"RECEIVED"}'::jsonb, $2, 'upstream')`,
          [smeFund, app, `up-${app}`],
        );
        for (const [sql, values] of [
          event('COMMITTEE_APPROVED', 6, 7, 'stf-ae-committee-01'),
          event('DISBURSED', 7, 8, 'stf-ae-finance-01'),
        ])
          await db.query(sql, values);
      });
      expect(await events(smeFund, app)).toEqual([
        'BUSINESS_COMMITTEE_APPROVED:stf-ae-committee-01',
        'BUSINESS_DISBURSED:stf-ae-finance-01',
      ]);
    });

    it('rolls the event back with the act: a refused write leaves no audit row', async () => {
      const id = `REQ-ROLLBACK-${randomUUID()}`;
      await expect(
        inTenant(pool, bankA, async (db) => {
          await db.query(
            `insert into core.origination_request (tenant_id, request_id, partner_id, state, request, correlation_id, created_by)
             values ($1, $2, 'workbench', 'AWAITING_REVIEW', $3::jsonb, $2, 'workbench')`,
            [bankA, id, JSON.stringify({ state: 'AWAITING_REVIEW', maker: { principalId: 'stf-maker-01' } })],
          );
          throw new Error('the act failed after the write');
        }),
      ).rejects.toThrow(/the act failed/);
      expect(await events(bankA, id)).toEqual([]);
    });

    it('leaves every tenant chain verifiable after all of the above', async () => {
      for (const tenant of [bankA, smeFund]) {
        expect((await sqlVerify(pool, tenant))?.first_broken_id).toBeNull();
        const ts = await inTenant(pool, tenant, (db) => verifyAuditChain(db, tenant));
        expect(ts.ok).toBe(true);
      }
    });
  });
});
