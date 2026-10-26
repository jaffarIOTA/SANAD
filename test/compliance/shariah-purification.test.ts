/**
 * Wasl W6b-2 — purification of income from a defective transaction (BR-F06,
 * SH-13). Each case attempts to keep, misstate or misdirect impermissible
 * income, or to close its incident before it is purified, and passes only
 * when the attempt fails:
 *
 *   - an amount above the profit, an assessment where the board rules the
 *     whole profit or none where it rules an assessment, a ruling half-read;
 *   - shares that do not add up to the amount;
 *   - a purification proposed for an incident not remediated as affecting
 *     income, proposed twice, or confirmed by its proposer;
 *   - income raised before it is collected, raised twice, or recorded as
 *     anything but NON_COMPLIANT_INCOME;
 *   - the incident closed before every share is raised;
 *   - a share given to a recipient the board did not approve for
 *     purification, approved by the person who proposed it, or given twice.
 *
 * In memory (bank-a: whole profit, one instalment), under a fixed clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadBoardPositions } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import { checkIncidentAction, incidentFrom } from '@sanad/core/shariah/incidents.ts';
import { purificationAmount, purificationShares } from '@sanad/products/murabaha-scf/ledger/purification.ts';
import { boardPositionsToJson, parseBoardPositions } from '@sanad/products/murabaha-scf/structures/board-positions.ts';

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
import { openTransactionForRequest, resetTransactions } from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import {
  actOnIncident,
  raiseObservation,
  resetShariahIncidents,
} from '../../services/origination/src/shariah/incidents.ts';
import { getTransaction } from '../../services/origination/src/wasl/book.ts';
import { bookExecutedSale } from '../../services/origination/src/wasl/booking.ts';
import { recordBillResult } from '../../services/origination/src/wasl/collection-results.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import {
  approvePurificationDisbursement,
  decidePurification,
  declinePurificationDisbursement,
  proposePurification,
  proposePurificationDisbursement,
  purifications,
  raisePurificationsDue,
} from '../../services/origination/src/wasl/purification.ts';
import { presentDueInstalments } from '../../services/origination/src/wasl/settlement.ts';
import { acceptSaleOffer } from '../../services/origination/src/wasl/steps.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e6c0000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const FINANCE = 'stf-finance-01';
const R1 = 'stf-shariah-01';
const R2 = 'stf-shariah-02';
const HOUR = 3600;
const DAY = 86_400;

let clock = Date.UTC(2026, 9, 26, 6, 0, 0);
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
  resetShariahApprovals();
  resetShariahIncidents();
  await approveTestFacilities();
  await recordTestApprovals();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const reason = (r: Result<unknown>): string => (r.ok ? 'ok' : `${r.error.control} ${r.error.reason}`);

let serial = 0;
/** A Rawabi transaction sold, accepted and booked: ACTIVE, its one instalment not yet paid. */
async function booked(): Promise<string> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: `9e6c0000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W6B2-${String(serial)}`,
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
      invoiceUuid: `7b1e0c4a-6c6c-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-w6b2-${String(serial)}`,
    }),
  );
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'ANCHOR_SYSTEM',
      bytes: new TextEncoder().encode(`%PDF-1.7\n% delivery ${ref}\n%%EOF\n`),
    }),
  );
  advance(1);
  const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
  expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
  advance(1);
  expectOk(await confirmPossession(T, ref, MAKER));
  advance(HOUR + 60);
  expectOk(await offerSale(T, ref, MAKER));
  advance(60);
  expectOk(
    await acceptSaleOffer(T, ref, 'distributor:sig-rawabi-01', {
      assertionId: `demo-approve-w6b2-${String(serial)}`,
      offerHash: 'a'.repeat(64),
      signatoryRef: 'sig-rawabi-01',
    }),
  );
  advance(1);
  expectOk(await bookExecutedSale(T, ref, MAKER));
  return ref;
}

let observed = 0;
/** An incident on the transaction, worked to its remediation; `affected` says whether income was affected. */
async function remediated(ref: string, affected = true): Promise<string> {
  observed += 1;
  const i = expectOk(
    await raiseObservation(T, R1, {
      subjectRef: ref,
      productCode: 'murabaha-scf',
      severity: 'HIGH',
      observation: `The goods were sold before delivery (observation ${String(observed)})`,
    }),
  );
  const si = i?.incidentRef ?? '';
  expectOk(await actOnIncident(T, R1, si, { kind: 'TRIAGE', severity: 'HIGH', owner: R1, note: '' }));
  expectOk(await actOnIncident(T, R1, si, { kind: 'PLAN', plan: 'Purify the profit' }));
  expectOk(
    await actOnIncident(T, R1, si, { kind: 'REMEDIATE', note: 'The sale was void', purificationRequired: affected }),
  );
  return si;
}

