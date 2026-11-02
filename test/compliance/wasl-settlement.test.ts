/**
 * Wasl W4a — the money around a Murabaha transaction. Each case attempts
 * something settlement must refuse, and passes only when it is refused:
 *
 *   - a result for a payment or bill that was never instructed;
 *   - the same result twice (recorded once), or a result out of order;
 *   - paying the seller again while the first payment stands;
 *   - presenting an instalment before its lead window, or twice while the
 *     first presentation stands;
 *   - receiving more than is owed;
 *   - a returned payment silently reopening a settled obligation.
 *
 * And the path: the purchase instructs the seller's payment, at the cost, to
 * the anchor's account, in the same step; the hub's results are recorded; a
 * rejected payment is instructed again under a new key. Once booked, the
 * instalment is presented to SADAD within its lead window; a receipt reduces
 * what is owed, a return takes it off again and frees the instalment to be
 * presented anew, and full payment settles the transaction — its total never
 * moving.
 *
 * The book is in memory (bank-a); time is the host-clock stand-in, moved with
 * fake timers.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import { signWebhook } from '../../adapters/kernel/webhook-signature.ts';
import { POST as collectionResults } from '../../apps/ops/src/app/api/wasl/v1/webhooks/collection-results/[tenant]/route.ts';
import { POST as paymentResults } from '../../apps/ops/src/app/api/wasl/v1/webhooks/payment-results/[tenant]/route.ts';
import { serveFromEnvironmentMap } from '../support/credentials.ts';

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
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';
import { bookExecutedSale } from '../../services/origination/src/wasl/booking.ts';
import {
  obligationPosition,
  paySellerAgain,
  presentDueInstalments,
  presentations,
  recordCollectionResult,
  recordSellerPaymentResult,
  sellerPayments,
} from '../../services/origination/src/wasl/settlement.ts';
import { acceptSaleOffer } from '../../services/origination/src/wasl/steps.ts';

const TEST_INVOICES = '9e400000-0000-4000-8000-';
vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e400000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const HUB = 'payments-hub';
const DAY = 86_400;

const reason = (r: { ok: boolean; error?: { control: string; reason: string } }) =>
  r.ok ? 'done' : `${r.error?.control} ${r.error?.reason}`;

let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

beforeEach(async () => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  resetTransactions();
  resetFacilities();
  await approveTestFacilities();
});
afterEach(() => {
  vi.useRealTimers();
});

let serial = 0;
/** A transaction keyed, approved and opened for Rawabi, then purchased. */
async function purchased(): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: `${TEST_INVOICES}${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W4-${String(serial)}`,
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
  return (await getTransaction(T, ref)) as TransactionView;
}

