/**
 * Wasl W2 — the Murabaha sequence in the workbench. Each case attempts
 * something the sequence must refuse, and passes only when it is refused:
 * skipping a step, passing a gate without evidence, evidencing ownership with
 * the financed invoice or one the authority did not clear, validating one's
 * own possession evidence, offering the sale inside the risk-holding
 * interval, holding more than the programme allows, selling the goods back to
 * the party they were bought from, accepting a lapsed offer, unwinding
 * without saying what happens to the goods. The happy path runs the whole
 * way, and the event log rebuilds exactly what the steps produced.
 *
 * The book is the workbench's in-memory development book (bank-a); time is
 * the host-clock stand-in, moved with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  acceptSaleOffer,
  acquireOwnership,
  confirmPossession,
  decidePossessionEvidence,
  executePurchase,
  executeWaad,
  lapseSaleOffer,
  offerSale,
  recordOwnershipInvoice,
  recordPossessionEvidence,
  unwindTransaction,
  validateAndReserve,
} from '../../apps/ops/src/server/murabaha-sequencing.ts';
import {
  type TransactionView,
  openTransactionForRequest,
  replay,
  resetTransactions,
} from '../../apps/ops/src/server/murabaha-transactions.ts';
import {
  applyServicingOutcome,
  approveRequest,
  developmentAttestation,
  keyRequest,
  submit,
} from '../../apps/ops/src/server/store.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

// This file's invoices: structural steel (HS 7216), which the board's register permits.
const TEST_INVOICES = '9e000000-0000-4000-8000-';
vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e000000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

// A programme limit the test can lower, to attempt an over-commitment.
const limit = vi.hoisted(() => ({ override: undefined as bigint | undefined }));
vi.mock('@sanad/config/loader.ts', async (original) => {
  const actual = await original<typeof import('@sanad/config/loader.ts')>();
  return {
    ...actual,
    loadWaslParties: (tenant: Parameters<typeof actual.loadWaslParties>[0]) => {
      const r = actual.loadWaslParties(tenant);
      if (!r.ok || limit.override === undefined) return r;
      const programmeLimitMinorUnits = limit.override;
      return {
        ...r,
        value: { ...r.value, programmes: r.value.programmes.map((p) => ({ ...p, programmeLimitMinorUnits })) },
      };
    },
  };
});

const T = 'bank-a';
const SENIOR = { principalId: 'stf-senior-01', tenantId: T };
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const HOUR = 3600;
const START = Date.UTC(2026, 9, 18, 9, 0, 0);

const reason = (r: { ok: boolean; error?: { control: string; reason: string } }) =>
  r.ok ? 'done' : `${r.error?.control} ${r.error?.reason}`;
const pdf = (marker: string) => new TextEncoder().encode(`%PDF-1.7\n% delivery note ${marker}\n%%EOF\n`);
const OWNERSHIP_INVOICE = {
  invoiceUuid: '7b1e0c4a-1111-4000-8000-00000000a001',
  invoiceHash: 'ownership-invoice-hash-1',
};

let clock = START;
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

beforeEach(async () => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = START;
  vi.setSystemTime(clock);
  limit.override = undefined;
  resetTransactions();
  resetFacilities();
  await approveTestFacilities();
});
afterEach(() => {
  vi.useRealTimers();
});

const DISTRIBUTOR: Readonly<Record<string, string>> = {
  Rawabi: 'Rawabi Industrial Supplies Establishment',
  Tamam: 'Tamam Foodstuff Trading Company',
  'Al-Ufuq': 'Al-Ufuq Materials Company Limited',
};

let serial = 0;
/**
 * Key, submit and approve a fresh request for `counterparty` against an invoice of its own (issued by the
 * anchor, Al-Ufuq, as every invoice in the development book is), and open its transaction.
 */