/** The instalment collected through SADAD, as the webhook and the paid-bills file record it. */
async function collected(ref: string): Promise<void> {
  advance(54 * DAY);
  expectOk(await presentDueInstalments(T, ref, MAKER));
  advance(1);
  expectOk(
    await recordBillResult(
      T,
      ref,
      {
        idempotencyKey: `wasl:${ref}:collect:I1`,
        status: 'PAID',
        reference: 'SADAD-W6B2',
        receivedOn: '2026-12-20',
        source: 'FIXTURE',
      },
      'sadad',
    ),
  );
}

describe('the amount is the board’s, and adds up', () => {
  const profit = money(1_234_567n);
  const ruling = (method: 'WHOLE_PROFIT' | 'ASSESSED_AMOUNT') => ({
    method,
    computationBasisKey: 'k',
    approvedRecipients: [],
  });

  it('whole profit purifies the profit; an assessment is stated and never above it', () => {
    expect(expectOk(purificationAmount(ruling('WHOLE_PROFIT'), profit)).minorUnits).toBe(1_234_567n);
    expect(reason(purificationAmount(ruling('ASSESSED_AMOUNT'), profit))).toBe(
      'OP-DETERMINACY PURIFICATION_AMOUNT_REQUIRED',
    );
    expect(reason(purificationAmount(ruling('ASSESSED_AMOUNT'), profit, 1_234_568n))).toBe(
      'SH-13 PURIFICATION_ABOVE_PROFIT',
    );
    expect(expectOk(purificationAmount(ruling('ASSESSED_AMOUNT'), profit, 500_000n)).minorUnits).toBe(500_000n);
    expect(reason(purificationAmount(ruling('WHOLE_PROFIT'), money(0n)))).toBe('SH-13 NO_INCOME_TO_PURIFY');
  });

  it('the shares follow each instalment’s part of the price and sum to the amount exactly', () => {
    const instalments = [3_333n, 3_333n, 3_334n, 1n].map((m, i) => ({ sequenceNumber: i + 1, amount: money(m) }));
    for (const amount of [1n, 7n, 999n, 1_001n, 10_001n]) {
      const shares = purificationShares(money(amount), instalments);
      expect([...shares.values()].reduce((s, m) => s + m.minorUnits, 0n)).toBe(amount);
      expect([...shares.values()].every((m) => m.minorUnits >= 0n)).toBe(true);
    }
    const even = purificationShares(
      money(900n),
      [1, 2, 3].map((n) => ({ sequenceNumber: n, amount: money(100n) })),
    );
    expect([...even.values()].map((m) => m.minorUnits)).toEqual([300n, 300n, 300n]);
  });

  it('each board’s ruling is read whole, and survives a revision of its other positions', () => {
    for (const tenant of ['bank-a', 'fintech-b'] as const) {
      const board = expectOk(loadBoardPositions(tenant));
      expect(board.purification?.method).toBe(tenant === 'bank-a' ? 'WHOLE_PROFIT' : 'ASSESSED_AMOUNT');
      expect(expectOk(parseBoardPositions(boardPositionsToJson(board))).purification).toEqual(board.purification);
    }
    const board = boardPositionsToJson(expectOk(loadBoardPositions('bank-a')));
    for (const purification of [
      { method: 'HALF_PROFIT', computationBasisKey: 'k', approvedRecipients: [] },
      { method: 'WHOLE_PROFIT', computationBasisKey: '', approvedRecipients: [] },
      {
        method: 'WHOLE_PROFIT',
        computationBasisKey: 'k',
        approvedRecipients: [{ recipientId: 'x', nameAr: 'x', nameEn: 'x', iban: 'GB00' }],
      },
    ])
      expect(reason(parseBoardPositions({ ...board, purification }))).toBe('OP-DETERMINACY BOARD_PURIFICATION_INVALID');
  });
});

