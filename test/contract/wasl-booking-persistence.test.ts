/**
 * Wasl W3 on PostgreSQL (migration 0003's obligation tables): the accepted
 * sale's booking lands where the database's own controls bind it — the
 * obligation's total fixed (SH-02), its schedule summing to that total at
 * commit, the transaction ACTIVE with the core's reference — and the
 * acceptance and booking are rebuilt from the event log by a fresh process.
 *
 * Runs only with SANAD_TEST_DATABASE_URL (CI: "Database controls").
 */
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { inTenant } from '@sanad/origination/tenant-scope.ts';

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
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { bookExecutedSale } from '../../services/origination/src/wasl/booking.ts';
import { assertionReplayGuard } from '../../services/origination/src/wasl/identity.ts';
import { recordBillResult } from '../../services/origination/src/wasl/collection-results.ts';
import {
  approveDisbursement,
  assessLateAmount,
  confirmLateAmount,
  lateAmounts,
  proposeDisbursement,
  proposeLateAmounts,
} from '../../services/origination/src/wasl/late-amounts.ts';
import { presentDueInstalments, recordCollectionResult } from '../../services/origination/src/wasl/settlement.ts';
import { acceptSaleOffer } from '../../services/origination/src/wasl/steps.ts';

const url = process.env['SANAD_TEST_DATABASE_URL'];
const RUN = String(Date.now()).slice(-8);
const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e300000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

let serial = 0;
const invoiceOf = (n: number) => `9e300000-0000-4000-8000-${RUN}${String(n).padStart(4, '0')}`;
async function openedOnce(): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: invoiceOf(serial),
      invoiceNumber: `W3DB-${RUN}-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  expectOk(approveRequest(keyed.requestId, { principalId: 'stf-senior-01', tenantId: T }));
  for (let attempt = 0; ; attempt += 1) {
    const r = await openTransactionForRequest(T, keyed.requestId, 'stf-senior-01');
    if (r.ok || attempt === 3) return expectOk(r);
  }
}

/**
 * A freshly opened transaction, walked to its accepted sale. The request book is this process's memory and the
 * transactions are in the database, so a request number an earlier run used is passed over (as in W2's test).
 */
async function accepted(): Promise<TransactionView> {
  let v: TransactionView | undefined;
  for (let attempt = 0; attempt < 100 && v === undefined; attempt += 1) {
    const o = await openedOnce();
    // Ours only if it finances the invoice just keyed: another worker on this database may hold the same request number.
    if (o.transaction.core.tradeReference.invoiceUuid === invoiceOf(serial) && o.transaction.state === 'DRAFT') v = o;
  }
  if (v === undefined) throw new Error('no fresh transaction could be opened');
  const ref = v.transactionRef;
  for (const s of [validateAndReserve, executeWaad, executePurchase]) {
    advance(1);
    expectOk(await s(T, ref, MAKER));
  }
  advance(1);
  expectOk(
    await recordOwnershipInvoice(T, ref, MAKER, {
      invoiceUuid: `7b1e0c4a-5555-4000-8000-${RUN}${String(serial).padStart(4, '0')}`,
      invoiceHash: `ownership-w3db-${RUN}-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'PARTNER',
      bytes: new TextEncoder().encode(`%PDF-1.7\n% w3db ${RUN} ${ref}\n%%EOF\n`),
    }),
  );
  advance(1);
  const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
  expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
  advance(1);
  expectOk(await confirmPossession(T, ref, MAKER));
  advance(3600 + 60);
  expectOk(await offerSale(T, ref, MAKER));
  advance(60);
  return expectOk(
    await acceptSaleOffer(T, ref, 'distributor:sig-rawabi-01', {
      assertionId: `demo-approve-${RUN}`,
      offerHash: 'a'.repeat(64),
      signatoryRef: 'sig-rawabi-01',
    }),
  );
}

