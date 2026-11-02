/**
 * Wasl W6c — the Shariah audit workspace and the Board report (BR-F05,
 * BR-F08, SH-18). Each case asks what a Board member must be able to rely on
 * without technical assistance, and passes only when it holds:
 *
 *   - a sample can be drawn again by anyone with the same seed, and cannot be
 *     steered by the order transactions are listed in;
 *   - a correctly executed sale replays clean, every check passing; one whose
 *     record was altered replays with the alteration shown;
 *   - an audit pack that is changed after export says so, and which part;
 *   - the Board report counts what happened in the period;
 *   - the Board's auditor reads and observes, and can do nothing else.
 *
 * In memory (bank-a), under a fixed clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StaffAuthority } from '@sanad/core/config/staff-identity.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { sampleOf } from '@sanad/core/shariah/sampling.ts';
import type { ContractLeg } from '@sanad/products/murabaha-scf/legs/leg.ts';
import type { Transaction } from '@sanad/products/murabaha-scf/sequencing/state.ts';

import { ACT_REQUIREMENTS, type WorkbenchAct, permits } from '../../apps/ops/src/server/authority.ts';
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
import type { StaffPrincipal } from '../../apps/ops/src/server/staff.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import { raiseObservation, resetShariahIncidents } from '../../services/origination/src/shariah/incidents.ts';
import {
  type AuditPack,
  auditPack,
  boardReport,
  replayTransaction,
  sampleTransactions,
  verifyAuditPack,
} from '../../services/origination/src/wasl/audit.ts';
import { hydrate } from '../../services/origination/src/wasl/book.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { acceptSaleOffer } from '../../services/origination/src/wasl/steps.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e6d0000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';
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

let serial = 0;
/** A Rawabi transaction sold and accepted. */
async function executed(): Promise<string> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: 'Rawabi Industrial Supplies Establishment',
      channel: 'MAKER_CHECKER',
      invoiceUuid: `9e6d0000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W6C-${String(serial)}`,
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
      invoiceUuid: `7b1e0c4a-6d6d-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceHash: `ownership-w6c-${String(serial)}`,
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
      assertionId: `demo-approve-w6c-${String(serial)}`,
      offerHash: 'a'.repeat(64),
      signatoryRef: 'sig-rawabi-01',
    }),
  );
  return ref;
}

describe('a sample anyone can draw again', () => {
  const population = Array.from({ length: 40 }, (_, i) => ({ ref: `WT-${String(i).padStart(6, '0')}` }));
  const sha = (s: string) => {
    // A stand-in hash for the pure function; the service uses SHA-256.
    let h = 2166136261;
    for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h.toString(16).padStart(8, '0');
  };
  const refs = (seed: string, pop = population) => sampleOf(pop, (x) => x.ref, seed, 5, sha).chosen.map((x) => x.ref);

  it('the same seed draws the same transactions, whatever order they are listed in; another seed draws others', () => {
    expect(refs('2026-10-26')).toEqual(refs('2026-10-26'));
    expect(refs('2026-10-26', [...population].reverse())).toEqual(refs('2026-10-26'));
    expect(refs('board-minute-14')).not.toEqual(refs('2026-10-26'));
    expect(sampleOf(population, (x) => x.ref, 's', 500, sha).chosen).toHaveLength(40);
    expect(sampleOf(population, (x) => x.ref, 's', 0, sha).chosen).toHaveLength(0);
  });

  it('the workspace draws from the book the same way', async () => {
    await executed();
    await executed();
    await executed();
    const first = await sampleTransactions(T, { executedOnly: true }, 'minute-14', 2);
    const again = await sampleTransactions(T, { executedOnly: true }, 'minute-14', 2);
    expect(first.population).toBe(3);
    expect(first.chosen.map((l) => l.transactionRef)).toEqual(again.chosen.map((l) => l.transactionRef));
  });
});

describe('the replay', () => {
  it('a sale executed as the structure requires replays clean, every check passing', async () => {
    const ref = await executed();
    const r = expectOk(await replayTransaction(T, ref));
    expect(r.chain.verified).toBe(true);
    expect(r.checks.every((c) => c.passed)).toBe(true);
    expect(r.financedOnce).toBe(true);
    expect(r.legs.map((l) => l.legType)).toEqual(['WAAD', 'PURCHASE', 'SALE_OFFER', 'ACCEPTANCE']);
    expect(
      r.legs.every((l) => l.linkedToPrevious && l.timeAfterPrevious && l.templateApproved && l.documentMatchesTemplate),
    ).toBe(true);
    expect(r.gates.every((g) => g.status === 'SATISFIED')).toBe(true);
    expect(r.riskPeriod.measuredAt).toBe('SALE_OFFER');
    expect((r.riskPeriod.heldSeconds ?? 0n) >= BigInt(r.riskPeriod.requiredSeconds)).toBe(true);
    expect(r.figures).toMatchObject({ salePriceIsCostPlusProfit: true, disclosedInOffer: true });
    expect(r.approval.standingAtOpening).toBe('IN_FORCE');
  });

  it('a record altered after the fact replays with the alteration shown', async () => {
    const ref = await executed();
    const book = await hydrate(T);
    const record = book.records.get(ref);
    if (record === undefined) throw new Error('no record');
    const legs: readonly ContractLeg[] = 'legs' in record.transaction ? record.transaction.legs : [];
    book.records.set(ref, {
      ...record,
      transaction: {
        ...record.transaction,
        legs: legs.map((l) => (l.legType === 'SALE_OFFER' ? { ...l, contentHash: '0'.repeat(64) } : l)),
      } as Transaction,
    });
    const r = expectOk(await replayTransaction(T, ref));
    expect(r.chain.verified).toBe(false);
    expect(r.legs.find((l) => l.legType === 'SALE_OFFER')?.documentMatchesTemplate).toBe(false);
    expect(r.legs.find((l) => l.legType === 'ACCEPTANCE')?.linkedToPrevious).toBe(false);
    expect(r.figures.disclosedInOffer).toBe(false);
    expect(r.checks.find((c) => c.checkCode === 'TEMPLATE_DRIFT')?.passed).toBe(false);
  });
});

describe('the audit pack', () => {
  it('verifies as exported, and names the part changed in a copy', async () => {
    const ref = await executed();
    const pack = expectOk(await auditPack(T, ref, 'stf-shariah-auditor-01'));
    expect(pack.format).toBe('sanad.shariah-audit-pack/1');
    expect(Object.keys(pack.manifest.parts).sort()).toEqual(
      [
        'approval',
        'charity',
        'checks',
        'contracts',
        'eventLog',
        'figures',
        'gatesAndEvidence',
        'goods',
        'incidents',
        'transaction',
      ].sort(),
    );
    // As a file, read back.
    const copy = JSON.parse(JSON.stringify(pack)) as AuditPack;
    expect(verifyAuditPack(copy)).toEqual({ intact: true, changed: [] });
    const edited = {
      ...copy,
      parts: { ...copy.parts, figures: { ...(copy.parts['figures'] as object), profitMinor: '1' } },
    };
    expect(verifyAuditPack(edited)).toEqual({ intact: false, changed: ['figures'] });
    // Whole numbers travel as strings, never as floats.
    expect(JSON.stringify(copy)).not.toMatch(/"profitMinor":\d/);
  });
});

describe('the Board report', () => {
  it('counts the period’s sales, the risk period held, incidents and the register', async () => {
    const ref = await executed();
    expectOk(
      await raiseObservation(T, 'stf-shariah-auditor-01', {
        subjectRef: ref,
        productCode: 'murabaha-scf',
        severity: 'MATERIAL',
        observation: 'The offer was made on a public holiday',
      }),
    );
    const r = await boardReport(T, '2026-10-01', '2026-10-31');
    expect(r.transactions).toMatchObject({ opened: 1, executed: 1 });
    expect(r.riskPeriod).toMatchObject({ salesOffered: 1, heldBelowRequired: 0 });
    expect((r.riskPeriod.shortestHeldSeconds ?? 0n) >= 3600n).toBe(true);
    expect(r.incidents.raised.MATERIAL).toBe(1);
    expect(r.incidents.openAtEnd.MATERIAL).toBe(1);
    expect(r.approvals.find((a) => a.approvalRef === 'SSB-A-2026-014')?.standingAtEnd).toBe('IN_FORCE');
    // A period before any of it: nothing.
    const before = await boardReport(T, '2026-01-01', '2026-01-31');
    expect(before.transactions).toMatchObject({ opened: 0, executed: 0 });
    expect(before.incidents.raised.MATERIAL).toBe(0);
  });
});

describe('the Board’s auditor reads and observes, and does nothing else', () => {
  const person = (authorities: readonly StaffAuthority[]): StaffPrincipal => ({
    principalId: 'p',
    tenantId: T,
    authorities,
  });
  it('the workspace is the auditor’s and the reviewers’; every other act is refused to the auditor', () => {
    for (const act of ['SHARIAH_AUDIT_READ', 'SHARIAH_OBSERVE'] as const) {
      expect(permits(person(['SHARIAH_AUDITOR']), act).allowed).toBe(true);
      expect(permits(person(['SHARIAH_REVIEWER']), act).allowed).toBe(true);
      for (const a of ['MAKER', 'CHECKER', 'SENIOR_CHECKER', 'CREDIT_COMMITTEE', 'FINANCE'] as const)
        expect(permits(person([a]), act).allowed).toBe(false);
    }
    const auditorMay = (Object.keys(ACT_REQUIREMENTS) as WorkbenchAct[]).filter(
      (act) => permits(person(['SHARIAH_AUDITOR']), act).allowed,
    );
    expect(auditorMay.sort()).toEqual(['SHARIAH_AUDIT_READ', 'SHARIAH_OBSERVE']);
  });
});
