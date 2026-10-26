/**
 * Wasl W6a — the Shariah approvals register (BR-F01, BR-F02, SH-17). Each case
 * attempts to originate without a live approval, or to change the register on
 * one person's word, and passes only when the attempt fails:
 *
 *   - an approval recorded, suspended, reinstated, withdrawn or renewed by the
 *     person who proposed it, rejected without a reason, proposed twice at
 *     once, recorded twice, or reinstated once withdrawn;
 *   - a proposal treated as in force before a second person confirms it;
 *   - new origination under an approval that is not recorded, not yet
 *     effective, past its review or expiry date, suspended, withdrawn, or that
 *     does not cover the product or the templates in use — at opening a Wasl
 *     transaction, at each step that commits to a new sale, and at a consumer
 *     quote and acceptance;
 *   - a lapse needing anybody to act: the date passes and origination stops;
 *   - a credit authority acting for the board, or a Shariah reviewer for credit.
 *
 * In memory (bank-a), under a fixed clock: 26 October 2026, 09:00 in Riyadh.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import {
  type ApprovalChange,
  type ApprovalTerms,
  approvalInForce,
  coversTemplates,
  registerAt,
  registerFrom,
  standingOn,
} from '@sanad/core/shariah/approvals.ts';
import { approvalRefusalText } from '@sanad/core/shariah/explain.ts';

import type { StaffAuthority } from '@sanad/core/config/staff-identity.ts';

import { permits } from '../../apps/ops/src/server/authority.ts';
import type { StaffPrincipal } from '../../apps/ops/src/server/staff.ts';
import {
  executePurchase,
  executeWaad,
  unwindTransaction,
  validateAndReserve,
} from '../../apps/ops/src/server/murabaha-sequencing.ts';
import {
  type TransactionView,
  getTransaction,
  openTransactionForRequest,
  resetTransactions,
} from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import {
  approvalChanges,
  catalogueApproval,
  decideApprovalChange,
  newBusinessShariahRefusal,
  proposeApprovalChange,
  resetShariahApprovals,
  shariahRegister,
} from '../../services/origination/src/shariah/approvals.ts';
import { hostClockInstant } from '../../services/origination/src/host-clock.ts';
import { resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { recordTestApproval } from '../support/shariah-approvals.ts';
import { approveTestFacilities } from '../support/wasl-facilities.ts';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e660000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

const T = 'bank-a';
const REVIEWER = 'stf-shariah-01';
const SECOND = 'stf-shariah-02';
const WASL_REF = 'SSB-A-2026-014';
const TAWARRUQ_REF = 'SSB-A-2026-021';
const BOARD_TEMPLATES = ['waad_promise@3', 'purchase_contract@3', 'murabaha_offer@3', 'murabaha_acceptance@3'];
const RAWABI = 'Rawabi Industrial Supplies Establishment';

// 09:00 in Riyadh on 26 October 2026.
let clock = Date.UTC(2026, 9, 26, 6, 0, 0);
const advance = (seconds: number) => {
  clock += seconds * 1000;
  vi.setSystemTime(clock);
};

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  resetTransactions();
  resetFacilities();
  resetShariahApprovals();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const reason = (r: Result<unknown>): string => (r.ok ? 'ok' : `${r.error.control} ${r.error.reason}`);

const terms = (over: Partial<ApprovalTerms> = {}): ApprovalTerms => ({
  approvalRef: WASL_REF,
  approvingBody: 'Shariah Supervisory Board of Bank A',
  members: ['Member one', 'Member two', 'Member three'],
  effectiveFrom: '2026-01-01',
  reviewOrExpiry: '2027-12-31',
  productCodes: ['murabaha-scf'],
  templateVersionIds: BOARD_TEMPLATES,
  ...over,
});

/** Proposed by one reviewer and confirmed by the other. */
async function change(c: ApprovalChange, reasonText = 'Board minute 2026/14'): Promise<void> {
  const p = expectOk(await proposeApprovalChange(T, REVIEWER, { change: c, reason: reasonText }));
  advance(60);
  expectOk(await decideApprovalChange(T, SECOND, { changeId: p.changeId, confirm: true, note: '' }));
  advance(60);
}

