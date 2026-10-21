/**
 * Wasl W4b-2 — late amounts and the charity they are held for. Each case
 * attempts something that must never happen, and passes only when it does not:
 *
 *   - a late amount billed on one person's word: the officer who assessed it
 *     cannot confirm it, nor a proposer approve their own disbursement;
 *   - a late amount billed to a distributor assessed unable to pay (SH-14);
 *   - a late amount touching the sale price: proposing, billing and collecting
 *     it never moves the obligation's total or what is paid on it (M-2);
 *   - a late amount recognised before it is collected, or twice, or for an
 *     amount other than the one billed (SH-13);
 *   - a charity entry taken back silently by a return;
 *   - a disbursement to anyone not on the board's register, or twice;
 *   - a late bill read as an instalment, or a charity payment as the seller's.
 *
 * And the path: the cycle proposes, two people confirm, SADAD bills it on its
 * own bill, a payment (by webhook or the paid-bills file) raises the charity
 * liability, and two people send it to a board-approved recipient.
 *
 * The book is in memory (bank-a); the demonstration SADAD and core (FIXTURE);
 * time is the host-clock stand-in, moved with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { postLateAmount } from '@sanad/products/murabaha-scf/ledger/charity.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';

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
import { bookExecutedSale } from '../../services/origination/src/wasl/booking.ts';
import { recordBillResult } from '../../services/origination/src/wasl/collection-results.ts';
import {
  approveDisbursement,
  assessLateAmount,
  charityHoldings,
  confirmLateAmount,
  declineDisbursement,
  lateAmounts,
  presentLateBillAgain,
  proposeDisbursement,
  proposeLateAmounts,
  sendBackLateAmount,
} from '../../services/origination/src/wasl/late-amounts.ts';
import { reconcilePaidBills, resetReconciliations } from '../../services/origination/src/wasl/reconciliation.ts';
import {
  obligationPosition,
  presentDueInstalments,
  presentations,
  sellerPayments,
} from '../../services/origination/src/wasl/settlement.ts';
import { acceptSaleOffer } from '../../services/origination/src/wasl/steps.ts';

const TEST_INVOICES = '9e460000-0000-4000-8000-';
vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e460000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const OFFICER = 'stf-maker-02';
const CHECKER = 'stf-checker-01';
const FINANCE = 'stf-finance-01';
const CYCLE = 'system:test-cycle';
const DAY = 86_400;
/** bank-a's board-positions.json (ILLUSTRATIVE): SAR 500 per instalment, five days' grace. */
const LATE_MINOR = 50_000n;

let clock = Date.UTC(2026, 9, 18, 9, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};
const nowSeconds = () => Math.floor(clock / 1000);

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  resetTransactions();
  resetDemonstrationSadadPayments();
  resetReconciliations();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

