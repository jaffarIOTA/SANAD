/**
 * Wasl W6b-1 — the Shariah review and its incidents (BR-F03, BR-F04, BR-F07).
 * Each case either tampers with a transaction's record as an operator with
 * the database could, and passes only when the review finds it, or attempts
 * to move an incident or a sale past the institution's reviewers:
 *
 *   - a correctly executed sale is found clean: the review raises nothing it
 *     should not;
 *   - an altered document, a template its approval does not cover, a broken
 *     chain, a sale offered before the risk period or without its evidence,
 *     parties that are not distinct, an inaccurate sale price, excluded or
 *     unrecorded goods, a state ahead of its contracts — each is found;
 *   - a finding is raised once, however often the review runs;
 *   - an incident moved out of order, re-rated without a reason, closed by
 *     its remediator or without evidence, or closed with income unpurified;
 *   - a transaction with an open MATERIAL incident committed to its sale.
 *
 * In memory (bank-a), under a fixed clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StaffAuthority } from '@sanad/core/config/staff-identity.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import { SHARIAH_REVIEW_PRINCIPAL } from '@sanad/core/shariah/incidents.ts';
import type { ContractLeg } from '@sanad/products/murabaha-scf/legs/leg.ts';
import type { Transaction } from '@sanad/products/murabaha-scf/sequencing/state.ts';

import { permits } from '../../apps/ops/src/server/authority.ts';
import {
  acquireOwnership,
  confirmPossession,
  decidePossessionEvidence,
  executePurchase,
  executeWaad,
  offerSale,
  recordOwnershipInvoice,
  recordPossessionEvidence,
  unwindTransaction,
  validateAndReserve,
} from '../../apps/ops/src/server/murabaha-sequencing.ts';
import { openTransactionForRequest, resetTransactions } from '../../apps/ops/src/server/murabaha-transactions.ts';
import type { StaffPrincipal } from '../../apps/ops/src/server/staff.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import {
  actOnIncident,
  raiseObservation,
  resetShariahIncidents,
  shariahIncidents,
} from '../../services/origination/src/shariah/incidents.ts';
import { type TransactionRecord, getTransaction, hydrate } from '../../services/origination/src/wasl/book.ts';
import { findingsFor, runShariahReview } from '../../services/origination/src/wasl/compliance.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { acceptSaleOffer } from '../../services/origination/src/wasl/steps.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e6b0000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
const R1 = 'stf-shariah-01';
const R2 = 'stf-shariah-02';
const HOUR = 3600;

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
/** A Rawabi transaction, opened and walked to `until`. */
async function walked(until: 'LIMIT_RESERVED' | 'EXECUTED'): Promise<string> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: `9e6b0000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W6B-${String(serial)}`,
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
  advance(1);
  expectOk(await validateAndReserve(T, ref, MAKER));
  if (until === 'LIMIT_RESERVED') return ref;
  for (const s of [executeWaad, executePurchase]) {
    advance(1);
    expectOk(await s(T, ref, MAKER));
  }
  advance(1);
  expectOk(
    await recordOwnershipInvoice(T, ref, MAKER, {
      invoiceUuid: `7b1e0c4a-6b6b-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-w6b-${String(serial)}`,
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
      assertionId: `demo-approve-w6b-${String(serial)}`,
      offerHash: 'a'.repeat(64),
      signatoryRef: 'sig-rawabi-01',
    }),
  );
  return ref;
}

const recordOf = async (ref: string): Promise<TransactionRecord> => {
  const r = (await hydrate(T)).records.get(ref);
  if (r === undefined) throw new Error(`no ${ref}`);
  return r;
};
const legsOf = (t: Transaction): readonly ContractLeg[] => ('legs' in t ? t.legs : []);
/** The record with its legs changed. */
const withLegs = (r: TransactionRecord, change: (l: ContractLeg) => ContractLeg): TransactionRecord => ({
  ...r,
  transaction: { ...r.transaction, legs: legsOf(r.transaction).map(change) } as Transaction,
});
const reasonsOf = async (r: TransactionRecord): Promise<readonly string[]> =>
  expectOk(await findingsFor(T, r)).map((f) => f.reason);

