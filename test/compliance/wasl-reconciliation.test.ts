/**
 * Wasl W4b — reconciling collections against SADAD's paid-bills file, and
 * Wasl joining the daily servicing cycle. Each case attempts something
 * reconciliation must never do, and passes only when it does not:
 *
 *   - apply a receipt twice: the file read again, or after the webhook
 *     already delivered it, changes nothing;
 *   - apply by guesswork: an amount that differs, a bill for a transaction
 *     that does not exist, or a bill whose presentation was returned is an
 *     exception for operations — never applied;
 *   - claim another product's bills: they are counted, not touched;
 *   - run without SADAD: outside a permitted demonstration it is unavailable
 *     and nothing is applied.
 *
 * And the path: a bill paid at SADAD that the webhook never reported is
 * applied from the file, through the webhook's own receipt path, and settles
 * the transaction. The daily cycle reads the file first, then services the
 * Wasl transaction beside the business loans.
 *
 * The book is in memory (bank-a); the demonstration SADAD (FIXTURE); time is
 * the host-clock stand-in, moved with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  recordDemonstrationSadadPayment,
  resetDemonstrationSadadPayments,
} from '../../adapters/ksa/demonstration/transport.ts';
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
import { runServicingCycleNow } from '../../apps/ops/src/server/servicing-scheduler.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';
import { bookExecutedSale } from '../../services/origination/src/wasl/booking.ts';
import { reconcilePaidBills, resetReconciliations } from '../../services/origination/src/wasl/reconciliation.ts';
import {
  presentDueInstalments,
  presentations,
  recordCollectionResult,
} from '../../services/origination/src/wasl/settlement.ts';
import { acceptSaleOffer } from '../../services/origination/src/wasl/steps.ts';

const TEST_INVOICES = '9e450000-0000-4000-8000-';
vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e450000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const RECONCILER = 'system:test-reconciler';
const DAY = 86_400;

let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};
const nowSeconds = () => Math.floor(clock / 1000);

beforeEach(async () => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  resetTransactions();
  resetDemonstrationSadadPayments();
  resetReconciliations();
  resetFacilities();
  await approveTestFacilities();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

let serial = 0;
/** A Rawabi transaction carried to its booked obligation, its single instalment presented to SADAD. */
async function presented(): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: `${TEST_INVOICES}${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W4B-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  expectOk(approveRequest(keyed.requestId, { principalId: 'stf-senior-01', tenantId: T }));
  const ref = expectOk(await openTransactionForRequest(T, keyed.requestId, 'stf-senior-01')).transactionRef;
  for (const s of [validateAndReserve, executeWaad, executePurchase]) {
    advance(1);
    expectOk(await s(T, ref, MAKER));
  }
  advance(1);
  expectOk(
    await recordOwnershipInvoice(T, ref, MAKER, {
      invoiceUuid: `7b1e0c4a-4545-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-w4b-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'ANCHOR_SYSTEM',
      bytes: new TextEncoder().encode(`%PDF-1.7\n% w4b ${ref}\n%%EOF\n`),
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
  expectOk(await acceptSaleOffer(T, ref, 'distributor:sig-rawabi-01'));
  advance(1);
  expectOk(await bookExecutedSale(T, ref, MAKER));
  advance(54 * DAY);
  return expectOk(await presentDueInstalments(T, ref, MAKER));
}

/** SADAD's decimal for an amount in minor units. */
const decimal = (minor: bigint) => `${String(minor / 100n)}.${String(minor % 100n).padStart(2, '0')}`;

/** The distributor pays the bill at SADAD; only the end-of-day file says so. */
function paidAtSadad(billNumber: string, minor: bigint): void {
  recordDemonstrationSadadPayment({
    billNumber,
    amount: decimal(minor),
    currency: 'SAR',
    paidAtEpochSeconds: nowSeconds(),
  });
}

describe('reading the paid-bills file', () => {
  it('applies a payment the webhook never reported, through the same receipt path, and settles', async () => {
    const v = await presented();
    const bill = presentations(v)[0];
    expect(bill?.result).toBeUndefined();
    advance(DAY);
    paidAtSadad(bill?.billNumber ?? '', bill?.amount.minorUnits ?? 0n);
    advance(60);

    const report = expectOk(await reconcilePaidBills(T, RECONCILER));
    expect(report).toMatchObject({
      source: 'FIXTURE',
      applied: [{ transactionRef: v.transactionRef, billNumber: bill?.billNumber }],
      alreadyRecorded: 0,
      exceptions: [],
    });
    // The demonstration file also carries other products' bills: counted, never touched.
    expect(report.otherBills).toBeGreaterThan(0);

    const after = await getTransaction(T, v.transactionRef);
    expect(after?.transaction.state).toBe('SETTLED');
    expect(presentations(after as TransactionView)[0]).toMatchObject({ result: 'PAID' });
    expect(after?.events.find((e) => e.eventType === 'PAYMENT_RECEIVED')?.detail).toMatchObject({
      idempotencyKey: bill?.idempotencyKey,
      source: 'FIXTURE',
      reference: expect.stringMatching(/^SADAD-DEMO-/),
    });
  });

  it('reading the file again changes nothing', async () => {
    const v = await presented();
    const bill = presentations(v)[0];
    paidAtSadad(bill?.billNumber ?? '', bill?.amount.minorUnits ?? 0n);
    advance(60);
    expectOk(await reconcilePaidBills(T, RECONCILER));
    const events = (await getTransaction(T, v.transactionRef))?.events.length;
    advance(60);
    const again = expectOk(await reconcilePaidBills(T, RECONCILER));
    expect(again).toMatchObject({ applied: [], alreadyRecorded: 1, exceptions: [] });
    expect((await getTransaction(T, v.transactionRef))?.events.length).toBe(events);
  });

  it('a payment the webhook already delivered is recorded once', async () => {
    const v = await presented();
    const bill = presentations(v)[0];
    advance(60);
    expectOk(
      await recordCollectionResult(
        T,
        v.transactionRef,
        {
          idempotencyKey: bill?.idempotencyKey ?? '',
          status: 'PAID',
          reference: 'WEBHOOK-1',
          receivedOn: '2026-12-11',
          source: 'LIVE',
        },
        'sadad',
      ),
    );
    paidAtSadad(bill?.billNumber ?? '', bill?.amount.minorUnits ?? 0n);
    advance(60);
    expect(expectOk(await reconcilePaidBills(T, RECONCILER))).toMatchObject({ applied: [], alreadyRecorded: 1 });
    const receipts = (await getTransaction(T, v.transactionRef))?.events.filter(
      (e) => e.eventType === 'PAYMENT_RECEIVED',
    );
    expect(receipts).toHaveLength(1);
  });
});