describe('purification follows an incident, by two Shariah reviewers', () => {
  it('only after a remediation that says income was affected; once; never confirmed by its proposer', async () => {
    const ref = await booked();
    const other = await booked();
    const unaffected = await remediated(ref, false);
    expect(reason(await proposePurification(T, ref, R1, { incidentRef: unaffected, note: 'Void sale' }))).toBe(
      'OP-DETERMINACY INCIDENT_NOT_AWAITING_PURIFICATION',
    );
    const si = await remediated(ref);
    expect(reason(await proposePurification(T, other, R1, { incidentRef: si, note: 'Void sale' }))).toBe(
      'OP-DETERMINACY INCIDENT_NOT_FOUND',
    );
    expect(reason(await proposePurification(T, ref, R1, { incidentRef: si, note: '' }))).toBe(
      'OP-DETERMINACY PURIFICATION_REASON_REQUIRED',
    );
    const proposed = expectOk(await proposePurification(T, ref, R1, { incidentRef: si, note: 'Sold before delivery' }));
    const p = purifications(proposed).find((x) => x.incidentRef === si);
    // Bank A's board rules the whole profit: the amount is the transaction's profit, whatever is typed.
    expect(p?.amount.minorUnits).toBe(proposed.transaction.core.pricing.profitAmount.minorUnits);
    expect(reason(await proposePurification(T, ref, R2, { incidentRef: si, note: 'again' }))).toBe(
      'OP-DETERMINACY PURIFICATION_ALREADY_PROPOSED',
    );
    expect(reason(await decidePurification(T, ref, R1, { incidentRef: si, confirm: true, note: '' }))).toBe(
      'OP-DETERMINACY FOUR_EYES_SELF_APPROVAL',
    );
    expect(reason(await decidePurification(T, ref, R2, { incidentRef: si, confirm: false, note: '' }))).toBe(
      'OP-DETERMINACY REJECTION_REASON_REQUIRED',
    );
    expectOk(await decidePurification(T, ref, R2, { incidentRef: si, confirm: false, note: 'Cite the minute' }));
    // Rejected, it is proposed again.
    expectOk(await proposePurification(T, ref, R1, { incidentRef: si, note: 'Sold before delivery; minute 21' }));
  });
});

describe('raised as the profit is collected, and the incident closes only then', () => {
  it('nothing is raised before the instalment is paid; its share is raised once when it is; then the incident closes', async () => {
    const ref = await booked();
    const si = await remediated(ref);
    expectOk(await proposePurification(T, ref, R1, { incidentRef: si, note: 'Sold before delivery' }));
    const confirmed = expectOk(await decidePurification(T, ref, R2, { incidentRef: si, confirm: true, note: '' }));
    const profit = confirmed.transaction.core.pricing.profitAmount.minorUnits;
    const before = purifications(confirmed).find((p) => p.incidentRef === si);
    expect(before?.state).toBe('CONFIRMED');
    expect(before?.shares.map((s) => [s.sequenceNumber, s.amount.minorUnits, s.raised])).toEqual([
      [1, profit, undefined],
    ]);
    // Not collected: not purified, and the incident stays open.
    expect(reason(await actOnIncident(T, R2, si, { kind: 'CLOSE', closureEvidence: 'Minute 21' }))).toBe(
      'SH-13 INCIDENT_PURIFICATION_PENDING',
    );
    expect(expectOk(await raisePurificationsDue(T, ref, R1))).toBe(0);

    await collected(ref);
    const after = await getTransaction(T, ref);
    if (after === undefined) throw new Error('no transaction');
    const share = purifications(after).find((p) => p.incidentRef === si)?.shares[0];
    expect(share?.raised?.sourceRef).toBe(`wasl:${ref}:purify:${si}:I1`);
    const raisedEvent = after.events.find((e) => e.eventType === 'PURIFICATION_RAISED');
    expect((raisedEvent?.detail['charity'] as Record<string, string>)['reason']).toBe('NON_COMPLIANT_INCOME');
    expect((raisedEvent?.detail['charity'] as Record<string, string>)['amountMinor']).toBe(profit.toString());
    // Raised once, however often asked.
    expect(expectOk(await raisePurificationsDue(T, ref, R1))).toBe(0);
    expect(after.events.filter((e) => e.eventType === 'PURIFICATION_RAISED')).toHaveLength(1);

    expect(reason(await actOnIncident(T, R1, si, { kind: 'CLOSE', closureEvidence: 'Minute 21' }))).toBe(
      'OP-DETERMINACY FOUR_EYES_SELF_APPROVAL',
    );
    expect(expectOk(await actOnIncident(T, R2, si, { kind: 'CLOSE', closureEvidence: 'Minute 21' })).status).toBe(
      'CLOSED',
    );
  });

  it('an instalment already paid when the purification is confirmed is raised at confirmation', async () => {
    const ref = await booked();
    const si = await remediated(ref);
    await collected(ref);
    expectOk(await proposePurification(T, ref, R1, { incidentRef: si, note: 'Found after payment' }));
    const confirmed = expectOk(await decidePurification(T, ref, R2, { incidentRef: si, confirm: true, note: '' }));
    expect(purifications(confirmed).find((p) => p.incidentRef === si)?.shares[0]?.raised).toBeDefined();
  });

  it('a product that has registered no purification check never closes an incident that affected its income', () => {
    const incident = incidentFrom(
      {
        incidentId: 'i',
        incidentRef: 'SI-000001',
        subjectRef: 'X-1',
        productCode: 'some-product',
        checkCode: 'MANUAL',
        control: 'SH-18',
        reason: 'REVIEWER_OBSERVATION',
        context: {},
        severity: 'LOW',
        fingerprint: 'f',
        raisedBy: R1,
        raisedAtEpochSeconds: 1n,
      },
      [
        { action: { kind: 'TRIAGE', severity: 'LOW', owner: R1, note: '' }, actor: R1, atEpochSeconds: 2n },
        { action: { kind: 'PLAN', plan: 'p p p' }, actor: R1, atEpochSeconds: 3n },
        { action: { kind: 'REMEDIATE', note: 'r r r', purificationRequired: true }, actor: R1, atEpochSeconds: 4n },
      ],
    );
    const close = { kind: 'CLOSE', closureEvidence: 'DOC-1' } as const;
    expect(reason(checkIncidentAction(incident, close, R2))).toBe('SH-13 INCIDENT_PURIFICATION_PENDING');
    expect(reason(checkIncidentAction(incident, close, R2, true))).toBe('ok');
  });
});