describe.skipIf(url === undefined)('booking an accepted Murabaha on PostgreSQL (Wasl W3)', () => {
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
    await recordTestApprovals();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('the obligation and its schedule are booked with the transaction ACTIVE, and read back the same', async () => {
    const v = await accepted();
    expect(v.transaction.state).toBe('EXECUTED');
    advance(1);
    const active = expectOk(await bookExecutedSale(T, v.transactionRef, MAKER));
    expect(active.transaction.state).toBe('ACTIVE');
    const row = await pool.query<{ state: string; total: string; booking: string; scheduled: string; n: string }>(
      `select t.state, o.total_amount_minor::text total, o.booking_ref booking,
              (select sum(amount_minor) from core.instalment i where i.obligation_id = o.id)::text scheduled,
              (select count(*) from core.instalment i where i.obligation_id = o.id)::text n
         from core.transaction t join core.obligation o on o.transaction_id = t.id where t.transaction_ref = $1`,
      [v.transactionRef],
    );
    const sale = v.transaction.core.pricing.salePriceAmount.minorUnits.toString();
    expect(row.rows[0]).toMatchObject({ state: 'ACTIVE', total: sale, scheduled: sale });
    expect(row.rows[0]?.booking).toMatch(/^TRX-DEMO-/);
    // A fresh process reads the same transaction back.
    resetTransactions();
    expect((await getTransaction(T, v.transactionRef))?.transaction).toEqual(active.transaction);
    // Booked once.
    const again = await bookExecutedSale(T, v.transactionRef, MAKER);
    expect(again.ok ? 'booked twice' : again.error.reason).toBe('STEP_NOT_AVAILABLE');
  });

  it('the database refuses a changed total or a schedule that no longer sums to it, even to the owner', async () => {
    const v = await accepted();
    advance(1);
    expectOk(await bookExecutedSale(T, v.transactionRef, MAKER));
    const refused = async (sql: string, what: string) => {
      const e = await pool.query(sql, [v.transactionRef]).then(
        () => undefined,
        (x: unknown) => x as { code?: string },
      );
      expect(e, `${what} was accepted`).toBeDefined();
      expect(e?.code, what).toBe('23001');
    };
    await refused(
      `update core.obligation set total_amount_minor = total_amount_minor + 1
        where transaction_id = (select id from core.transaction where transaction_ref = $1)`,
      'raising the total of a booked obligation',
    );
    await refused(
      `update core.instalment set amount_minor = amount_minor + 100
        where obligation_id = (select o.id from core.obligation o join core.transaction t on t.id = o.transaction_id
                                where t.transaction_ref = $1)`,
      'a schedule that no longer sums to the total',
    );
  });

  it('W4a: the seller’s payment and the SADAD bill are on the outbox, and a receipt settles the obligation', async () => {
    const v = await accepted();
    advance(1);
    expectOk(await bookExecutedSale(T, v.transactionRef, MAKER));
    const outbox = async (key: string) =>
      (
        await pool.query<{ kind: string; payload: Record<string, string>; state: string }>(
          `select kind, payload, state from core.outbox_event where idempotency_key = $1`,
          [key],
        )
      ).rows;
    expect(await outbox(`wasl:${v.transactionRef}:seller`)).toEqual([
      expect.objectContaining({
        kind: 'PAYMENT_DISBURSE',
        state: 'PENDING',
        payload: expect.objectContaining({ beneficiaryIban: 'SA0380000000608010167519' }),
      }),
    ]);
    advance(54 * 86_400);
    expectOk(await presentDueInstalments(T, v.transactionRef, MAKER));
    expect(await outbox(`wasl:${v.transactionRef}:collect:I1`)).toEqual([
      expect.objectContaining({ kind: 'BILL_PRESENT', state: 'PENDING' }),
    ]);
    advance(1);
    const settled = expectOk(
      await recordCollectionResult(
        T,
        v.transactionRef,
        {
          idempotencyKey: `wasl:${v.transactionRef}:collect:I1`,
          status: 'PAID',
          reference: 'SADAD-DB',
          receivedOn: '2026-12-11',
          source: 'FIXTURE',
        },
        'sadad',
      ),
    );
    expect(settled.transaction.state).toBe('SETTLED');
    const row = await pool.query<{ state: string; paid: string; total: string }>(
      `select t.state, o.paid_amount_minor::text paid, o.total_amount_minor::text total
         from core.transaction t join core.obligation o on o.transaction_id = t.id where t.transaction_ref = $1`,
      [v.transactionRef],
    );
    expect(row.rows[0]).toEqual({ state: 'SETTLED', paid: row.rows[0]?.total, total: row.rows[0]?.total });
    // Paid beyond the total: refused by the database, even to the owner.
    const e = await pool
      .query(
        `update core.obligation set paid_amount_minor = paid_amount_minor + 1
          where transaction_id = (select id from core.transaction where transaction_ref = $1)`,
        [v.transactionRef],
      )
      .then(
        () => undefined,
        (x: unknown) => x as { code?: string },
      );
    expect(e?.code).toBe('23514');
  });

  it('W4b-2: a collected late amount is raised once in core.charity_ledger, written once, and disbursed once', async () => {
    const v = await accepted();
    const ref = v.transactionRef;
    advance(1);
    const booked = expectOk(await bookExecutedSale(T, ref, MAKER));
    // Eight days past the due date: beyond bank-a's five days' grace.
    clock = Date.parse(`${booked.transaction.core.maturityDateGregorian}T09:00:00Z`) + 8 * 86_400_000;
    vi.setSystemTime(clock);
    expectOk(await proposeLateAmounts(T, ref, 'system:test-cycle'));
    advance(1);
    expectOk(
      await assessLateAmount(T, ref, 'stf-maker-02', {
        sequenceNumber: 1,
        assessment: 'ABLE_BUT_UNWILLING',
        note: 'n',
      }),
    );
    advance(1);
    expectOk(await confirmLateAmount(T, ref, CHECKER, 1));
    const key = `wasl:${ref}:late:I1`;
    const bill = await pool.query<{ kind: string; subject_ref: string }>(
      `select kind, subject_ref from core.outbox_event where idempotency_key = $1`,
      [key],
    );
    expect(bill.rows).toEqual([{ kind: 'BILL_PRESENT', subject_ref: `${ref}-L1` }]);
    advance(1);
    expectOk(
      await recordBillResult(
        T,
        ref,
        { idempotencyKey: key, status: 'PAID', reference: 'SADAD-DB-L', receivedOn: '2026-12-30', source: 'FIXTURE' },
        'sadad',
      ),
    );
    const ledger = async () =>
      (
        await pool.query<{
          id: string;
          amount: string;
          reason: string;
          account_class: string;
          source_ref: string;
          recipient_id: string | null;
          paid: string;
        }>(
          `select c.id::text, c.amount_minor::text amount, c.reason, c.account_class, c.source_ref, c.recipient_id,
                  o.paid_amount_minor::text paid
             from core.charity_ledger c join core.transaction t on t.id = c.transaction_id
             join core.obligation o on o.transaction_id = t.id where t.transaction_ref = $1`,
          [ref],
        )
      ).rows;
    const raised = await ledger();
    expect(raised).toEqual([
      expect.objectContaining({
        amount: '50000',
        reason: 'LATE_PAYMENT',
        account_class: 'CHARITY_LIABILITY',
        source_ref: key,
        recipient_id: null,
        // Never applied to the obligation: nothing was paid on it.
        paid: '0',
      }),
    ]);
    // A fresh process reads the same late amount back from the event log.
    resetTransactions();
    expect(lateAmounts((await getTransaction(T, ref)) as TransactionView)[0]?.status).toBe('COLLECTED');
    const refused = async (sql: string, values: readonly unknown[], what: string) => {
      const e = await pool.query(sql, [...values]).then(
        () => undefined,
        (x: unknown) => x as { code?: string; constraint?: string },
      );
      expect(e, `${what} was accepted`).toBeDefined();
      return e;
    };
    // The same collection twice, even by the owner: refused by the unique source.
    const twice = await refused(
      `insert into core.charity_ledger (tenant_id, transaction_id, amount_minor, reason, computation_basis_config_key,
         shariah_approval_id, recorded_at, source_ref, correlation_id)
       select tenant_id, transaction_id, amount_minor, reason, computation_basis_config_key, shariah_approval_id,
              recorded_at, source_ref, correlation_id from core.charity_ledger where id = $1::uuid`,
      [raised[0]?.id],
      'a second entry for one collection',
    );
    expect(twice?.constraint).toBe('charity_ledger_source_once');
    // Its amount, or what raised it, never changes.
    for (const set of [`amount_minor = amount_minor + 1`, `source_ref = 'other'`])
      expect(
        (await refused(`update core.charity_ledger set ${set} where id = $1::uuid`, [raised[0]?.id], set))?.code,
      ).toBe('23001');

    advance(1);
    expectOk(await proposeDisbursement(T, ref, 'stf-finance-01', { sequenceNumber: 1, recipientId: 'chr-a-01' }));
    advance(1);
    expectOk(await approveDisbursement(T, ref, CHECKER, 1));
    expect((await ledger())[0]).toMatchObject({ recipient_id: 'chr-a-01' });
    const pay = await pool.query<{ kind: string; payload: Record<string, string> }>(
      `select kind, payload from core.outbox_event where idempotency_key = $1`,
      [`wasl:${ref}:charity:I1:pay`],
    );
    expect(pay.rows).toEqual([
      expect.objectContaining({
        kind: 'PAYMENT_DISBURSE',
        payload: expect.objectContaining({ beneficiaryIban: 'SA1380000000000000000101', minorUnits: '50000' }),
      }),
    ]);
    // Disbursed once: a second completion is refused by the write-once trigger.
    expect(
      (
        await refused(
          `update core.charity_ledger set recipient_id = 'chr-a-02' where id = $1::uuid`,
          [raised[0]?.id],
          'a second disbursement',
        )
      )?.code,
    ).toBe('23001');
  });

  it('W5a: the hold is consumed at purchase, the invoice registered once, and the facility repaid on settlement', async () => {
    const v = await accepted();
    const ref = v.transactionRef;
    const cost = v.transaction.core.pricing.costAmount.minorUnits.toString();
    const row = async () =>
      (
        await pool.query<{
          reservation: string;
          amount: string;
          facility: string;
          approval: string | null;
          decision: string | null;
          registered: string;
        }>(
          `select r.state reservation, r.amount_minor::text amount, r.facility_id::text facility,
                  f.approval_id::text approval, f.decision_id::text decision,
                  (select count(*) from core.financed_invoice_registry g where g.transaction_id = t.id)::text registered
             from core.transaction t
             join core.limit_reservation r on r.transaction_id = t.id
             join core.facility f on f.id = r.facility_id
            where t.transaction_ref = $1`,
          [ref],
        )
      ).rows[0];
    const utilised = async (facility: string) =>
      BigInt(
        (
          await pool.query<{ u: string }>('select utilised_minor::text u from core.facility where id = $1::uuid', [
            facility,
          ])
        ).rows[0]?.u ?? '0',
      );
    const bought = await row();
    // Authorised by an approval, not a scored decision; the hold became utilisation at the purchase.
    expect(bought).toMatchObject({ reservation: 'CONSUMED', amount: cost, decision: null, registered: '1' });
    expect(bought?.approval).toMatch(/^[0-9a-f-]{36}$/);
    const facility = bought?.facility ?? '';
    const before = await utilised(facility);
    expect(before).toBeGreaterThanOrEqual(BigInt(cost));

    const refused = async (sql: string, values: readonly unknown[]) =>
      pool.query(sql, [...values]).then(
        () => undefined,
        (x: unknown) => x as { code?: string; constraint?: string },
      );
    // Financing the same invoice again, even by the owner: the registry's unique constraint.
    const again = await refused(
      `insert into core.financed_invoice_registry (tenant_id, invoice_uuid, invoice_hash, issuer_cr, recipient_cr,
         financed_amount_minor, transaction_id, correlation_id)
       select tenant_id, invoice_uuid, invoice_hash, issuer_cr, recipient_cr, financed_amount_minor, transaction_id,
              correlation_id
         from core.financed_invoice_registry where transaction_id = (select id from core.transaction where transaction_ref = $1)`,
      [ref],
    );
    expect(again?.constraint).toBe('financed_invoice_unique');
    // A facility's limit below what it carries: refused at commit (0031).
    expect((await refused('update core.facility set limit_minor = 0 where id = $1::uuid', [facility]))?.code).toMatch(
      /^(23001|23514)$/,
    );
    // A facility approval decided by its own proposer: refused by the table.
    const self = await refused(
      `update core.facility_approval set state = 'APPROVED', decided_by = proposed_by, decided_at = now()
        where id = (select approval_id from core.facility where id = $1::uuid)`,
      [facility],
    );
    expect(self).toBeDefined();

    // Booked, collected and settled: the utilisation goes back to the facility.
    advance(1);
    expectOk(await bookExecutedSale(T, ref, MAKER));
    advance(54 * 86_400);
    expectOk(await presentDueInstalments(T, ref, MAKER));
    advance(1);
    expectOk(
      await recordCollectionResult(
        T,
        ref,
        {
          idempotencyKey: `wasl:${ref}:collect:I1`,
          status: 'PAID',
          reference: 'SADAD-W5A',
          receivedOn: '2026-12-11',
          source: 'FIXTURE',
        },
        'sadad',
      ),
    );
    expect(await utilised(facility)).toBe(before - BigInt(cost));
  });

  it('the portal’s identity assertions are accepted once per tenant, by tenant code (SR-007)', async () => {
    const guard = assertionReplayGuard();
    const use = { tenantId: T, assertionId: `demo-approve-guard-${RUN}`, authenticatedAtEpochSeconds: 1_792_314_000n };
    expect(await guard.consume(use)).toBe('FRESH');
    expect(await guard.consume(use)).toBe('REPLAYED');
    // Another tenant's use of the same assertion id is its own.
    expect(await guard.consume({ ...use, tenantId: 'fintech-b' })).toBe('FRESH');
  });

  it('another tenant sees neither the obligation nor its schedule', async () => {
    const v = await accepted();
    advance(1);
    expectOk(await bookExecutedSale(T, v.transactionRef, MAKER));
    const other = await tenantUuidByCode(pool, 'fintech-b');
    const seen = await inTenant(pool, other, async (db) => {
      const o = await db.query<{ n: string }>(
        `select count(*)::text n from core.obligation o join core.transaction t on t.id = o.transaction_id
          where t.transaction_ref = $1`,
        [v.transactionRef],
      );
      const i = await db.query<{ n: string }>(
        `select count(*)::text n from core.instalment i join core.obligation o on o.id = i.obligation_id
           join core.transaction t on t.id = o.transaction_id where t.transaction_ref = $1`,
        [v.transactionRef],
      );
      return { obligations: o.rows[0]?.n, instalments: i.rows[0]?.n };
    });
    expect(seen).toEqual({ obligations: '0', instalments: '0' });
  });
});