async function opened(counterparty: string): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: DISTRIBUTOR[counterparty] ?? counterparty,
      channel: 'MAKER_CHECKER',
      invoiceUuid: `${TEST_INVOICES}${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W2-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  if (expectOk(submit(keyed.requestId)).state === 'AWAITING_SERVICING_RESPONSE')
    expectOk(
      applyServicingOutcome(keyed.requestId, {
        decision: 'APPROVED',
        reference: `svc_${keyed.requestId}`,
        respondedAt: developmentAttestation(),
      }),
    );
  expectOk(approveRequest(keyed.requestId, SENIOR));
  return expectOk(await openTransactionForRequest(T, keyed.requestId, 'stf-senior-01'));
}

/** Walk a transaction to POSSESSION_CONFIRMED, each step a second apart. */
async function toPossession(ref: string): Promise<TransactionView> {
  for (const s of [validateAndReserve, executeWaad, executePurchase]) {
    advance(1);
    expectOk(await s(T, ref, MAKER));
  }
  advance(1);
  expectOk(await recordOwnershipInvoice(T, ref, MAKER, OWNERSHIP_INVOICE));
  advance(1);
  expectOk(await acquireOwnership(T, ref, MAKER));
  advance(1);
  const recorded = expectOk(
    await recordPossessionEvidence(T, ref, MAKER, {
      evidenceType: 'DELIVERY_NOTE',
      source: 'ANCHOR_SYSTEM',
      bytes: pdf(ref),
    }),
  );
  const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
  advance(1);
  expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
  advance(1);
  return expectOk(await confirmPossession(T, ref, MAKER));
}

describe('the Murabaha sequence in the workbench', () => {
  it('runs from DRAFT to the sale offer only in order, each gate passing only on what discharges it', async () => {
    const ref = (await opened('Rawabi')).transactionRef;

    // Nothing can be skipped: no offer from DRAFT, no purchase before the wa'd, no gate before the purchase.
    expect(reason(await offerSale(T, ref, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');
    expect(reason(await executeWaad(T, ref, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');
    const reserved = expectOk(await validateAndReserve(T, ref, MAKER));
    expect(reserved.transaction.state).toBe('LIMIT_RESERVED');
    expect(reason(await executePurchase(T, ref, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');
    expect(reason(await recordOwnershipInvoice(T, ref, MAKER, OWNERSHIP_INVOICE))).toBe(
      'OP-DETERMINACY STEP_NOT_AVAILABLE',
    );

    advance(1);
    expectOk(await executeWaad(T, ref, MAKER));
    advance(1);
    const purchased = expectOk(await executePurchase(T, ref, MAKER));
    expect(purchased.transaction.state).toBe('PURCHASE_EXECUTED');
    const legs = 'legs' in purchased.transaction ? purchased.transaction.legs : [];
    expect(legs.map((l) => [l.legType, l.counterpartyRole, l.templateVersionId])).toEqual([
      ['WAAD', 'BUYER', 'waad_promise@3'],
      ['PURCHASE', 'SELLER', 'purchase_contract@3'],
    ]);
    // Chained, and strictly later: the second leg names the first's hash.
    expect(legs[1]?.prevLegHash).toBe(legs[0]?.contentHash);
    expect(legs[1]?.executedAt.epochSeconds).toBeGreaterThan(legs[0]?.executedAt.epochSeconds ?? 0n);
    expect(legs[1]?.documentId).not.toBe(legs[0]?.documentId);

    // Gate 1: no evidence, no ownership.
    expect(reason(await acquireOwnership(T, ref, MAKER))).toBe('SH-05 NO_ADMISSIBLE_EVIDENCE');
    // The financed invoice names the distributor; it is not ownership evidence.
    const tradeInvoice = purchased.transaction.core.tradeReference.invoiceUuid ?? '';
    expect(reason(await recordOwnershipInvoice(T, ref, MAKER, { invoiceUuid: tradeInvoice, invoiceHash: 'h' }))).toBe(
      'OP-DETERMINACY OWNERSHIP_INVOICE_IS_THE_TRADE_INVOICE',
    );
    // An invoice the authority did not clear is recorded, INVALID, and discharges nothing.
    const notCleared = expectOk(
      await recordOwnershipInvoice(T, ref, MAKER, {
        invoiceUuid: '7b1e0c4a-1111-4000-8000-00000000a002',
        invoiceHash: 'reject-me',
      }),
    );
    expect(notCleared.evidence.at(-1)).toMatchObject({ validationStatus: 'INVALID' });
    expect(reason(await acquireOwnership(T, ref, MAKER))).toBe('SH-05 NO_ADMISSIBLE_EVIDENCE');
    advance(1);
    const cleared = expectOk(await recordOwnershipInvoice(T, ref, MAKER, OWNERSHIP_INVOICE));
    expect(cleared.evidence.at(-1)).toMatchObject({
      evidenceType: 'OWNERSHIP_INVOICE',
      source: 'E_INVOICING_AUTHORITY',
      validationStatus: 'VALID',
      validationDetail: expect.objectContaining({
        clearanceStatus: 'CLEARED',
        recipientIsInstitution: true,
        issuerIsSeller: true,
        totalMatchesCost: true,
        rail: 'FIXTURE',
      }),
    });
    advance(1);
    expect(expectOk(await acquireOwnership(T, ref, MAKER)).transaction.state).toBe('OWNERSHIP_ACQUIRED');

    // Gate 2: possession evidence waits for a different person.
    advance(1);
    const recorded = expectOk(
      await recordPossessionEvidence(T, ref, MAKER, {
        evidenceType: 'DELIVERY_NOTE',
        source: 'ANCHOR_SYSTEM',
        bytes: pdf('a'),
      }),
    );
    const pending = recorded.evidence.find((e) => e.validationStatus === 'PENDING');
    expect(pending?.gateSatisfied).toBe('GATE_2_POSSESSION');
    expect(reason(await confirmPossession(T, ref, MAKER))).toBe('SH-05 NO_ADMISSIBLE_EVIDENCE');
    expect(reason(await decidePossessionEvidence(T, ref, MAKER, pending?.evidenceId ?? '', 'VALID'))).toBe(
      'OP-DETERMINACY FOUR_EYES_SELF_VERIFICATION',
    );
    expect(
      reason(
        await recordPossessionEvidence(T, ref, MAKER, {
          evidenceType: 'OWNERSHIP_INVOICE',
          source: 'UPLOAD',
          bytes: pdf('b'),
        }),
      ),
    ).toBe('SH-05 EVIDENCE_TYPE_NOT_ADMISSIBLE');
    advance(1);
    const validated = expectOk(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'));
    const live = validated.evidence.filter(
      (e) => e.gateSatisfied === 'GATE_2_POSSESSION' && e.supersededBy === undefined,
    );
    expect(live.map((e) => e.validationStatus)).toEqual(['VALID']);
    // The fact keeps the instant it was captured; the review does not move the risk period's start.
    expect(live[0]?.capturedAt.epochSeconds).toBe(pending?.capturedAt.epochSeconds);
    expect(reason(await decidePossessionEvidence(T, ref, CHECKER, pending?.evidenceId ?? '', 'VALID'))).toBe(
      'OP-DETERMINACY EVIDENCE_NOT_PENDING',
    );
    advance(1);
    const possessed = expectOk(await confirmPossession(T, ref, MAKER));
    expect(possessed.transaction.state).toBe('POSSESSION_CONFIRMED');

    // Gate 3: not one second inside the interval, measured from the attested start of possession.
    if (possessed.transaction.state !== 'POSSESSION_CONFIRMED') throw new Error('not possessed');
    clock = Number(possessed.transaction.riskPeriodStartAt.epochSeconds + BigInt(HOUR) - 1n) * 1000;
    vi.setSystemTime(clock);
    expect(reason(await offerSale(T, ref, MAKER))).toBe('SH-06 RISK_PERIOD_NOT_ELAPSED');
    advance(1);
    const offered = expectOk(await offerSale(T, ref, MAKER));
    expect(offered.transaction.state).toBe('SALE_OFFERED');
    expect(offered.gates.allSatisfied).toBe(true);
    if (offered.transaction.state !== 'SALE_OFFERED') throw new Error('not offered');
    expect(
      offered.transaction.saleOfferedAt.epochSeconds - offered.transaction.riskPeriodStartAt.epochSeconds,
    ).toBeGreaterThanOrEqual(BigInt(HOUR));
    expect(offered.transaction.legs.at(-1)).toMatchObject({ legType: 'SALE_OFFER', counterpartyRole: 'BUYER' });

    // The distributor accepts (W3 puts this in the SME portal): strictly after the offer, the goods to a different party.
    advance(60);
    const accepted = expectOk(await acceptSaleOffer(T, ref, 'distributor:rawabi'));
    expect(accepted.transaction.state).toBe('EXECUTED');

    // The event log rebuilds exactly what the steps produced.
    const rebuilt = replay({
      transactionRef: accepted.transactionRef,
      requestRef: accepted.requestRef,
      state: accepted.transaction.state,
      events: accepted.events,
    });
    expect(rebuilt?.transaction).toEqual(accepted.transaction);
    expect(rebuilt?.evidence).toEqual(accepted.evidence);
    expect(accepted.events.map((e) => e.eventType)).toEqual([
      'TRANSACTION_OPENED',
      'LIMIT_RESERVED',
      'LEG_EXECUTED',
      'LEG_EXECUTED',
      'EVIDENCE_RECORDED',
      'EVIDENCE_RECORDED',
      'GATE_PASSED',
      'EVIDENCE_RECORDED',
      'EVIDENCE_VALIDATED',
      'GATE_PASSED',
      'SALE_OFFERED',
      'OFFER_ACCEPTED',
    ]);
    // A profit amount, never a rate: nothing a step recorded names one (M-1).
    expect(JSON.stringify(accepted.events.map((e) => e.detail))).not.toMatch(/rate|apr|"bp"/i);
  });

  it('a trade whose goods would go back to their seller is rejected before anything is bought', async () => {
    // The development book's Al-Ufuq request: Al-Ufuq issued the invoice and is the distributor drawing on it.
    const ref = (await opened('Al-Ufuq')).transactionRef;
    const refused = expectOk(await validateAndReserve(T, ref, MAKER));
    expect(refused.transaction.state).toBe('REJECTED');
    if (refused.transaction.state !== 'REJECTED') throw new Error('not rejected');
    expect(refused.transaction.reasons.map((r) => `${r.control} ${r.reason}`)).toEqual(['SH-08 PARTIES_NOT_DISTINCT']);
    expect(reason(await executeWaad(T, ref, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');
  });

  it('nothing is held beyond the programme’s limit, and the transaction stays in DRAFT to try again', async () => {
    const v = await opened('Rawabi');
    limit.override = v.transaction.core.pricing.costAmount.minorUnits - 1n;
    expect(reason(await validateAndReserve(T, v.transactionRef, MAKER))).toBe('OP-LIMIT PROGRAMME_LIMIT_EXCEEDED');
    limit.override = undefined;
    expect(expectOk(await validateAndReserve(T, v.transactionRef, MAKER)).transaction.state).toBe('LIMIT_RESERVED');
  });

  it('an offer not accepted in time lapses, cannot then be accepted, and unwinds only with the goods’ disposition', async () => {
    const ref = (await opened('Rawabi')).transactionRef;
    await toPossession(ref);
    advance(HOUR);
    expectOk(await offerSale(T, ref, MAKER));
    expect(reason(await lapseSaleOffer(T, ref, MAKER))).toBe('SH-03 OFFER_STILL_LIVE');
    advance(2 * 86_400 + 1);
    expect(reason(await acceptSaleOffer(T, ref, 'distributor:rawabi'))).toBe('SH-03 OFFER_EXPIRED');
    expect(expectOk(await lapseSaleOffer(T, ref, MAKER)).transaction.state).toBe('OFFER_LAPSED');
    expect(reason(await unwindTransaction(T, ref, CHECKER, '   '))).toBe(
      'OP-DETERMINACY GOODS_DISPOSITION_UNDOCUMENTED',
    );
    const unwound = expectOk(
      await unwindTransaction(
        T,
        ref,
        CHECKER,
        'Goods returned to the anchor under the purchase contract’s return clause',
      ),
    );
    expect(unwound.transaction.state).toBe('UNWIND');
    expect(reason(await offerSale(T, ref, MAKER))).toBe('OP-DETERMINACY STEP_NOT_AVAILABLE');
  });

  it('one ownership invoice evidences one purchase', async () => {
    const first = (await opened('Rawabi')).transactionRef;
    await toPossession(first);
    const second = (await opened('Tamam')).transactionRef;
    for (const s of [validateAndReserve, executeWaad, executePurchase]) {
      advance(1);
      expectOk(await s(T, second, MAKER));
    }
    expect(reason(await recordOwnershipInvoice(T, second, MAKER, OWNERSHIP_INVOICE))).toBe(
      'SH-10 OWNERSHIP_INVOICE_ALREADY_EVIDENCED',
    );
  });
});
