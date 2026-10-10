/**
 * The controls the database itself enforces, attempted directly (SR-013, SR-014, SR-015).
 *
 * Each case attempts a prohibited write and passes only when PostgreSQL refuses
 * it with the expected class of error: a check violation (23514), a unique
 * violation (23505) or a restrict violation raised by a trigger (23001). Writes
 * are made as the owner, which is the strongest case: the triggers bind even the
 * role that created them. The two races (SR-013, SR-014) run concurrently through
 * the PostgreSQL adapters, as a drawdown would.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { randomUUID } from 'node:crypto';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { money } from '../../core/kernel/money.ts';
import { postgresFinancedInvoiceRegistry } from '../../services/origination/src/financed-invoice-registry-postgres.ts';
import { postgresLimitReservations } from '../../services/origination/src/limit-reservations-postgres.ts';
import { facility, murabahaGraph, type MurabahaGraph } from '../support/murabaha-db.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const CHECK = '23514';
const UNIQUE = '23505';
const RESTRICT = '23001';

async function refusedWith(attempt: Promise<unknown>, code: string, what: string): Promise<void> {
  const error = await attempt.then(
    () => undefined,
    (e: unknown) => e as { code?: string },
  );
  expect(error, `${what} was accepted`).toBeDefined();
  expect(error?.code, what).toBe(code);
}

describe.skipIf(url === undefined)('controls the database enforces (SR-013 to SR-015)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 10 });
  });
  afterAll(async () => {
    await pool.end();
  });

  describe('SR-013: one invoice is financed once (SH-10)', () => {
    const record = (g: MurabahaGraph, invoiceUuid: string, transactionId = g.transactionId) => ({
      tenantId: g.tenantId,
      invoiceUuid,
      invoiceHash: 'hash',
      issuerCr: 'CR-ISSUER',
      recipientCr: 'CR-RECIPIENT',
      financedAmount: money(1_000_000n, 'SAR'),
      transactionId,
      financedAtEpochSeconds: 1_790_000_000n,
    });

    it('lets exactly one of two concurrent drawdowns against one invoice register it', async () => {
      const g = await murabahaGraph(pool);
      const other = await murabahaGraph(pool);
      const registry = postgresFinancedInvoiceRegistry(pool);
      const invoice = randomUUID();
      const results = await Promise.all([
        registry.register(record(g, invoice)),
        registry.register({
          ...record(g, invoice),
          transactionId: (await sameTenantTransaction(pool, g)).transactionId,
        }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.find((r) => !r.ok);
      expect(refused !== undefined && !refused.ok && refused.error).toMatchObject({
        control: 'SH-10',
        reason: 'DUPLICATE_FINANCING',
      });
      expect(other.tenantId).toBe(g.tenantId);
    });

    it('answers a replay of the same drawdown with its own registration', async () => {
      const g = await murabahaGraph(pool);
      const registry = postgresFinancedInvoiceRegistry(pool);
      const invoice = randomUUID();
      const first = await registry.register(record(g, invoice));
      const again = await registry.register(record(g, invoice));
      expect(first.ok && again.ok && first.value.registryId === again.value.registryId).toBe(true);
      expect(await registry.lookup(g.tenantId, invoice)).toEqual({ transactionId: g.transactionId });
    });

    it('never changes or loses a registration', async () => {
      const g = await murabahaGraph(pool);
      const invoice = randomUUID();
      await postgresFinancedInvoiceRegistry(pool).register(record(g, invoice));
      await refusedWith(
        pool.query("update core.financed_invoice_registry set invoice_hash = 'x' where invoice_uuid = $1", [invoice]),
        RESTRICT,
        'update a registration',
      );
      await refusedWith(
        pool.query('delete from core.financed_invoice_registry where invoice_uuid = $1', [invoice]),
        RESTRICT,
        'delete a registration',
      );
    });
  });

  describe('SR-014: a facility is never over-committed', () => {
    it('lets exactly one of two concurrent holds that together exceed the limit commit', async () => {
      const g = await murabahaGraph(pool);
      const facilityId = await facility(pool, g, 1_000_000n);
      const limits = postgresLimitReservations(pool);
      const hold = () =>
        limits.hold({
          tenantId: g.tenantId,
          facilityId,
          amount: money(600_000n, 'SAR'),
          holdSeconds: 600,
          correlationId: randomUUID(),
        });
      const results = await Promise.all([hold(), hold()]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const refused = results.find((r) => !r.ok);
      expect(refused !== undefined && !refused.ok && refused.error.reason).toBe('FACILITY_OVER_COMMITTED');

      // Released, the limit is free again; consumed, a reservation cannot be settled twice.
      const held = results.find((r) => r.ok);
      const id = held !== undefined && held.ok ? held.value.reservationId : '';
      expect((await limits.release(g.tenantId, id)).ok).toBe(true);
      expect((await limits.release(g.tenantId, id)).ok).toBe(false);
      const next = await hold();
      expect(next.ok).toBe(true);
      if (next.ok) expect((await limits.consume(g.tenantId, next.value.reservationId, g.transactionId)).ok).toBe(true);
    });

    it('refuses a single hold above the limit', async () => {
      const g = await murabahaGraph(pool);
      const facilityId = await facility(pool, g, 500_000n);
      const r = await postgresLimitReservations(pool).hold({
        tenantId: g.tenantId,
        facilityId,
        amount: money(500_001n, 'SAR'),
        holdSeconds: 600,
        correlationId: randomUUID(),
      });
      expect(!r.ok && r.error.reason).toBe('FACILITY_OVER_COMMITTED');
    });
  });

  describe('SR-015: the Murabaha controls in the schema', () => {
    it('refuses a total that is not cost plus profit (SH-02)', async () => {
      const g = await murabahaGraph(pool);
      await refusedWith(
        pool.query('update core.transaction set sale_price_amount_minor = sale_price_amount_minor + 1 where id = $1', [
          g.transactionId,
        ]),
        CHECK,
        'total ≠ cost + profit',
      );
    });

    it('refuses a sale offered before the risk-holding interval has run (gate 3)', async () => {
      const g = await murabahaGraph(pool);
      await refusedWith(
        pool.query(
          "update core.transaction set risk_period_start_at = now(), sale_offered_at = now() + interval '1 second' where id = $1",
          [g.transactionId],
        ),
        CHECK,
        'sale inside the risk interval',
      );
      await refusedWith(
        pool.query("update core.transaction set state = 'POSSESSION_CONFIRMED' where id = $1", [g.transactionId]),
        CHECK,
        'possession without a risk start',
      );
    });

    it('freezes cost, profit, total, risk interval and approval once the sale is offered', async () => {
      const g = await murabahaGraph(pool);
      await pool.query(
        `update core.transaction set state = 'EXECUTED', risk_period_start_at = now() - interval '2 hours',
           sale_offered_at = now() where id = $1`,
        [g.transactionId],
      );
      for (const [set, what] of [
        ['cost_amount_minor = cost_amount_minor - 1, sale_price_amount_minor = sale_price_amount_minor - 1', 'cost'],
        [
          'profit_amount_minor = profit_amount_minor + 1, sale_price_amount_minor = sale_price_amount_minor + 1',
          'profit',
        ],
        ['risk_period_required_s = 1', 'risk interval'],
        [`shariah_approval_id = '${(await murabahaGraph(pool)).approvalId}'`, 'governing approval'],
      ] as const satisfies readonly (readonly [string, string])[])
        await refusedWith(
          pool.query(`update core.transaction set ${set} where id = $1`, [g.transactionId]),
          RESTRICT,
          what,
        );
    });

    describe('contract legs: one document per leg, strictly ordered, chained, immutable', () => {
      const leg = (
        g: MurabahaGraph,
        o: { seq: number; type: string; prev?: string | null; at?: string; doc?: string },
      ) =>
        pool.query<{ id: string; content_hash: string }>(
          `insert into core.contract_leg (tenant_id, transaction_id, leg_type, sequence_no, document_id, content_hash,
             prev_leg_hash, executed_at, tsa_token_digest, tsa_token, template_version_id, counterparty_role,
             counterparty_cr, correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, 'digest', '\\x00', gen_random_uuid(), 'SELLER', 'CR-1',
                   gen_random_uuid())
           returning id::text, content_hash`,
          [
            g.tenantId,
            g.transactionId,
            o.type,
            o.seq,
            o.doc ?? randomUUID(),
            `leg-${String(o.seq)}-${randomUUID()}`,
            o.prev ?? null,
            o.at ?? '2026-10-01T10:00:00Z',
          ],
        );

      it('refuses a broken chain, an earlier timestamp, a reused document or type, and any change', async () => {
        const g = await murabahaGraph(pool);
        const first = (await leg(g, { seq: 1, type: 'WAAD', at: '2026-10-01T10:00:00Z' })).rows[0];
        const hash = first?.content_hash as string;
        await refusedWith(
          leg(g, { seq: 2, type: 'PURCHASE', prev: hash, at: '2026-10-01T09:00:00Z' }),
          RESTRICT,
          'earlier leg',
        );
        await refusedWith(
          leg(g, { seq: 2, type: 'PURCHASE', prev: 'not-the-predecessor', at: '2026-10-01T11:00:00Z' }),
          RESTRICT,
          'broken chain',
        );
        await refusedWith(
          leg(g, { seq: 3, type: 'WAAD', prev: hash, at: '2026-10-01T12:00:00Z' }),
          UNIQUE,
          'leg type twice',
        );
        const doc = randomUUID();
        await leg(g, { seq: 2, type: 'PURCHASE', prev: hash, at: '2026-10-01T11:00:00Z', doc });
        const other = await murabahaGraph(pool);
        await refusedWith(leg(other, { seq: 1, type: 'WAAD', doc }), UNIQUE, 'one document on two legs');
        await refusedWith(
          leg(other, { seq: 1, type: 'WAAD', prev: 'anything' }),
          CHECK,
          'first leg with a predecessor',
        );
        await refusedWith(
          pool.query("update core.contract_leg set counterparty_cr = 'x' where id = $1", [first?.id]),
          RESTRICT,
          'change a leg',
        );
        await refusedWith(
          pool.query('delete from core.contract_leg where id = $1', [first?.id]),
          RESTRICT,
          'delete a leg',
        );
      });
    });

    it('never deletes evidence, and never changes it once superseded', async () => {
      const g = await murabahaGraph(pool);
      const evidence = async () =>
        (
          await pool.query<{ id: string }>(
            `insert into evidence.evidence (tenant_id, transaction_id, evidence_type, gate_satisfied, source, artefact_uri,
               artefact_hash, captured_at, captured_tsa_digest, validation_status, correlation_id)
             values ($1, $2, 'OWNERSHIP_INVOICE', 'GATE_1_OWNERSHIP', 'E_INVOICING_AUTHORITY', 'urn:x', 'h', now(), 'd',
                     'VALID', gen_random_uuid())
             returning id::text`,
            [g.tenantId, g.transactionId],
          )
        ).rows[0]?.id as string;
      const old = await evidence();
      const replacement = await evidence();
      await refusedWith(pool.query('delete from evidence.evidence where id = $1', [old]), RESTRICT, 'delete evidence');
      await pool.query('update evidence.evidence set superseded_by = $2 where id = $1', [old, replacement]);
      await refusedWith(
        pool.query("update evidence.evidence set validation_status = 'INVALID' where id = $1", [old]),
        RESTRICT,
        'change superseded evidence',
      );
    });

    it('never raises an obligation, never reduces a waiver, and keeps the schedule summing to what is payable', async () => {
      const g = await murabahaGraph(pool);
      const obligation = (
        await pool.query<{ id: string }>(
          `insert into core.obligation (tenant_id, transaction_id, total_amount_minor, correlation_id)
           values ($1, $2, 1050000, gen_random_uuid()) returning id::text`,
          [g.tenantId, g.transactionId],
        )
      ).rows[0]?.id as string;
      await refusedWith(
        pool.query('update core.obligation set total_amount_minor = 1050001 where id = $1', [obligation]),
        RESTRICT,
        'raise the total',
      );
      await pool.query('update core.obligation set waived_amount_minor = 100 where id = $1', [obligation]);
      await refusedWith(
        pool.query('update core.obligation set waived_amount_minor = 50 where id = $1', [obligation]),
        RESTRICT,
        'reduce a waiver',
      );
      // Payable is now 1,049,900; a schedule summing to anything else does not commit.
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const [n, amount] of [
          [1, 500_000],
          [2, 550_000],
        ] as const)
          await client.query(
            `insert into core.instalment (tenant_id, obligation_id, instalment_no, due_date_g, due_date_h, amount_minor)
             values ($1, $2, $3, current_date + $3 * 30, '1448-07-01', $4)`,
            [g.tenantId, obligation, n, amount],
          );
        await refusedWith(client.query('commit'), RESTRICT, 'a schedule that does not sum');
      } finally {
        client.release();
      }
    });

    it('books late-payment charges only to charity, and never changes them (SH-07)', async () => {
      const g = await murabahaGraph(pool);
      const charity = (accountClass: string) =>
        pool.query<{ id: string }>(
          `insert into core.charity_ledger (tenant_id, transaction_id, account_class, amount_minor, reason,
             computation_basis_config_key, shariah_approval_id, recorded_at, correlation_id)
           values ($1, $2, $3, 1000, 'LATE_PAYMENT', 'late.v1', $4, now(), gen_random_uuid()) returning id::text`,
          [g.tenantId, g.transactionId, accountClass, g.approvalId],
        );
      await refusedWith(charity('INCOME'), CHECK, 'late charge to income');
      const id = (await charity('CHARITY_LIABILITY')).rows[0]?.id;
      await refusedWith(
        pool.query('update core.charity_ledger set amount_minor = 1 where id = $1', [id]),
        RESTRICT,
        'change a charity entry',
      );
      await refusedWith(
        pool.query('delete from core.charity_ledger where id = $1', [id]),
        RESTRICT,
        'delete a charity entry',
      );
    });

    it('never changes or deletes an audit row, even as the owner', async () => {
      // A row to attempt it on: a fresh database has none.
      await pool.query(
        "select audit.record_event(gen_random_uuid(), 'test.subject', gen_random_uuid(), 'TEST', null, null, 'test', gen_random_uuid())",
      );
      await refusedWith(
        pool.query("update audit.audit_event set actor = 'x' where id = (select min(id) from audit.audit_event)"),
        RESTRICT,
        'change an audit row',
      );
      await refusedWith(
        pool.query('delete from audit.audit_event where id = (select min(id) from audit.audit_event)'),
        RESTRICT,
        'delete an audit row',
      );
    });
  });
});

/** A second transaction under the same tenant, programme and counterparty: a different drawdown. */
async function sameTenantTransaction(pool: Pool, g: MurabahaGraph): Promise<{ readonly transactionId: string }> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.transaction (tenant_id, programme_id, counterparty_id, structure_code, structure_definition_id,
       structure_version, state, cost_amount_minor, profit_amount_minor, sale_price_amount_minor, tenor_days,
       maturity_date_g, maturity_date_h, risk_period_required_s, shariah_approval_id, credit_policy_version, correlation_id)
     values ($1, $2, $3, 'MURABAHA', 'murabaha-v1', 1, 'DRAFT', 1000000, 50000, 1050000, 90, current_date + 90,
             '1448-06-01', 3600, $4, 'policy-v1', gen_random_uuid())
     returning id::text`,
    [g.tenantId, g.programmeId, g.counterpartyId, g.approvalId],
  );
  return { transactionId: rows[0]?.id as string };
}