describe('the review finds what it should, and nothing it should not', () => {
  it('a sale executed as the structure requires is found clean', async () => {
    const ref = await walked('EXECUTED');
    expect(await reasonsOf(await recordOf(ref))).toEqual([]);
    const review = expectOk(await runShariahReview(T, SHARIAH_REVIEW_PRINCIPAL));
    expect(review).toMatchObject({ checked: 1, findings: 0, raised: [] });
  });

  it('an executed document altered after the fact is found, and so is the chain it breaks', async () => {
    const r = await recordOf(await walked('EXECUTED'));
    const altered = withLegs(r, (l) => (l.legType === 'PURCHASE' ? { ...l, contentHash: 'f'.repeat(64) } : l));
    const found = await reasonsOf(altered);
    expect(found).toContain('DOCUMENT_DIFFERS_FROM_TEMPLATE');
    expect(found).toContain('HASH_CHAIN_BROKEN');
  });

  it('a leg on a template version its approval does not cover is found', async () => {
    const r = await recordOf(await walked('EXECUTED'));
    const drifted = withLegs(r, (l) =>
      l.legType === 'SALE_OFFER' ? { ...l, templateVersionId: 'murabaha_offer@2' } : l,
    );
    const found = await reasonsOf(drifted);
    expect(found).toContain('TEMPLATE_NOT_IN_APPROVAL');
    // The document no longer is what the approved template makes either.
    expect(found).toContain('DOCUMENT_DIFFERS_FROM_TEMPLATE');
  });

  it('a sale offered before the risk period ran, or without its possession evidence, is found', async () => {
    const r = await recordOf(await walked('EXECUTED'));
    const possession = r.evidence.find(
      (e) => e.gateSatisfied === 'GATE_2_POSSESSION' && e.validationStatus === 'VALID',
    );
    const offer = legsOf(r.transaction).find((l) => l.legType === 'SALE_OFFER');
    if (possession === undefined || offer === undefined) throw new Error('walk incomplete');
    // Possession captured a minute before the offer: the board's hour was not held.
    const early = {
      ...r,
      evidence: r.evidence.map((e) =>
        e.evidenceId === possession.evidenceId
          ? { ...e, capturedAt: { ...e.capturedAt, epochSeconds: offer.executedAt.epochSeconds - 60n } }
          : e,
      ),
    };
    expect(await reasonsOf(early)).toContain('SOLD_BEFORE_RISK_PERIOD');
    const unevidenced = { ...r, evidence: r.evidence.filter((e) => e.gateSatisfied !== 'GATE_2_POSSESSION') };
    expect(await reasonsOf(unevidenced)).toContain('SOLD_WITHOUT_GATE');
  });

  it('a buyer who is also the seller, a price that is not cost plus profit, and a state ahead of its legs are found', async () => {
    const r = await recordOf(await walked('EXECUTED'));
    const seller = legsOf(r.transaction).find((l) => l.counterpartyRole === 'SELLER')?.counterpartyCr ?? '';
    const inah = withLegs(r, (l) => (l.counterpartyRole === 'BUYER' ? { ...l, counterpartyCr: seller } : l));
    expect(await reasonsOf(inah)).toContain('PARTIES_NOT_DISTINCT');

    const p = r.transaction.core.pricing;
    const overstated = {
      ...r,
      transaction: {
        ...r.transaction,
        core: {
          ...r.transaction.core,
          pricing: { ...p, salePriceAmount: { ...p.salePriceAmount, minorUnits: p.salePriceAmount.minorUnits + 1n } },
        },
      } as Transaction,
    };
    expect(await reasonsOf(overstated)).toContain('SALE_PRICE_NOT_COST_PLUS_PROFIT');

    const ahead = {
      ...r,
      transaction: { ...r.transaction, legs: legsOf(r.transaction).slice(0, 2) } as Transaction,
    };
    expect(await reasonsOf(ahead)).toContain('STATE_AHEAD_OF_LEGS');
  });

  it('goods the register excluded at opening, and goods whose screening was not recorded, are found', async () => {
    const r = await recordOf(await walked('EXECUTED'));
    const goods = (lines: unknown) => ({
      ...r,
      events: r.events.map((e) =>
        e.eventType === 'TRANSACTION_OPENED' ? { ...e, detail: { ...e.detail, goods: lines } } : e,
      ),
    });
    expect(await reasonsOf(goods([{ lineNo: 1, goodsClassificationCode: '2204' }]))).toContain(
      'GOODS_EXCLUDED_AT_OPENING',
    );
    expect(await reasonsOf(goods(undefined))).toContain('GOODS_SCREENING_NOT_RECORDED');
  });

  it('raises each finding once, however often the review runs', async () => {
    const ref = await walked('EXECUTED');
    const r = await recordOf(ref);
    (await hydrate(T)).records.set(
      ref,
      withLegs(r, (l) => (l.legType === 'ACCEPTANCE' ? { ...l, contentHash: 'e'.repeat(64) } : l)),
    );
    const first = expectOk(await runShariahReview(T, SHARIAH_REVIEW_PRINCIPAL));
    expect(first.raised.length).toBeGreaterThan(0);
    advance(86_400);
    expect(expectOk(await runShariahReview(T, SHARIAH_REVIEW_PRINCIPAL)).raised).toEqual([]);
    const raised = await shariahIncidents(T);
    expect(raised).toHaveLength(first.raised.length);
    expect(raised.every((i) => i.subjectRef === ref && i.raisedBy === SHARIAH_REVIEW_PRINCIPAL)).toBe(true);
    expect(raised.find((i) => i.reason === 'DOCUMENT_DIFFERS_FROM_TEMPLATE')?.severity).toBe('MATERIAL');
  });
});

