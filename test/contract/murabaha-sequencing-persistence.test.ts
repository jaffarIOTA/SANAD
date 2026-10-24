/**
 * Wasl W2 on PostgreSQL (migrations 0003, 0027): the sequence's steps written
 * where the database's own Murabaha controls bind them — the legs in
 * core.contract_leg (immutable, chained, strictly later), the evidence in
 * evidence.evidence (append-only, superseded rather than corrected), the
 * attested risk-period start and sale offer on core.transaction (the offer
 * never inside the interval) — and a process that starts afresh rebuilding
 * exactly the same transaction from the event log.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';

import { recordStep } from '../../services/origination/src/wasl/persistence.ts';
import {
  acquireOwnership,
  confirmPossession,
  decidePossessionEvidence,
  executePurchase,
  executeWaad,
  offerSale,
  recordOwnershipInvoice,
  recordPossessionEvidence,
  validateAndReserve,
} from '../../apps/ops/src/server/murabaha-sequencing.ts';
import {
  type TransactionView,
  getTransaction,
  openTransactionForRequest,
  resetTransactions,
} from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-8);
const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const HOUR = 3600;

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e100000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};
const pdf = (marker: string) => new TextEncoder().encode(`%PDF-1.7\n% warehouse receipt ${marker}\n%%EOF\n`);

let serial = 0;
/**
 * A transaction freshly opened for a newly keyed request. The request book is this process's memory while
 * the transactions are in the database, so on a database an earlier run wrote to, a new request's number
 * can name a request that already has a transaction; that one is passed over and another request keyed.
 */
async function opened(): Promise<TransactionView> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const v = await openedOnce();
    // Ours only if it finances the invoice just keyed: another worker on this database may hold the same request number.
    if (v.transaction.core.tradeReference.invoiceUuid === invoiceOf(serial) && v.transaction.state === 'DRAFT')
      return v;
  }
  throw new Error('no fresh transaction could be opened');
}

const invoiceOf = (n: number) => `9e100000-0000-4000-8000-${RUN}${String(n).padStart(4, '0')}`;