let serial = 0;
/** A fresh Rawabi request, approved: opening it is the next act. */
function approvedRequest(): string {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: 'prg-0001',
      counterpartyId: RAWABI,
      channel: 'MAKER_CHECKER',
      invoiceUuid: `9e660000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W6A-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  expectOk(
    approveRequest(keyed.requestId, { principalId: 'stf-committee-01', tenantId: T, authority: 'CREDIT_COMMITTEE' }),
  );
  advance(1);
  return keyed.requestId;
}

const open = (requestId: string) => openTransactionForRequest(T, requestId, 'stf-senior-02');

describe('the register takes two people', () => {
  it('a proposal is not in force; the proposer cannot confirm it; a rejection says why; a second proposal waits', async () => {
    const p = expectOk(
      await proposeApprovalChange(T, REVIEWER, { change: { kind: 'RECORD', terms: terms() }, reason: 'Minute 14' }),
    );
    expect(await shariahRegister(T)).toEqual([]);
    expect(reason(await decideApprovalChange(T, REVIEWER, { changeId: p.changeId, confirm: true, note: '' }))).toBe(
      'OP-DETERMINACY FOUR_EYES_SELF_APPROVAL',
    );
    expect(reason(await decideApprovalChange(T, SECOND, { changeId: p.changeId, confirm: false, note: '' }))).toBe(
      'OP-DETERMINACY REJECTION_REASON_REQUIRED',
    );
    expect(
      reason(
        await proposeApprovalChange(T, SECOND, { change: { kind: 'RECORD', terms: terms() }, reason: 'Minute 14' }),
      ),
    ).toBe('OP-DETERMINACY APPROVAL_CHANGE_OPEN');
    expectOk(await decideApprovalChange(T, SECOND, { changeId: p.changeId, confirm: false, note: 'Wrong members' }));
    expect(await shariahRegister(T)).toEqual([]);
    expect(
      reason(await decideApprovalChange(T, 'stf-shariah-03', { changeId: p.changeId, confirm: true, note: '' })),
    ).toBe('OP-DETERMINACY APPROVAL_CHANGE_ALREADY_DECIDED');
  });

  it('records what the board approved, and refuses a record that is incomplete or already held', async () => {
    const bad: readonly [Partial<ApprovalTerms>, string][] = [
      [{ approvalRef: 'x' }, 'APPROVAL_REF_MALFORMED'],
      [{ approvingBody: ' ' }, 'APPROVING_BODY_REQUIRED'],
      [{ members: [] }, 'APPROVING_MEMBERS_REQUIRED'],
      [{ members: ['Member one', 'Member one'] }, 'APPROVING_MEMBER_TWICE'],
      [{ effectiveFrom: '2026-02-30' }, 'EFFECTIVE_FROM_MALFORMED'],
      [{ reviewOrExpiry: '2025-12-31' }, 'REVIEW_DATE_MALFORMED'],
      [{ productCodes: ['bnpl'] }, 'APPROVAL_PRODUCTS_INVALID'],
      [{ productCodes: [] }, 'APPROVAL_PRODUCTS_INVALID'],
      [{ templateVersionIds: ['Waad Promise v3'] }, 'APPROVAL_TEMPLATES_MALFORMED'],
    ];
    for (const [over, expected] of bad)
      expect(
        reason(
          await proposeApprovalChange(T, REVIEWER, { change: { kind: 'RECORD', terms: terms(over) }, reason: 'r r r' }),
        ),
      ).toBe(`OP-DETERMINACY ${expected}`);
    expect(
      reason(await proposeApprovalChange(T, REVIEWER, { change: { kind: 'RECORD', terms: terms() }, reason: '' })),
    ).toBe('OP-DETERMINACY APPROVAL_CHANGE_REASON_REQUIRED');

    await change({ kind: 'RECORD', terms: terms() });
    const [recorded] = await shariahRegister(T);
    expect(recorded).toMatchObject({ ...terms(), status: 'IN_FORCE' });
    expect(recorded?.history.map((e) => [e.proposedBy, e.decidedBy])).toEqual([[REVIEWER, SECOND]]);
    expect(
      reason(await proposeApprovalChange(T, REVIEWER, { change: { kind: 'RECORD', terms: terms() }, reason: 'again' })),
    ).toBe('OP-DETERMINACY APPROVAL_ALREADY_RECORDED');
  });

  it('suspends, reinstates, renews and withdraws, each confirmed; a withdrawn approval stays withdrawn', async () => {
    await change({ kind: 'RECORD', terms: terms() });
    expect(
      reason(
        await proposeApprovalChange(T, REVIEWER, {
          change: { kind: 'REINSTATE', approvalRef: WASL_REF },
          reason: 'r r',
        }),
      ),
    ).toBe('OP-DETERMINACY APPROVAL_NOT_SUSPENDED');
    await change({ kind: 'SUSPEND', approvalRef: WASL_REF }, 'Board resolution to review the wa’d template');
    expect((await shariahRegister(T))[0]?.status).toBe('SUSPENDED');
    await change({ kind: 'REINSTATE', approvalRef: WASL_REF });
    expect((await shariahRegister(T))[0]?.status).toBe('IN_FORCE');
    expect(
      reason(
        await proposeApprovalChange(T, REVIEWER, {
          change: { kind: 'RENEW', approvalRef: WASL_REF, reviewOrExpiry: '2027-12-31' },
          reason: 'r r r',
        }),
      ),
    ).toBe('OP-DETERMINACY APPROVAL_RENEWAL_UNCHANGED');
    await change({ kind: 'RENEW', approvalRef: WASL_REF, reviewOrExpiry: '2028-12-31' });
    expect((await shariahRegister(T))[0]?.reviewOrExpiry).toBe('2028-12-31');
    await change({ kind: 'WITHDRAW', approvalRef: WASL_REF });
    for (const kind of ['REINSTATE', 'SUSPEND', 'WITHDRAW'] as const)
      expect(
        (await proposeApprovalChange(T, REVIEWER, { change: { kind, approvalRef: WASL_REF }, reason: 'r r r' })).ok,
      ).toBe(false);
    expect(
      reason(
        await proposeApprovalChange(T, REVIEWER, {
          change: { kind: 'RENEW', approvalRef: WASL_REF, reviewOrExpiry: '2029-12-31' },
          reason: 'r r r',
        }),
      ),
    ).toBe('OP-DETERMINACY APPROVAL_NOT_RENEWABLE');
    const [withdrawn] = await shariahRegister(T);
    expect(withdrawn?.status).toBe('WITHDRAWN');
    expect(withdrawn?.history.map((e) => e.change.kind)).toEqual([
      'RECORD',
      'SUSPEND',
      'REINSTATE',
      'RENEW',
      'WITHDRAW',
    ]);
  });

  it('answers what was in force at an earlier moment from the changes confirmed by then', async () => {
    await change({ kind: 'RECORD', terms: terms() });
    const beforeSuspension = BigInt(Math.floor(clock / 1000));
    await change({ kind: 'SUSPEND', approvalRef: WASL_REF });
    const entries = await approvalChanges(T);
    expect(registerAt(entries, beforeSuspension)[0]?.status).toBe('IN_FORCE');
    expect(registerFrom(entries)[0]?.status).toBe('SUSPENDED');
    expect(registerAt(entries, 0n)).toEqual([]);
  });
});

describe('standing is a date question (BR-F02)', () => {
  const approval = registerFrom([
    {
      changeId: 'c1',
      change: { kind: 'RECORD', terms: terms() },
      reason: 'r',
      state: 'CONFIRMED',
      proposedBy: 'a',
      proposedAtEpochSeconds: 1n,
      decidedBy: 'b',
      decidedAtEpochSeconds: 2n,
    },
  ]);

  it('is in force from its effective date through its review or expiry date, and lapses the day after', () => {
    const a = approval[0];
    if (a === undefined) throw new Error('no approval');
    expect(standingOn(a, '2025-12-31')).toBe('NOT_YET_EFFECTIVE');
    expect(standingOn(a, '2026-01-01')).toBe('IN_FORCE');
    expect(standingOn(a, '2027-12-31')).toBe('IN_FORCE');
    expect(standingOn(a, '2028-01-01')).toBe('LAPSED');
  });

  it('refuses each way an approval can fail to support a product, under SH-17', () => {
    const at = (date: string, ref: string | undefined = WASL_REF, product = 'murabaha-scf') =>
      reason(approvalInForce(approval, ref, product, date));
    expect(at('2026-10-26')).toBe('ok');
    expect(reason(approvalInForce(approval, undefined, 'murabaha-scf', '2026-10-26'))).toBe(
      'SH-17 SHARIAH_APPROVAL_NOT_CITED',
    );
    expect(at('2026-10-26', ' ')).toBe('SH-17 SHARIAH_APPROVAL_NOT_CITED');
    expect(at('2026-10-26', 'SSB-UNKNOWN')).toBe('SH-17 SHARIAH_APPROVAL_NOT_RECORDED');
    expect(at('2025-06-01')).toBe('SH-17 SHARIAH_APPROVAL_NOT_YET_EFFECTIVE');
    expect(at('2028-01-01')).toBe('SH-17 SHARIAH_APPROVAL_LAPSED');
    expect(at('2026-10-26', WASL_REF, 'tawarruq-personal')).toBe('SH-17 SHARIAH_APPROVAL_DOES_NOT_COVER_PRODUCT');
    const a = approval[0];
    if (a === undefined) throw new Error('no approval');
    expect(reason(coversTemplates(a, BOARD_TEMPLATES))).toBe('ok');
    expect(reason(coversTemplates(a, ['murabaha_offer@4']))).toBe('SH-17 SHARIAH_APPROVAL_DOES_NOT_COVER_TEMPLATES');
  });

  it('every SH-17 refusal has words in both languages, saying existing contracts continue', () => {
    for (const r of [
      'SHARIAH_APPROVAL_NOT_CITED',
      'SHARIAH_APPROVAL_NOT_RECORDED',
      'SHARIAH_APPROVAL_NOT_YET_EFFECTIVE',
      'SHARIAH_APPROVAL_LAPSED',
      'SHARIAH_APPROVAL_SUSPENDED',
      'SHARIAH_APPROVAL_WITHDRAWN',
      'SHARIAH_APPROVAL_DOES_NOT_COVER_PRODUCT',
      'SHARIAH_APPROVAL_DOES_NOT_COVER_TEMPLATES',
    ]) {
      const words = approvalRefusalText(r);
      expect(words?.en).toMatch(/Existing contracts/);
      expect(words?.ar).toMatch(/العقود القائمة/);
    }
  });
});

describe('no approval in force, no new Wasl transaction (SH-17)', () => {
  it('opens nothing while the approval is not recorded, and opens once it is confirmed', async () => {
    const requestId = approvedRequest();
    expect(reason(await open(requestId))).toBe('SH-17 SHARIAH_APPROVAL_NOT_RECORDED');
    const p = expectOk(
      await proposeApprovalChange(T, REVIEWER, { change: { kind: 'RECORD', terms: terms() }, reason: 'Minute 14' }),
    );
    expect(reason(await open(requestId))).toBe('SH-17 SHARIAH_APPROVAL_NOT_RECORDED');
    expectOk(await decideApprovalChange(T, SECOND, { changeId: p.changeId, confirm: true, note: '' }));
    expect(expectOk(await open(requestId)).transaction.state).toBe('DRAFT');
  });

  it('opens nothing under an approval that lapsed, with nobody acting on it', async () => {
    await change({ kind: 'RECORD', terms: terms({ reviewOrExpiry: '2026-10-26' }) });
    const requestId = approvedRequest();
    // Still in force on its last day.
    expectOk(await open(requestId));
    // The next morning in Riyadh it has lapsed: nothing was done, and nothing new opens.
    clock = Date.UTC(2026, 9, 27, 6, 0, 0);
    vi.setSystemTime(clock);
    expect(reason(await open(approvedRequest()))).toBe('SH-17 SHARIAH_APPROVAL_LAPSED');
  });

  it('opens nothing under an approval that is suspended or withdrawn, or that does not cover the board’s templates', async () => {
    await change({ kind: 'RECORD', terms: terms() });
    await change({ kind: 'SUSPEND', approvalRef: WASL_REF });
    expect(reason(await open(approvedRequest()))).toBe('SH-17 SHARIAH_APPROVAL_SUSPENDED');
    await change({ kind: 'WITHDRAW', approvalRef: WASL_REF });
    expect(reason(await open(approvedRequest()))).toBe('SH-17 SHARIAH_APPROVAL_WITHDRAWN');

    resetShariahApprovals();
    await change({ kind: 'RECORD', terms: terms({ templateVersionIds: BOARD_TEMPLATES.slice(0, 3) }) });
    expect(reason(await open(approvedRequest()))).toBe('SH-17 SHARIAH_APPROVAL_DOES_NOT_COVER_TEMPLATES');
  });

  it('a transaction opened before a suspension commits to nothing new after it, and may still be unwound', async () => {
    await approveTestFacilities();
    await change({ kind: 'RECORD', terms: terms() });
    const v: TransactionView = expectOk(await open(approvedRequest()));
    await change({ kind: 'SUSPEND', approvalRef: WASL_REF });
    expect(reason(await validateAndReserve(T, v.transactionRef, 'stf-maker-01'))).toBe(
      'SH-17 SHARIAH_APPROVAL_SUSPENDED',
    );
    expect((await getTransaction(T, v.transactionRef))?.transaction.state).toBe('DRAFT');
    await change({ kind: 'REINSTATE', approvalRef: WASL_REF });
    expectOk(await validateAndReserve(T, v.transactionRef, 'stf-maker-01'));
    expect((await getTransaction(T, v.transactionRef))?.transaction.state).toBe('LIMIT_RESERVED');
    // Suspended again with the limit held: no wa'd follows until it is reinstated.
    await change({ kind: 'SUSPEND', approvalRef: WASL_REF });
    expect(reason(await executeWaad(T, v.transactionRef, 'stf-maker-01'))).toBe('SH-17 SHARIAH_APPROVAL_SUSPENDED');
    expect((await getTransaction(T, v.transactionRef))?.transaction.state).toBe('LIMIT_RESERVED');
    await change({ kind: 'REINSTATE', approvalRef: WASL_REF });
    expectOk(await executeWaad(T, v.transactionRef, 'stf-maker-01'));
    // Suspended after the wa'd: no purchase, and the position is unwound instead.
    await change({ kind: 'SUSPEND', approvalRef: WASL_REF });
    expect(reason(await executePurchase(T, v.transactionRef, 'stf-maker-01'))).toBe('SH-17 SHARIAH_APPROVAL_SUSPENDED');
    expectOk(await unwindTransaction(T, v.transactionRef, 'stf-senior-01', 'No goods were bought'));
    expect((await getTransaction(T, v.transactionRef))?.transaction.state).toBe('UNWIND');
  });
});

describe('every other Islamic product stops with its approval (BR-F02)', () => {
  const at = () => hostClockInstant();

  it('a Tawarruq is not quoted without its approval in force; a conventional product is untouched', async () => {
    expect((await newBusinessShariahRefusal(T, 'tawarruq-personal', at()))?.reason).toBe(
      'SHARIAH_APPROVAL_NOT_RECORDED',
    );
    await recordTestApproval(T, TAWARRUQ_REF, ['tawarruq-personal']);
    expect(await newBusinessShariahRefusal(T, 'tawarruq-personal', at())).toBeUndefined();
    await change({ kind: 'SUSPEND', approvalRef: TAWARRUQ_REF });
    expect((await newBusinessShariahRefusal(T, 'tawarruq-personal', at()))?.control).toBe('SH-17');
    expect(await newBusinessShariahRefusal(T, 'bnpl', at())).toBeUndefined();
    expect(await newBusinessShariahRefusal(T, 'conventional-term', at())).toBeUndefined();
  });

  it('an Islamic product is not enabled in Admin without an approval in force when the change takes effect', async () => {
    const on = (date: string) => ({ epochSeconds: BigInt(Date.parse(`${date}T09:00:00+03:00`) / 1000) });
    const tawarruq = { productCode: 'tawarruq-personal', boardRulingRef: TAWARRUQ_REF };
    expect(reason(await catalogueApproval(T, tawarruq, on('2026-11-01')))).toBe('SH-17 SHARIAH_APPROVAL_NOT_RECORDED');
    expect(reason(await catalogueApproval(T, { productCode: 'tawarruq-personal' }, on('2026-11-01')))).toBe(
      'SH-17 SHARIAH_APPROVAL_NOT_CITED',
    );
    await change({
      kind: 'RECORD',
      terms: terms({ approvalRef: TAWARRUQ_REF, productCodes: ['tawarruq-personal'], reviewOrExpiry: '2026-12-31' }),
    });
    expectOk(await catalogueApproval(T, tawarruq, on('2026-11-01')));
    // Enabled to take effect after the approval lapses: refused now, not discovered later.
    expect(reason(await catalogueApproval(T, tawarruq, on('2027-01-01')))).toBe('SH-17 SHARIAH_APPROVAL_LAPSED');
    // A conventional product needs no approval.
    expect(expectOk(await catalogueApproval(T, { productCode: 'bnpl' }, on('2026-11-01')))).toBeUndefined();
  });

  it('a customer refused for it is told the finance is not available and nothing is recorded against them', async () => {
    const { explain } = await import('../../apps/consumer/src/server/explain.ts');
    expect(explain('SHARIAH_APPROVAL_LAPSED', false)).toMatch(/nothing has been recorded against you/);
    expect(explain('SHARIAH_APPROVAL_SUSPENDED', true)).toMatch(/لم يُسجَّل عليك أي شيء/);
  });
});

describe('the board’s register is the board’s people’s (SH-17)', () => {
  const person = (authorities: readonly StaffAuthority[]): StaffPrincipal => ({
    principalId: 'p',
    tenantId: T,
    authorities,
  });

  it('only a Shariah reviewer proposes or confirms; no credit authority acts for the board; a reviewer approves no credit', () => {
    for (const act of ['SHARIAH_APPROVAL_PROPOSE', 'SHARIAH_APPROVAL_CONFIRM'] as const) {
      expect(permits(person(['SHARIAH_REVIEWER']), act).allowed).toBe(true);
      for (const a of ['MAKER', 'CHECKER', 'SENIOR_CHECKER', 'CREDIT_COMMITTEE', 'FINANCE', 'SHARIAH_AUDITOR'] as const)
        expect(permits(person([a]), act).allowed).toBe(false);
    }
    for (const act of ['REVIEW', 'FACILITY_APPROVE', 'BUSINESS_DISBURSE', 'TRADE_OPERATIONS'] as const) {
      expect(permits(person(['SHARIAH_REVIEWER']), act).allowed).toBe(false);
      expect(permits(person(['SHARIAH_AUDITOR']), act).allowed).toBe(false);
    }
  });
});