describe('an incident is worked by the Shariah reviewers, in order, and closed by another', () => {
  async function raised(severity: 'LOW' | 'MATERIAL' = 'LOW'): Promise<string> {
    const ref = await walked('LIMIT_RESERVED');
    const i = expectOk(
      await raiseObservation(T, R1, {
        subjectRef: ref,
        productCode: 'murabaha-scf',
        severity,
        observation: 'The delivery note is unsigned',
      }),
    );
    if (i === undefined) throw new Error('not raised');
    return i.incidentRef;
  }

  it('refuses a step out of order, a re-rating without a reason, closing by the remediator or without evidence', async () => {
    const si = await raised();
    expect(reason(await actOnIncident(T, R1, si, { kind: 'PLAN', plan: 'Ask for a signed note' }))).toBe(
      'OP-DETERMINACY INCIDENT_STEP_OUT_OF_ORDER',
    );
    expect(reason(await actOnIncident(T, R1, si, { kind: 'TRIAGE', severity: 'HIGH', owner: R1, note: '' }))).toBe(
      'OP-DETERMINACY INCIDENT_RERATING_REASON_REQUIRED',
    );
    expectOk(
      await actOnIncident(T, R1, si, { kind: 'TRIAGE', severity: 'HIGH', owner: R1, note: 'Goods are at risk' }),
    );
    expectOk(await actOnIncident(T, R1, si, { kind: 'PLAN', plan: 'Ask the anchor for a signed note' }));
    expectOk(
      await actOnIncident(T, R1, si, { kind: 'REMEDIATE', note: 'Signed note received', purificationRequired: false }),
    );
    expect(reason(await actOnIncident(T, R1, si, { kind: 'CLOSE', closureEvidence: 'DOC-1234' }))).toBe(
      'OP-DETERMINACY FOUR_EYES_SELF_APPROVAL',
    );
    expect(reason(await actOnIncident(T, R2, si, { kind: 'CLOSE', closureEvidence: '' }))).toBe(
      'OP-DETERMINACY INCIDENT_CLOSURE_EVIDENCE_REQUIRED',
    );
    const closed = expectOk(await actOnIncident(T, R2, si, { kind: 'CLOSE', closureEvidence: 'DOC-1234' }));
    expect(closed).toMatchObject({ status: 'CLOSED', currentSeverity: 'HIGH', remediatedBy: R1, closedBy: R2 });
    expect(reason(await actOnIncident(T, R2, si, { kind: 'CLOSE', closureEvidence: 'again' }))).toBe(
      'OP-DETERMINACY INCIDENT_STEP_OUT_OF_ORDER',
    );
  });

  it('an incident that affected income does not close until the income is purified', async () => {
    const si = await raised();
    expectOk(await actOnIncident(T, R1, si, { kind: 'TRIAGE', severity: 'LOW', owner: R1, note: '' }));
    expectOk(await actOnIncident(T, R1, si, { kind: 'PLAN', plan: 'Purify the profit' }));
    expectOk(
      await actOnIncident(T, R1, si, { kind: 'REMEDIATE', note: 'Sale was defective', purificationRequired: true }),
    );
    expect(reason(await actOnIncident(T, R2, si, { kind: 'CLOSE', closureEvidence: 'Board minute 9' }))).toBe(
      'SH-13 INCIDENT_PURIFICATION_PENDING',
    );
  });

  it('the same observation on the same transaction is raised once', async () => {
    const si = await raised();
    const subject = (await shariahIncidents(T)).find((i) => i.incidentRef === si)?.subjectRef ?? '';
    expect(
      expectOk(
        await raiseObservation(T, R2, {
          subjectRef: subject,
          productCode: 'murabaha-scf',
          severity: 'LOW',
          observation: 'The delivery note is unsigned',
        }),
      ),
    ).toBeUndefined();
    expect(
      reason(
        await raiseObservation(T, R2, {
          subjectRef: subject,
          productCode: 'murabaha-scf',
          severity: 'LOW',
          observation: ' ',
        }),
      ),
    ).toBe('OP-DETERMINACY OBSERVATION_REQUIRED');
  });
});