async function openedOnce(): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: invoiceOf(serial),
      invoiceNumber: `W2DB-${RUN}-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  expectOk(approveRequest(keyed.requestId, { principalId: 'stf-senior-01', tenantId: T }));
  // Another run's transactions may hold the next reference; opening again takes the one after.
  for (let attempt = 0; ; attempt += 1) {
    const r = await openTransactionForRequest(T, keyed.requestId, 'stf-senior-01');
    if (r.ok || attempt === 3) return expectOk(r);
  }
}

describe.skipIf(url === undefined)('the Murabaha sequence on PostgreSQL (Wasl W2)', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    vi.stubEnv('SANAD_DATABASE_URL', url ?? '');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(clock);
    resetTransactions();
    // W5a: no facility, no trade. Approved once in this database; later runs find it in force.
    await approveTestFacilities();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('the steps land in the tables the controls bind, and a fresh process rebuilds the same transaction', async () => {
    const ref = (await opened()).transactionRef;
    for (const s of [validateAndReserve, executeWaad, executePurchase]) {
      advance(1);
      expectOk(await s(T, ref, MAKER));
    }
    advance(1);
    expectOk(
      await recordOwnershipInvoice(T, ref, MAKER, {
        invoiceUuid: `7b1e0c4a-2222-4000-8000-${RUN}0001`,
        invoiceHash: `ownership-${RUN}`,
      }),
    );
    advance(1);
    expectOk(await acquireOwnership(T, ref, MAKER));
    advance(1);
    const recorded = expectOk(
      await recordPossessionEvidence(T, ref, MAKER, {
        evidenceType: 'WAREHOUSE_RECEIPT',
        source: 'PARTNER',
        bytes: pdf(`${RUN}-${ref}`),
      }),
    );
    const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
    advance(1);
    expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
    advance(1);
    const possessed = expectOk(await confirmPossession(T, ref, MAKER));
    if (possessed.transaction.state !== 'POSSESSION_CONFIRMED') throw new Error('not possessed');
    clock = Number(possessed.transaction.riskPeriodStartAt.epochSeconds + BigInt(HOUR)) * 1000;
    vi.setSystemTime(clock);
    const offered = expectOk(await offerSale(T, ref, MAKER));

    const row = await pool.query<{ state: string; held: string; legs: string; evidence: string; superseded: string }>(
      `select t.state,
              extract(epoch from t.sale_offered_at - t.risk_period_start_at)::bigint::text held,
              (select count(*) from core.contract_leg l where l.transaction_id = t.id)::text legs,
              (select count(*) from evidence.evidence e where e.transaction_id = t.id)::text evidence,
              (select count(*) from evidence.evidence e where e.transaction_id = t.id and e.superseded_by is not null)::text superseded
         from core.transaction t where t.transaction_ref = $1`,
      [ref],
    );
    expect(row.rows[0]).toMatchObject({ state: 'SALE_OFFERED', legs: '3', evidence: '3', superseded: '1' });
    expect(BigInt(row.rows[0]?.held ?? '0')).toBeGreaterThanOrEqual(BigInt(HOUR));
    const chain = await pool.query<{ seq: number; prev: string | null; hash: string }>(
      `select l.sequence_no seq, l.prev_leg_hash prev, l.content_hash hash from core.contract_leg l
         join core.transaction t on t.id = l.transaction_id where t.transaction_ref = $1 order by l.sequence_no`,
      [ref],
    );
    expect(chain.rows.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(chain.rows[1]?.prev).toBe(chain.rows[0]?.hash);
    expect(chain.rows[2]?.prev).toBe(chain.rows[1]?.hash);

    // A process that starts afresh reads the same transaction back from the event log.
    resetTransactions();
    const reloaded = await getTransaction(T, ref);
    expect(reloaded?.transaction).toEqual(offered.transaction);
    expect(reloaded?.evidence).toEqual(offered.evidence);
  });

  it('the database refuses what the sequence refuses, even to the owner', async () => {
    const ref = (await opened()).transactionRef;
    for (const s of [validateAndReserve, executeWaad]) {
      advance(1);
      expectOk(await s(T, ref, MAKER));
    }
    const refused = async (sql: string, what: string) => {
      const e = await pool.query(sql, [ref]).then(
        () => undefined,
        (x: unknown) => x as { code?: string },
      );
      expect(e, `${what} was accepted`).toBeDefined();
      expect(['23001', '23514'], what).toContain(e?.code);
    };
    await refused(
      `update core.contract_leg set content_hash = 'rewritten'
        where transaction_id = (select id from core.transaction where transaction_ref = $1)`,
      'rewriting an executed leg',
    );
    await refused(
      `update core.transaction set risk_period_start_at = now(), sale_offered_at = now() + interval '10 seconds'
        where transaction_ref = $1`,
      'a sale offered ten seconds into the risk-holding interval',
    );
    await refused(
      `update core.transaction set state = 'POSSESSION_CONFIRMED' where transaction_ref = $1`,
      'possession without its attested start',
    );
  });

  it('a step taken from a state the row has left writes nothing', async () => {
    const v = await opened();
    advance(1);
    expectOk(await validateAndReserve(T, v.transactionRef, MAKER));
    const stale = await recordStep(pool, T, {
      transactionRef: v.transactionRef,
      expectedState: 'DRAFT',
      toState: 'LIMIT_RESERVED',
      event: {
        eventType: 'LIMIT_RESERVED',
        fromState: 'DRAFT',
        toState: 'LIMIT_RESERVED',
        actor: MAKER,
        detail: {},
        occurredAtEpochSeconds: BigInt(Math.floor(clock / 1000)),
      },
      correlationId: v.transaction.core.correlationId,
    });
    expect(stale.ok ? 'written' : stale.error.reason).toBe('TRANSACTION_MOVED');
    const events = await pool.query<{ n: string }>(
      `select count(*)::text n from core.transaction_event e join core.transaction t on t.id = e.transaction_id
        where t.transaction_ref = $1`,
      [v.transactionRef],
    );
    expect(events.rows[0]?.n).toBe('2');
  });

  it('another tenant sees neither the legs nor the evidence', async () => {
    const ref = (await opened()).transactionRef;
    for (const s of [validateAndReserve, executeWaad, executePurchase]) {
      advance(1);
      expectOk(await s(T, ref, MAKER));
    }
    advance(1);
    expectOk(
      await recordOwnershipInvoice(T, ref, MAKER, {
        invoiceUuid: `7b1e0c4a-2222-4000-8000-${RUN}0002`,
        invoiceHash: `ownership-${RUN}-2`,
      }),
    );
    const other = await tenantUuidByCode(pool, 'fintech-b');
    const seen = await inTenant(pool, other, async (db) => {
      const legs = await db.query<{ n: string }>(
        `select count(*)::text n from core.contract_leg l join core.transaction t on t.id = l.transaction_id
          where t.transaction_ref = $1`,
        [ref],
      );
      const evidence = await db.query<{ n: string }>(
        `select count(*)::text n from evidence.evidence e join core.transaction t on t.id = e.transaction_id
          where t.transaction_ref = $1`,
        [ref],
      );
      return { legs: legs.rows[0]?.n, evidence: evidence.rows[0]?.n };
    });
    expect(seen).toEqual({ legs: '0', evidence: '0' });
  });
});