describe('what is never applied by guesswork', () => {
  it('an amount that differs is an exception, and the instalment stays unpaid', async () => {
    const v = await presented();
    const bill = presentations(v)[0];
    paidAtSadad(bill?.billNumber ?? '', (bill?.amount.minorUnits ?? 0n) - 100n);
    advance(60);
    const report = expectOk(await reconcilePaidBills(T, RECONCILER));
    expect(report.applied).toEqual([]);
    expect(report.exceptions).toEqual([
      expect.objectContaining({
        code: 'AMOUNT_DIFFERS',
        transactionRef: v.transactionRef,
        presented: bill?.amount,
        paid: expect.objectContaining({ minorUnits: (bill?.amount.minorUnits ?? 0n) - 100n }),
      }),
    ]);
    expect(presentations((await getTransaction(T, v.transactionRef)) as TransactionView)[0]?.result).toBeUndefined();
  });

  it('a bill for no such transaction, or for a presentation that was returned, is an exception', async () => {
    const v = await presented();
    const bill = presentations(v)[0];
    advance(60);
    expectOk(
      await recordCollectionResult(
        T,
        v.transactionRef,
        {
          idempotencyKey: bill?.idempotencyKey ?? '',
          status: 'RETURNED',
          reference: 'RETURN-1',
          receivedOn: '2026-12-11',
          source: 'FIXTURE',
        },
        'sadad',
      ),
    );
    paidAtSadad(bill?.billNumber ?? '', bill?.amount.minorUnits ?? 0n);
    paidAtSadad('WT-999999-I1', 100_00n);
    advance(60);
    const report = expectOk(await reconcilePaidBills(T, RECONCILER));
    expect(report.applied).toEqual([]);
    expect(report.exceptions.map((x) => [x.code, x.transactionRef])).toEqual(
      expect.arrayContaining([
        ['NOT_PRESENTED', v.transactionRef],
        ['TRANSACTION_NOT_FOUND', 'WT-999999'],
      ]),
    );
  });

  it('without SADAD — outside a permitted demonstration — nothing is reconciled', async () => {
    const v = await presented();
    const bill = presentations(v)[0];
    paidAtSadad(bill?.billNumber ?? '', bill?.amount.minorUnits ?? 0n);
    vi.stubEnv('NODE_ENV', 'production');
    const r = await reconcilePaidBills(T, RECONCILER);
    expect(r.ok ? 'reconciled' : r.error.reason).toBe('RAIL_UNAVAILABLE');
    vi.stubEnv('NODE_ENV', 'test');
    expect(presentations((await getTransaction(T, v.transactionRef)) as TransactionView)[0]?.result).toBeUndefined();
  });
});

describe('the daily servicing cycle', () => {
  it('reads the paid-bills file first, then services the Wasl transaction beside the business loans', async () => {
    const v = await presented();
    const bill = presentations(v)[0];
    paidAtSadad(bill?.billNumber ?? '', bill?.amount.minorUnits ?? 0n);
    advance(60);
    const report = expectOk(await runServicingCycleNow(T));
    // The tenant's reading ran and applied the receipt; nothing about it failed.
    expect(report.failed.filter((f) => f.applicationId === 'TENANT')).toEqual([]);
    expect((await getTransaction(T, v.transactionRef))?.transaction.state).toBe('SETTLED');
    // Settled, it is no longer serviced; nothing about Wasl failed.
    expect(report.failed.filter((f) => f.applicationId.startsWith('WT-'))).toEqual([]);
  });

  it('presents a Wasl instalment as it falls due, and reports the tasks Wasl does not have as nothing due', async () => {
    const v = await presented();
    const ref = v.transactionRef;
    advance(60);
    const report = expectOk(await runServicingCycleNow(T));
    expect(report.failed.filter((f) => f.applicationId === ref)).toEqual([]);
    // Already presented and standing: the cycle does not present it twice.
    expect(presentations((await getTransaction(T, ref)) as TransactionView)).toHaveLength(1);
  });
});