describe('an open MATERIAL incident stops the sale (decided 26 October 2026)', () => {
  it('no wa’d while it is open; a lower rating or closing it lets the sale continue; unwinding is never stopped', async () => {
    const ref = await walked('LIMIT_RESERVED');
    const i = expectOk(
      await raiseObservation(T, R1, {
        subjectRef: ref,
        productCode: 'murabaha-scf',
        severity: 'MATERIAL',
        observation: 'The anchor and the distributor share a director',
      }),
    );
    const si = i?.incidentRef ?? '';
    expect(reason(await executeWaad(T, ref, MAKER))).toBe('SH-17 SHARIAH_INCIDENT_OPEN');
    expect((await getTransaction(T, ref))?.transaction.state).toBe('LIMIT_RESERVED');
    // Triaged as material it still stops the sale; re-rated with a reason, it does not.
    expectOk(
      await actOnIncident(T, R1, si, {
        kind: 'TRIAGE',
        severity: 'HIGH',
        owner: R1,
        note: 'Director resigned in 2024',
      }),
    );
    advance(1);
    expectOk(await executeWaad(T, ref, MAKER));

    // Another, material, after the wa'd: no purchase — but the position is unwound.
    expectOk(
      await raiseObservation(T, R2, {
        subjectRef: ref,
        productCode: 'murabaha-scf',
        severity: 'MATERIAL',
        observation: 'The invoice was issued after the wa’d',
      }),
    );
    advance(1);
    expect(reason(await executePurchase(T, ref, MAKER))).toBe('SH-17 SHARIAH_INCIDENT_OPEN');
    expectOk(await unwindTransaction(T, ref, 'stf-senior-01', 'No goods were bought'));
    expect((await getTransaction(T, ref))?.transaction.state).toBe('UNWIND');
  });

  it('a transaction already sold is not touched', async () => {
    const ref = await walked('EXECUTED');
    expectOk(
      await raiseObservation(T, R1, {
        subjectRef: ref,
        productCode: 'murabaha-scf',
        severity: 'MATERIAL',
        observation: 'Review the offer wording',
      }),
    );
    expect((await getTransaction(T, ref))?.transaction.state).toBe('EXECUTED');
  });
});

describe('incidents are the Shariah reviewers’ to work', () => {
  const person = (authorities: readonly StaffAuthority[]): StaffPrincipal => ({
    principalId: 'p',
    tenantId: T,
    authorities,
  });
  it('only a Shariah reviewer acts on them', () => {
    expect(permits(person(['SHARIAH_REVIEWER']), 'SHARIAH_INCIDENT_ACT').allowed).toBe(true);
    for (const a of ['MAKER', 'CHECKER', 'SENIOR_CHECKER', 'CREDIT_COMMITTEE', 'FINANCE', 'SHARIAH_AUDITOR'] as const)
      expect(permits(person([a]), 'SHARIAH_INCIDENT_ACT').allowed).toBe(false);
  });
});