describe('given to a recipient the board approved, by two people, once', () => {
  it('refuses another recipient, the proposer approving, and a second payment', async () => {
    const ref = await booked();
    const si = await remediated(ref);
    expectOk(await proposePurification(T, ref, R1, { incidentRef: si, note: 'Sold before delivery' }));
    expectOk(await decidePurification(T, ref, R2, { incidentRef: si, confirm: true, note: '' }));
    const share = { incidentRef: si, sequenceNumber: 1 };
    expect(reason(await proposePurificationDisbursement(T, ref, FINANCE, { ...share, recipientId: 'chr-a-01' }))).toBe(
      'OP-DETERMINACY PURIFICATION_SHARE_NOT_RAISED',
    );
    await collected(ref);
    // chr-a-02 receives late amounts at Bank A, but the board approved only chr-a-01 for purified income.
    expect(reason(await proposePurificationDisbursement(T, ref, FINANCE, { ...share, recipientId: 'chr-a-02' }))).toBe(
      'SH-13 RECIPIENT_NOT_APPROVED',
    );
    expectOk(await proposePurificationDisbursement(T, ref, FINANCE, { ...share, recipientId: 'chr-a-01' }));
    expect(reason(await approvePurificationDisbursement(T, ref, FINANCE, share))).toBe(
      'OP-DETERMINACY FOUR_EYES_SELF_CONFIRMATION',
    );
    expectOk(await declinePurificationDisbursement(T, ref, CHECKER, share));
    expectOk(await proposePurificationDisbursement(T, ref, FINANCE, { ...share, recipientId: 'chr-a-01' }));
    const paid = expectOk(await approvePurificationDisbursement(T, ref, CHECKER, share));
    const instruction = paid.events.at(-1)?.detail['outbox'] as { kind: string; idempotencyKey: string }[] | undefined;
    expect(instruction?.[0]).toMatchObject({
      kind: 'PAYMENT_DISBURSE',
      idempotencyKey: `wasl:${ref}:purify:${si}:I1:pay`,
    });
    expect(purifications(paid).find((p) => p.incidentRef === si)?.shares[0]?.disbursed?.recipientId).toBe('chr-a-01');
    expect(reason(await approvePurificationDisbursement(T, ref, CHECKER, share))).toBe('SH-13 ALREADY_DISBURSED');
  });
});