/** The same transaction carried on to its booked obligation. */
async function booked(v: TransactionView): Promise<TransactionView> {
  const ref = v.transactionRef;
  advance(1);
  expectOk(
    await recordOwnershipInvoice(T, ref, MAKER, {
      invoiceUuid: `7b1e0c4a-7777-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-w4-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'ANCHOR_SYSTEM',
      bytes: new TextEncoder().encode(`%PDF-1.7\n% w4 ${ref}\n%%EOF\n`),
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
  return expectOk(await bookExecutedSale(T, ref, MAKER));
}

describe('paying the seller', () => {
  it('the purchase instructs the cost to the anchor’s account, once, in the same step', async () => {
    const v = await purchased();
    const payments = sellerPayments(v);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      idempotencyKey: `wasl:${v.transactionRef}:seller`,
      status: 'INSTRUCTED',
      beneficiaryIban: 'SA0380000000608010167519',
    });
    expect(payments[0]?.amount.minorUnits).toBe(v.transaction.core.pricing.costAmount.minorUnits);
    const purchaseEvent = v.events.find((e) => e.eventType === 'LEG_EXECUTED' && e.toState === 'PURCHASE_EXECUTED');
    expect(purchaseEvent?.detail['outbox']).toEqual([
      expect.objectContaining({ kind: 'PAYMENT_DISBURSE', idempotencyKey: `wasl:${v.transactionRef}:seller` }),
    ]);
  });

  it('records the hub’s results once and in order, and pays again only after a failure, under a new key', async () => {
    const v = await purchased();
    const key = `wasl:${v.transactionRef}:seller`;
    const result = (idempotencyKey: string, status: 'ACCEPTED' | 'SETTLED' | 'REJECTED' | 'RETURNED') =>
      recordSellerPaymentResult(T, v.transactionRef, { idempotencyKey, status, source: 'FIXTURE' }, HUB);
    expect(reason(await result('wasl:nothing:seller', 'SETTLED'))).toBe('OP-DETERMINACY PAYMENT_NOT_FOUND');
    expect(reason(await paySellerAgain(T, v.transactionRef, 'stf-finance-01'))).toBe(
      'OP-DETERMINACY SELLER_PAYMENT_NOT_FAILED',
    );
    expectOk(await result(key, 'ACCEPTED'));
    expect(reason(await result(key, 'ACCEPTED'))).toBe('OP-DETERMINACY RESULT_ALREADY_RECORDED');
    expectOk(await result(key, 'REJECTED'));
    expect(reason(await result(key, 'SETTLED'))).toBe('OP-DETERMINACY RESULT_OUT_OF_ORDER');
    const again = expectOk(await paySellerAgain(T, v.transactionRef, 'stf-finance-01'));
    expect(sellerPayments(again).map((p) => [p.idempotencyKey, p.status])).toEqual([
      [key, 'REJECTED'],
      [`${key}:R1`, 'INSTRUCTED'],
    ]);
    expectOk(await result(`${key}:R1`, 'SETTLED'));
    expect(reason(await paySellerAgain(T, v.transactionRef, 'stf-finance-01'))).toBe(
      'OP-DETERMINACY SELLER_PAYMENT_NOT_FAILED',
    );
  });
});

describe('the signed result webhooks', () => {
  const SECRET = 'test-webhook-secret-for-wasl-results-0123456789';
  let restore = (): void => undefined;
  beforeAll(() => {
    restore = serveFromEnvironmentMap({
      SANAD_CREDENTIAL_PAYMENTS_HUB_SANDBOX_WEBHOOK_SECRET: SECRET,
      SANAD_CREDENTIAL_BILL_COLLECTION_SANDBOX_WEBHOOK_SECRET: SECRET,
    });
  });
  afterAll(() => restore());

  const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));
  const deliver = (
    route: typeof paymentResults,
    body: unknown,
    opts: { readonly secret?: string; readonly signed?: boolean } = {},
  ) => {
    const raw = JSON.stringify(body);
    const header = signWebhook(new TextEncoder().encode(opts.secret ?? SECRET), raw, nowSeconds());
    return route(
      new Request('https://ops.example/api/wasl/v1/webhooks/x/bank-a', {
        method: 'POST',
        body: raw,
        headers: opts.signed === false ? {} : { 'Sanad-Signature': header },
      }),
      { params: Promise.resolve({ tenant: T }) },
    );
  };

  it('records a seller payment result only when signed with the tenant’s secret, and once', async () => {
    const v = await purchased();
    const body = {
      transactionRef: v.transactionRef,
      idempotencyKey: `wasl:${v.transactionRef}:seller`,
      status: 'SETTLED',
    };
    expect((await deliver(paymentResults, body, { signed: false })).status).toBe(401);
    expect(
      (await deliver(paymentResults, body, { secret: 'test-another-institutions-secret-0123456789' })).status,
    ).toBe(401);
    expect(sellerPayments((await getTransaction(T, v.transactionRef)) as TransactionView)[0]?.status).toBe(
      'INSTRUCTED',
    );
    advance(1);
    expect((await deliver(paymentResults, body)).status).toBe(204);
    advance(1);
    // Delivered again (freshly signed): delivered, and nothing new recorded.
    expect((await deliver(paymentResults, body)).status).toBe(204);
    const after = (await getTransaction(T, v.transactionRef)) as TransactionView;
    expect(sellerPayments(after)[0]).toMatchObject({ status: 'SETTLED', source: 'LIVE' });
    expect(after.events.filter((e) => e.eventType === 'SELLER_PAYMENT_RESULT')).toHaveLength(1);
    expect((await deliver(paymentResults, { ...body, transactionRef: 'WT-999999' })).status).toBe(404);
  });

  it('applies a signed SADAD receipt to the obligation', async () => {
    const v = await booked(await purchased());
    advance(54 * DAY);
    expectOk(await presentDueInstalments(T, v.transactionRef, MAKER));
    advance(1);
    const body = {
      transactionRef: v.transactionRef,
      idempotencyKey: `wasl:${v.transactionRef}:collect:I1`,
      status: 'PAID',
      reference: 'SADAD-123',
      receivedOn: '2026-12-11',
    };
    expect((await deliver(collectionResults, body)).status).toBe(204);
    expect((await getTransaction(T, v.transactionRef))?.transaction.state).toBe('SETTLED');
  });
});

describe('collecting from the distributor', () => {
  it('presents within the lead window, applies receipts and returns, and settles when nothing is owed', async () => {
    const v = await booked(await purchased());
    const ref = v.transactionRef;
    const total = v.transaction.core.pricing.salePriceAmount.minorUnits;
    expect(v.transaction.state).toBe('ACTIVE');

    // Sixty days out, nothing is due yet.
    expect(reason(await presentDueInstalments(T, ref, MAKER))).toBe('OP-DETERMINACY NOTHING_TO_COLLECT');
    advance(54 * DAY);
    const presented = expectOk(await presentDueInstalments(T, ref, MAKER));
    const bill = presentations(presented)[0];
    expect(bill).toMatchObject({
      idempotencyKey: `wasl:${ref}:collect:I1`,
      billNumber: `${ref}-I1`,
      sequenceNumber: 1,
    });
    expect(bill?.amount.minorUnits).toBe(total);
    // Presented and standing: not presented twice.
    expect(reason(await presentDueInstalments(T, ref, MAKER))).toBe('OP-DETERMINACY NOTHING_TO_COLLECT');

    const collect = (key: string, status: 'PAID' | 'RETURNED', amount?: bigint) =>
      recordCollectionResult(
        T,
        ref,
        {
          idempotencyKey: key,
          status,
          ...(amount === undefined ? {} : { amountMinorUnits: amount }),
          reference: 'SADAD-DEMO',
          receivedOn: '2026-12-11',
          source: 'FIXTURE',
        },
        'sadad',
      );
    expect(reason(await collect(`wasl:${ref}:collect:I9`, 'PAID'))).toBe('OP-DETERMINACY COLLECTION_NOT_FOUND');
    // More than is owed is refused, not absorbed.
    expect(reason(await collect(`wasl:${ref}:collect:I1`, 'PAID', total + 1n))).toBe('OP-DETERMINACY OVERPAYMENT');

    // Half received, then the payment comes back: the receipt is taken off, the total never moves.
    const half = total / 2n;
    const partly = expectOk(await collect(`wasl:${ref}:collect:I1`, 'PAID', half));
    expect(partly.transaction.state).toBe('ACTIVE');
    expect(obligationPosition(partly, '2026-12-11')?.totalPaid.minorUnits).toBe(half);
    expect(reason(await collect(`wasl:${ref}:collect:I1`, 'PAID', half))).toBe(
      'OP-DETERMINACY RESULT_ALREADY_RECORDED',
    );
    const returned = expectOk(await collect(`wasl:${ref}:collect:I1`, 'RETURNED'));
    expect(obligationPosition(returned, '2026-12-11')?.outstandingTotal.minorUnits).toBe(total);
    expect(returned.transaction.core.pricing.salePriceAmount.minorUnits).toBe(total);

    // Freed to be presented again, under a new key; paid in full, the transaction settles.
    const again = expectOk(await presentDueInstalments(T, ref, MAKER));
    expect(presentations(again).map((p) => p.idempotencyKey)).toEqual([
      `wasl:${ref}:collect:I1`,
      `wasl:${ref}:collect:I1:R1`,
    ]);
    const settled = expectOk(await collect(`wasl:${ref}:collect:I1:R1`, 'PAID'));
    expect(settled.transaction.state).toBe('SETTLED');
    expect(obligationPosition(settled, '2026-12-17')?.outstandingTotal.minorUnits).toBe(0n);
    expect(reason(await presentDueInstalments(T, ref, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');

    // A return after settlement is not applied silently: operations resolves it.
    expect(reason(await collect(`wasl:${ref}:collect:I1:R1`, 'RETURNED'))).toBe(
      'OP-DETERMINACY RETURN_AFTER_SETTLEMENT',
    );
    // A profit amount, never a rate: nothing settlement recorded names one (M-1).
    expect(JSON.stringify(settled.events.map((e) => e.detail))).not.toMatch(/rate|apr|"bp"/i);
  });
});
