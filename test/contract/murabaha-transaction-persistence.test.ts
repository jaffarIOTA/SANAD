/**
 * Wasl W1 on PostgreSQL (migrations 0003, 0027): an opened transaction and its
 * event log, what the database itself refuses, and what another tenant sees.
 * Each refusal is attempted directly as the owner — the strongest case, since
 * the constraints and triggers bind even the role that created them.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';
import { priceMurabaha } from '@sanad/products/murabaha-scf/pricing/murabaha.ts';
import type { TransactionCore } from '@sanad/products/murabaha-scf/sequencing/state.ts';

import {
  type TransactionEventRow,
  decodeCore,
  encodeCore,
  insertOpenedTransaction,
  loadTransactions,
} from '../../apps/ops/src/server/murabaha-persistence.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-9);
const UNIQUE = '23505';
const CHECK = '23514';

function core(n: number): TransactionCore {
  return {
    transactionId: `WT-${RUN}${String(n)}`,
    tenantId: 'bank-a',
    programmeId: 'prg-0001',
    counterpartyId: 'Rawabi Industrial Supplies Establishment',
    structureCode: 'MURABAHA',
    structureDefinitionId: 'MURABAHA_DISTRIBUTOR',
    structureVersion: 3,
    shariahApprovalId: 'SSB-A-2026-014',
    riskPeriodRequiredSeconds: 3600,
    pricing: expectOk(priceMurabaha(money(9_800_000n), money(136_932n))),
    tenorDays: 60,
    maturityDateGregorian: '2026-12-16',
    maturityDateHijri: '1448-07-07',
    tradeReference: {
      type: 'CLEARED_INVOICE',
      invoiceUuid: `3cf5d9a2-0000-4000-8000-${RUN.padStart(11, '0')}${String(n)}`,
      invoiceHash: 'h',
      issuerCr: '1010000002',
      recipientCr: '7001000001',
    },
    decisionId: `approval:req-${RUN}-${String(n)}`,
    creditPolicyVersion: 'wasl-distributor@1.0.0',
    correlationId: `cor-${RUN}-${String(n)}`,
  };
}

const opened = (c: TransactionCore): TransactionEventRow => ({
  eventType: 'TRANSACTION_OPENED',
  fromState: null,
  toState: 'DRAFT',
  actor: 'stf-senior-01',
  detail: { core: encodeCore(c) },
  occurredAtEpochSeconds: 1_791_500_000n,
});

async function refusedWith(attempt: Promise<unknown>, code: string, what: string): Promise<void> {
  const error = await attempt.then(
    () => undefined,
    (e: unknown) => e as { code?: string },
  );
  expect(error, `${what} was accepted`).toBeDefined();
  expect(error?.code, what).toBe(code);
}

describe.skipIf(url === undefined)('Murabaha transactions on PostgreSQL (Wasl W1)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('what is opened is what is loaded: the figures, the links and the event, the core rebuilt exactly', async () => {
    const c = core(1);
    const ref = c.transactionId;
    expectOk(
      await insertOpenedTransaction(pool, 'bank-a', {
        transactionRef: ref,
        requestRef: `req-${RUN}-1`,
        core: c,
        event: opened(c),
      }),
    );
    const loaded = (await loadTransactions(pool, 'bank-a')).find((t) => t.transactionRef === ref);
    expect(loaded).toMatchObject({ requestRef: `req-${RUN}-1`, state: 'DRAFT' });
    expect(loaded?.events).toHaveLength(1);
    expect(decodeCore(loaded?.events[0]?.detail['core'])).toEqual(c);
    const row = await pool.query<{ cost: string; profit: string; sale: string; uuid: string }>(
      `select cost_amount_minor::text cost, profit_amount_minor::text profit, sale_price_amount_minor::text sale,
              trade_invoice_uuid::text uuid from core.transaction where transaction_ref = $1`,
      [ref],
    );
    expect(row.rows[0]).toEqual({
      cost: '9800000',
      profit: '136932',
      sale: '9936932',
      uuid: c.tradeReference.invoiceUuid,
    });
  });

  it('one transaction per request: a second opening is refused, and nothing is written', async () => {
    const a = core(2);
    const b = { ...core(3), transactionId: `WT-${RUN}4` };
    expectOk(
      await insertOpenedTransaction(pool, 'bank-a', {
        transactionRef: a.transactionId,
        requestRef: `req-${RUN}-2`,
        core: a,
        event: opened(a),
      }),
    );
    const again = await insertOpenedTransaction(pool, 'bank-a', {
      transactionRef: b.transactionId,
      requestRef: `req-${RUN}-2`,
      core: b,
      event: opened(b),
    });
    expect(again.ok ? 'written' : again.error.reason).toBe('TRANSACTION_ALREADY_OPEN');
    const count = await pool.query<{ n: string }>(
      'select count(*)::text n from core.transaction where transaction_ref = $1',
      [b.transactionId],
    );
    expect(count.rows[0]?.n).toBe('0');
  });

  it('a transaction keeps its request and trade, and its event log is append-only', async () => {
    const c = core(5);
    expectOk(
      await insertOpenedTransaction(pool, 'bank-a', {
        transactionRef: c.transactionId,
        requestRef: `req-${RUN}-5`,
        core: c,
        event: opened(c),
      }),
    );
    await refusedWith(
      pool.query(`update core.transaction set request_ref = 'req-other' where transaction_ref = $1`, [c.transactionId]),
      '23001',
      'moving a transaction to another request',
    );
    await refusedWith(
      pool.query(`update core.transaction set trade_invoice_uuid = gen_random_uuid() where transaction_ref = $1`, [
        c.transactionId,
      ]),
      '23001',
      'swapping the trade under a transaction',
    );
    await refusedWith(
      pool.query(
        `update core.transaction_event set actor = 'someone-else'
          where transaction_id = (select id from core.transaction where transaction_ref = $1)`,
        [c.transactionId],
      ),
      '23001',
      'rewriting the event log',
    );
  });

  it('a transaction opened from the workbench carries every link, or none', async () => {
    // Copy a real row's references, then leave out the request and the trade.
    await refusedWith(
      pool.query(
        `insert into core.transaction (tenant_id, programme_id, counterparty_id, structure_code, structure_definition_id,
           structure_version, state, cost_amount_minor, profit_amount_minor, sale_price_amount_minor, tenor_days,
           maturity_date_g, maturity_date_h, risk_period_required_s, shariah_approval_id, credit_policy_version,
           correlation_id, transaction_ref)
         select tenant_id, programme_id, counterparty_id, structure_code, structure_definition_id, structure_version,
           'DRAFT', cost_amount_minor, profit_amount_minor, sale_price_amount_minor, tenor_days, maturity_date_g,
           maturity_date_h, risk_period_required_s, shariah_approval_id, credit_policy_version, gen_random_uuid(), $1
           from core.transaction where transaction_ref is not null limit 1`,
        [`WT-${RUN}9`],
      ),
      CHECK,
      'a reference without its request and trade',
    );
  });

  it('another tenant sees neither the transaction nor its events', async () => {
    const c = core(6);
    expectOk(
      await insertOpenedTransaction(pool, 'bank-a', {
        transactionRef: c.transactionId,
        requestRef: `req-${RUN}-6`,
        core: c,
        event: opened(c),
      }),
    );
    const other = await tenantUuidByCode(pool, 'fintech-b');
    const seen = await inTenant(pool, other, async (db) => {
      const t = await db.query<{ n: string }>(
        'select count(*)::text n from core.transaction where transaction_ref = $1',
        [c.transactionId],
      );
      const e = await db.query<{ n: string }>(
        `select count(*)::text n from core.transaction_event e join core.transaction t on t.id = e.transaction_id
          where t.transaction_ref = $1`,
        [c.transactionId],
      );
      return { transactions: t.rows[0]?.n, events: e.rows[0]?.n };
    });
    expect(seen).toEqual({ transactions: '0', events: '0' });
    expect((await loadTransactions(pool, 'fintech-b')).some((t) => t.transactionRef === c.transactionId)).toBe(false);
  });

  it('the unique constraint names are the ones the service reads', async () => {
    const names = await pool.query<{ indexname: string }>(
      `select indexname from pg_indexes where schemaname = 'core' and tablename = 'transaction'
         and indexname in ('transaction_ref_once', 'transaction_request_once') order by 1`,
    );
    expect(names.rows.map((r) => r.indexname)).toEqual(['transaction_ref_once', 'transaction_request_once']);
    expect(UNIQUE).toBe('23505');
  });
});