let serial = 0;
/** A Rawabi transaction booked and its single instalment presented, then left unpaid `daysLate` days past due. */
async function overdue(daysLate: number): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: `${TEST_INVOICES}${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W4B2-${String(serial)}`,
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
      invoiceUuid: `7b1e0c4a-4646-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-w4b2-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'ANCHOR_SYSTEM',
      bytes: new TextEncoder().encode(`%PDF-1.7\n% w4b2 ${ref}\n%%EOF\n`),
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
  const booked = expectOk(await bookExecutedSale(T, ref, MAKER));
  advance(54 * DAY);
  expectOk(await presentDueInstalments(T, ref, MAKER));
  // To the due date (the single instalment falls due at maturity), then `daysLate` days past it.
  const due = booked.transaction.core.maturityDateGregorian;
  const dueAt = Date.parse(`${due}T09:00:00Z`);
  clock = dueAt + daysLate * DAY * 1000;
  vi.setSystemTime(clock);
  return (await getTransaction(T, ref)) as TransactionView;
}

/** Overdue beyond the grace, proposed, assessed by the officer and confirmed by the checker. */
async function billed(): Promise<TransactionView> {
  const v = await overdue(8);
  const ref = v.transactionRef;
  expectOk(await proposeLateAmounts(T, ref, CYCLE));
  advance(60);
  expectOk(
    await assessLateAmount(T, ref, OFFICER, {
      sequenceNumber: 1,
      assessment: 'ABLE_BUT_UNWILLING',
      note: 'Trading normally; two reminders unanswered.',
    }),
  );
  advance(60);
  return expectOk(await confirmLateAmount(T, ref, CHECKER, 1));
}

const lateBillOf = (v: TransactionView) => lateAmounts(v)[0]?.bills.at(-1);

/** The late bill reported paid, as the webhook would. */
async function collected(): Promise<TransactionView> {
  const v = await billed();
  advance(60);
  return expectOk(
    await recordBillResult(
      T,
      v.transactionRef,
      {
        idempotencyKey: lateBillOf(v)?.idempotencyKey ?? '',
        status: 'PAID',
        reference: 'SADAD-LATE-1',
        receivedOn: '2026-12-30',
        source: 'FIXTURE',
      },
      'sadad',
    ),
  );
}

const paidOn = (v: TransactionView) => obligationPosition(v, '2027-01-31')?.totalPaid.minorUnits;

describe('proposing', () => {
  it('nothing is proposed within the grace days', async () => {
    const v = await overdue(5);
    const r = await proposeLateAmounts(T, v.transactionRef, CYCLE);
    expect(r.ok ? 'proposed' : r.error.reason).toBe('NO_LATE_CHARGE_DUE');
  });

  it('beyond the grace, one late amount at the board’s amount, once — and a proposal moves nothing', async () => {
    const v = await overdue(8);
    const before = paidOn(v);
    const proposed = expectOk(await proposeLateAmounts(T, v.transactionRef, CYCLE));
    expect(lateAmounts(proposed)).toEqual([
      expect.objectContaining({
        sequenceNumber: 1,
        status: 'PROPOSED',
        amount: money(LATE_MINOR, 'SAR'),
        computationBasisKey: 'SSB-A-2026-014/late-amount/fixed-per-instalment',
        graceDays: 5,
        bills: [],
      }),
    ]);
    // No bill, no charity entry, no change to the obligation or the state.
    const last = proposed.events.at(-1);
    expect(last?.detail['outbox']).toBeUndefined();
    expect(last?.detail['charity']).toBeUndefined();
    expect(paidOn(proposed)).toBe(before);
    expect(proposed.transaction.state).toBe('ACTIVE');
    // Once per instalment, however often the cycle runs.
    advance(DAY);
    const again = await proposeLateAmounts(T, v.transactionRef, CYCLE);
    expect(again.ok ? 'proposed twice' : again.error.reason).toBe('NO_LATE_CHARGE_DUE');
  });
});

describe('two people before anything is billed', () => {
  it('the officer who assessed cannot confirm, nor send back, their own assessment', async () => {
    const v = await overdue(8);
    const ref = v.transactionRef;
    expectOk(await proposeLateAmounts(T, ref, CYCLE));
    expectOk(
      await assessLateAmount(T, ref, OFFICER, { sequenceNumber: 1, assessment: 'ABLE_BUT_UNWILLING', note: 'n' }),
    );
    for (const r of [
      await confirmLateAmount(T, ref, OFFICER, 1),
      await sendBackLateAmount(T, ref, OFFICER, { sequenceNumber: 1, note: 'mine' }),
    ])
      expect(r.ok ? 'self-confirmed' : r.error.reason).toBe('FOUR_EYES_SELF_CONFIRMATION');
    expect(lateAmounts((await getTransaction(T, ref)) as TransactionView)[0]?.status).toBe('ASSESSED');
  });

  it('an assessment needs a reason, and one sent back is assessed afresh', async () => {
    const v = await overdue(8);
    const ref = v.transactionRef;
    expectOk(await proposeLateAmounts(T, ref, CYCLE));
    const bare = await assessLateAmount(T, ref, OFFICER, { sequenceNumber: 1, assessment: 'UNABLE', note: '  ' });
    expect(bare.ok ? 'assessed' : bare.error.reason).toBe('ASSESSMENT_NOTE_REQUIRED');
    expectOk(await assessLateAmount(T, ref, OFFICER, { sequenceNumber: 1, assessment: 'UNABLE', note: 'n' }));
    const back = expectOk(await sendBackLateAmount(T, ref, CHECKER, { sequenceNumber: 1, note: 'Evidence?' }));
    expect(lateAmounts(back)[0]).toMatchObject({ status: 'PROPOSED', sentBack: { by: CHECKER, note: 'Evidence?' } });
    expect(lateAmounts(back)[0]?.assessment).toBeUndefined();
    expect(back.events.at(-1)?.detail['outbox']).toBeUndefined();
  });

  it('unable to pay, confirmed: hardship — never billed, and the domain refuses to post it', async () => {
    const v = await overdue(8);
    const ref = v.transactionRef;
    expectOk(await proposeLateAmounts(T, ref, CYCLE));
    expectOk(
      await assessLateAmount(T, ref, OFFICER, { sequenceNumber: 1, assessment: 'UNABLE', note: 'Anchor default' }),
    );
    const confirmed = expectOk(await confirmLateAmount(T, ref, CHECKER, 1));
    expect(lateAmounts(confirmed)[0]).toMatchObject({ status: 'HARDSHIP', bills: [] });
    expect(confirmed.events.at(-1)?.detail['outbox']).toBeUndefined();
    const again = await presentLateBillAgain(T, ref, OFFICER, 1);
    expect(again.ok ? 'billed' : again.error.reason).toBe('LATE_AMOUNT_NOT_IN_STATE');
    // The product module's own gate (SH-14).
    const posted = postLateAmount({
      entryId: 'e',
      tenantId: T,
      transactionId: 't',
      amount: money(LATE_MINOR, 'SAR'),
      assessment: 'UNABLE',
      computationBasisConfigKey: 'k',
      shariahApprovalId: 'a',
      recordedAt: tsaInstant({ verified: true, genTimeEpochSeconds: 1n, tokenDigest: 'd', authorityId: 'x' }),
    });
    expect(posted.ok ? 'posted' : posted.error.reason).toBe('HARDSHIP_SUSPENDS_LATE_AMOUNTS');
  });
});

describe('billing and collecting', () => {
  it('able but unwilling, confirmed: its own SADAD bill, never an instalment’s, never on the obligation', async () => {
    const v = await billed();
    const bill = lateBillOf(v);
    expect(bill).toMatchObject({
      idempotencyKey: `wasl:${v.transactionRef}:late:I1`,
      billNumber: `${v.transactionRef}-L1`,
      amount: money(LATE_MINOR, 'SAR'),
    });
    // The instalment's presentations are unchanged: one bill, the instalment's.
    expect(presentations(v).map((p) => p.idempotencyKey)).toEqual([`wasl:${v.transactionRef}:collect:I1`]);
    // The instalment's outstanding amount is what it was: the late amount is not added to it.
    const instalment = obligationPosition(v, '2027-01-31')?.instalments[0];
    expect(instalment?.outstanding.minorUnits).toBe(instalment?.amount.minorUnits);
  });

  it('collected: the charity liability is raised — and the obligation, its total and its state do not move', async () => {
    const v = await billed();
    const before = paidOn(v);
    const c = await collected();
    const late = lateAmounts(c)[0];
    expect(late?.status).toBe('COLLECTED');
    expect(late?.charity).toMatchObject({ source: 'FIXTURE', corePostingRef: expect.stringMatching(/^TRX-DEMO-/) });
    const raised = c.events.at(-1);
    expect(raised?.eventType).toBe('LATE_AMOUNT_COLLECTED');
    expect(raised?.detail['charity']).toMatchObject({
      kind: 'RAISE',
      amountMinor: LATE_MINOR.toString(),
      sourceRef: `wasl:${c.transactionRef}:late:I1`,
      computationBasisKey: 'SSB-A-2026-014/late-amount/fixed-per-instalment',
    });
    expect(raised?.detail['paidDeltaMinor']).toBeUndefined();
    expect(paidOn(c)).toBe(before);
    expect(c.transaction.state).toBe('ACTIVE');
    expect(charityHoldings([c])).toHaveLength(1);
  });

  it('reported twice — by webhook and then in the paid-bills file — it is raised once', async () => {
    const c = await collected();
    const bill = lateBillOf(c);
    const again = await recordBillResult(
      T,
      c.transactionRef,
      {
        idempotencyKey: bill?.idempotencyKey ?? '',
        status: 'PAID',
        reference: 'SADAD-LATE-2',
        receivedOn: '2026-12-30',
        source: 'LIVE',
      },
      'sadad',
    );
    expect(again.ok ? 'raised twice' : again.error.reason).toBe('RESULT_ALREADY_RECORDED');
    recordDemonstrationSadadPayment({
      billNumber: bill?.billNumber ?? '',
      amount: '500.00',
      currency: 'SAR',
      paidAtEpochSeconds: nowSeconds(),
    });
    advance(60);
    expect(expectOk(await reconcilePaidBills(T, CYCLE))).toMatchObject({ applied: [], exceptions: [] });
    const after = (await getTransaction(T, c.transactionRef)) as TransactionView;
    expect(after.events.filter((e) => e.eventType === 'LATE_AMOUNT_COLLECTED')).toHaveLength(1);
  });

  it('a late bill paid only in SADAD’s file is raised from the file', async () => {
    const v = await billed();
    const bill = lateBillOf(v);
    recordDemonstrationSadadPayment({
      billNumber: bill?.billNumber ?? '',
      amount: '500.00',
      currency: 'SAR',
      paidAtEpochSeconds: nowSeconds(),
    });
    advance(60);
    const report = expectOk(await reconcilePaidBills(T, CYCLE));
    expect(report.applied).toEqual([{ transactionRef: v.transactionRef, billNumber: bill?.billNumber }]);
    expect(lateAmounts((await getTransaction(T, v.transactionRef)) as TransactionView)[0]?.status).toBe('COLLECTED');
  });

  it('an amount other than the one billed is refused, and nothing is raised', async () => {
    const v = await billed();
    const r = await recordBillResult(
      T,
      v.transactionRef,
      {
        idempotencyKey: lateBillOf(v)?.idempotencyKey ?? '',
        status: 'PAID',
        amountMinorUnits: LATE_MINOR - 1n,
        reference: 'SADAD-SHORT',
        receivedOn: '2026-12-30',
        source: 'LIVE',
      },
      'sadad',
    );
    expect(r.ok ? 'raised' : r.error.reason).toBe('LATE_AMOUNT_DIFFERS');
    expect(lateAmounts((await getTransaction(T, v.transactionRef)) as TransactionView)[0]?.status).toBe('BILLED');
  });

  it('a return after the charity is raised is refused, not taken back silently; before it, the bill can go again', async () => {
    const c = await collected();
    const r = await recordBillResult(
      T,
      c.transactionRef,
      {
        idempotencyKey: lateBillOf(c)?.idempotencyKey ?? '',
        status: 'RETURNED',
        reference: 'SADAD-RETURN',
        receivedOn: '2026-12-31',
        source: 'LIVE',
      },
      'sadad',
    );
    expect(r.ok ? 'taken back' : r.error.reason).toBe('RETURN_AFTER_CHARITY_RAISED');

    const v = await billed();
    expectOk(
      await recordBillResult(
        T,
        v.transactionRef,
        {
          idempotencyKey: lateBillOf(v)?.idempotencyKey ?? '',
          status: 'RETURNED',
          reference: 'SADAD-RETURN',
          receivedOn: '2026-12-31',
          source: 'LIVE',
        },
        'sadad',
      ),
    );
    const again = expectOk(await presentLateBillAgain(T, v.transactionRef, OFFICER, 1));
    expect(lateBillOf(again)?.idempotencyKey).toBe(`wasl:${v.transactionRef}:late:I1:R1`);
  });
});

describe('disbursing to a board-approved recipient', () => {
  it('only to a recipient on the register', async () => {
    const c = await collected();
    const r = await proposeDisbursement(T, c.transactionRef, FINANCE, { sequenceNumber: 1, recipientId: 'anyone' });
    expect(r.ok ? 'proposed' : r.error.reason).toBe('RECIPIENT_NOT_APPROVED');
  });

  it('the proposer cannot approve; a second person can, once, and the payment goes to the recipient', async () => {
    const c = await collected();
    const ref = c.transactionRef;
    expectOk(await proposeDisbursement(T, ref, FINANCE, { sequenceNumber: 1, recipientId: 'chr-a-01' }));
    const self = await approveDisbursement(T, ref, FINANCE, 1);
    expect(self.ok ? 'self-approved' : self.error.reason).toBe('FOUR_EYES_SELF_CONFIRMATION');
    advance(60);
    const paid = expectOk(await approveDisbursement(T, ref, CHECKER, 1));
    expect(lateAmounts(paid)[0]).toMatchObject({
      status: 'DISBURSED',
      disbursement: { recipientId: 'chr-a-01', proposedBy: FINANCE, approvedBy: CHECKER },
    });
    expect(paid.events.at(-1)?.detail['outbox']).toEqual([
      expect.objectContaining({
        kind: 'PAYMENT_DISBURSE',
        idempotencyKey: `wasl:${ref}:charity:I1:pay`,
        payload: expect.objectContaining({
          beneficiaryRef: 'charity:chr-a-01',
          beneficiaryIban: 'SA1380000000000000000101',
          minorUnits: LATE_MINOR.toString(),
          reason: 'CHARITY_DISBURSEMENT',
        }),
      }),
    ]);
    // Not the seller's payment.
    expect(sellerPayments(paid).map((p) => p.idempotencyKey)).toEqual([`wasl:${ref}:seller`]);
    const twice = await approveDisbursement(T, ref, CHECKER, 1);
    expect(twice.ok ? 'disbursed twice' : twice.error.reason).toBe('LATE_AMOUNT_NOT_IN_STATE');
  });

  it('declined, it stays held for charity', async () => {
    const c = await collected();
    const ref = c.transactionRef;
    expectOk(await proposeDisbursement(T, ref, FINANCE, { sequenceNumber: 1, recipientId: 'chr-a-02' }));
    const declined = expectOk(await declineDisbursement(T, ref, CHECKER, 1));
    expect(lateAmounts(declined)[0]?.status).toBe('COLLECTED');
    expect(lateAmounts(declined)[0]?.disbursement).toBeUndefined();
  });
});

describe('the daily servicing cycle', () => {
  it('proposes the late amount, and nothing about it fails', async () => {
    const v = await overdue(8);
    const report = expectOk(await runServicingCycleNow(T));
    expect(report.failed.filter((f) => f.applicationId === v.transactionRef)).toEqual([]);
    const after = (await getTransaction(T, v.transactionRef)) as TransactionView;
    expect(lateAmounts(after)).toEqual([
      expect.objectContaining({ status: 'PROPOSED', proposedBy: expect.any(String) }),
    ]);
    // Run again: nothing more is proposed.
    advance(DAY);
    expectOk(await runServicingCycleNow(T));
    expect(lateAmounts((await getTransaction(T, v.transactionRef)) as TransactionView)).toHaveLength(1);
  });
});
