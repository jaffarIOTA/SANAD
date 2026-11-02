/**
 * Wasl W5b — programmes, anchors and the goods register, changed in Admin
 * under four eyes. Each case attempts what a change must never do, and passes
 * only when it is refused:
 *
 *   - remove a programme a transaction or a facility refers to;
 *   - give a programme that has traded a new anchor;
 *   - set a programme's limit below what it holds, or below a facility in it;
 *   - approve a facility above its programme as the programme now stands;
 *   - read around an approved revision: transaction opening and trade
 *     validation obey the board positions and programmes in force;
 *   - propose a programme list or a goods register half-read, or lose any
 *     other board position (the late-amount ruling among them) when the
 *     register changes.
 *
 * The book is in memory (bank-a). The configuration in force is replaced per
 * case, as an approved Admin revision replaces it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type WaslProgramme,
  loadBoardPositions,
  loadWaslParties,
  parseWaslProgrammes,
  waslProgrammesToJson,
} from '@sanad/config/loader.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import {
  type BoardPositions,
  boardPositionsToJson,
  parseBoardPositions,
} from '@sanad/products/murabaha-scf/structures/board-positions.ts';

import { boardWithGoodsChange, programmesWithChange } from '../../apps/admin/src/server/wasl-configuration.ts';
import { validateAndReserve } from '../../apps/ops/src/server/murabaha-sequencing.ts';
import { openTransactionForRequest, resetTransactions } from '../../apps/ops/src/server/murabaha-transactions.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import { decideFacility, proposeFacility, resetFacilities } from '../../services/origination/src/wasl/facilities.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { checkProgrammesChange } from '../../services/origination/src/wasl/programme-changes.ts';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e480000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

// The configuration in force, replaceable per case as an approved Admin revision would replace it.
const inForce = vi.hoisted(() => ({ programmes: undefined as unknown, board: undefined as unknown }));
vi.mock('../../services/origination/src/wasl/configuration.ts', async (original) => {
  const actual = await original<typeof import('../../services/origination/src/wasl/configuration.ts')>();
  return {
    ...actual,
    resolveWaslParties: async (...a: Parameters<typeof actual.resolveWaslParties>) => {
      const r = await actual.resolveWaslParties(...a);
      return !r.ok || inForce.programmes === undefined
        ? r
        : { ok: true, value: { ...r.value, programmes: inForce.programmes as readonly WaslProgramme[] } };
    },
    resolveBoard: async (...a: Parameters<typeof actual.resolveBoard>) =>
      inForce.board === undefined
        ? actual.resolveBoard(...a)
        : { value: { ok: true, value: inForce.board as BoardPositions }, source: 'REVISION' as const },
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const RAWABI = 'Rawabi Industrial Supplies Establishment';
const FILE = expectOk(loadWaslParties(T)).programmes;
const PRG = FILE[0] as WaslProgramme;

let clock = Date.UTC(2026, 9, 23, 9, 0, 0);
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
  await recordTestApprovals();
  inForce.programmes = undefined;
  inForce.board = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const reason = (r: Result<unknown>): string => (r.ok ? 'ok' : r.error.reason);

async function facility(programmeId: string, limitMinorUnits: bigint): Promise<void> {
  const p = expectOk(
    await proposeFacility(T, 'stf-credit-01', {
      counterpartyId: RAWABI,
      programmeId,
      limitMinorUnits,
      rationale: 'r r r',
    }),
  );
  advance(1);
  expectOk(await decideFacility(T, 'stf-senior-01', { approvalId: p.approvalId, approve: true, note: '' }));
}

let serial = 0;
async function opened(): Promise<Result<{ readonly transactionRef: string; readonly cost: bigint }>> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: PRG.programmeId,
      counterpartyId: RAWABI,
      channel: 'MAKER_CHECKER',
      invoiceUuid: `9e480000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W5B-${String(serial)}`,
      issuerCr: PRG.anchor.registrationNo,
      recipientCr: '7001000001',
      amountMinorUnits: 9_800_000n,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  expectOk(approveRequest(keyed.requestId, { principalId: 'stf-senior-02', tenantId: T }));
  advance(1);
  const r = await openTransactionForRequest(T, keyed.requestId, 'stf-senior-02');
  return r.ok
    ? {
        ok: true,
        value: { transactionRef: r.value.transactionRef, cost: r.value.transaction.core.pricing.costAmount.minorUnits },
      }
    : r;
}

const withLimit = (limit: bigint): readonly WaslProgramme[] =>
  FILE.map((p) => (p.programmeId === PRG.programmeId ? { ...p, programmeLimitMinorUnits: limit } : p));

describe('a programme change never strands what the book holds', () => {
  it('a programme with a facility is not removed; one nothing refers to may be', async () => {
    await facility(PRG.programmeId, 10n ** 9n);
    const without = (id: string) => FILE.filter((p) => p.programmeId !== id);
    expect(reason(await checkProgrammesChange(T, without(PRG.programmeId)))).toBe('PROGRAMME_IN_USE');
    expect(reason(await checkProgrammesChange(T, without('prg-0002')))).toBe('ok');
  });

  it('a programme that has traded keeps its anchor; its account may change', async () => {
    await facility(PRG.programmeId, 10n ** 9n);
    expectOk(await opened());
    const otherAnchor = FILE.map((p) =>
      p.programmeId === PRG.programmeId ? { ...p, anchor: { ...p.anchor, registrationNo: '1010000999' } } : p,
    );
    expect(reason(await checkProgrammesChange(T, otherAnchor))).toBe('ANCHOR_IN_USE');
    const newAccount = FILE.map((p) =>
      p.programmeId === PRG.programmeId
        ? { ...p, anchor: { ...p.anchor, settlementIban: 'SA0280000000000000000202' } }
        : p,
    );
    expect(reason(await checkProgrammesChange(T, newAccount))).toBe('ok');
  });

  it('a limit is never set below what the programme holds, nor below a facility in it', async () => {
    await facility(PRG.programmeId, 10n ** 9n);
    const o = expectOk(await opened());
    expectOk(await validateAndReserve(T, o.transactionRef, MAKER));
    expect(reason(await checkProgrammesChange(T, withLimit(o.cost - 1n)))).toBe('PROGRAMME_LIMIT_BELOW_EXPOSURE');
    expect(reason(await checkProgrammesChange(T, withLimit(10n ** 9n - 1n)))).toBe('PROGRAMME_LIMIT_BELOW_FACILITY');
    expect(reason(await checkProgrammesChange(T, withLimit(10n ** 9n)))).toBe('ok');
  });
});

describe('every Wasl step reads the configuration in force', () => {
  it('trade validation holds against the programme as revised', async () => {
    await facility(PRG.programmeId, 10n ** 9n);
    const o = expectOk(await opened());
    inForce.programmes = withLimit(o.cost - 1n);
    expect(reason(await validateAndReserve(T, o.transactionRef, MAKER))).toBe('PROGRAMME_LIMIT_EXCEEDED');
    inForce.programmes = undefined;
    expectOk(await validateAndReserve(T, o.transactionRef, MAKER));
  });

  it('opening screens the invoice against the goods register as revised', async () => {
    const board = expectOk(loadBoardPositions(T));
    inForce.board = expectOk(
      boardWithGoodsChange(board, { action: 'ADD', code: '7216', description: 'Test heading' }),
    ).parsed;
    expect(reason(await opened())).toBe('GOODS_EXCLUDED');
    inForce.board = undefined;
    expectOk(await opened());
  });

  it('a facility is approved only within its programme as it stands at approval', async () => {
    const p = expectOk(
      await proposeFacility(T, 'stf-credit-01', {
        counterpartyId: RAWABI,
        programmeId: PRG.programmeId,
        limitMinorUnits: 10n ** 9n,
        rationale: 'r r r',
      }),
    );
    inForce.programmes = withLimit(10n ** 9n - 1n);
    expect(
      reason(await decideFacility(T, 'stf-senior-01', { approvalId: p.approvalId, approve: true, note: '' })),
    ).toBe('FACILITY_ABOVE_PROGRAMME');
  });
});

describe('Admin builds the whole configuration from one edit, read by the production parser', () => {
  const change = {
    action: 'SAVE' as const,
    programmeId: 'prg-0003',
    nameEn: 'Test programme',
    nameAr: 'برنامج اختبار',
    limitRiyals: '1,000,000',
    anchorRegistrationNo: '1010000555',
    anchorNameEn: 'Test anchor',
    anchorNameAr: 'جهة راعية للاختبار',
    anchorSettlementIban: 'SA13 8000 0000 0000 0000 0101',
  };

  it('adds, changes and removes a programme, in whole riyals', () => {
    const added = expectOk(programmesWithChange(FILE, change)).parsed;
    expect(added.map((p) => p.programmeId)).toEqual([...FILE.map((p) => p.programmeId), 'prg-0003']);
    expect(added.at(-1)).toMatchObject({
      programmeLimitMinorUnits: 100_000_000n,
      anchor: { settlementIban: 'SA1380000000000000000101' },
    });
    const changed = expectOk(programmesWithChange(added, { ...change, limitRiyals: '2000000' })).parsed;
    expect(changed.at(-1)?.programmeLimitMinorUnits).toBe(200_000_000n);
    expect(expectOk(programmesWithChange(changed, { ...change, action: 'REMOVE' })).parsed).toEqual(FILE);
  });

  it('refuses a programme list half-read', () => {
    for (const [c, why] of [
      [{ ...change, programmeId: 'P3' }, 'PROGRAMME_ID_MALFORMED'],
      [{ ...change, limitRiyals: 'ten' }, 'PROGRAMME_LIMIT_MALFORMED'],
      [{ ...change, anchorSettlementIban: 'SA00' }, 'WASL_PROGRAMMES_INVALID'],
      [{ ...change, anchorRegistrationNo: '123' }, 'WASL_PROGRAMMES_INVALID'],
      [{ ...change, nameEn: ' ' }, 'WASL_PROGRAMMES_INVALID'],
      // The same anchor, named differently in another programme.
      [{ ...change, anchorRegistrationNo: PRG.anchor.registrationNo }, 'WASL_PROGRAMMES_INVALID'],
      [{ ...change, action: 'REMOVE' as const, programmeId: 'prg-0099' }, 'PROGRAMME_NOT_FOUND'],
    ] as const)
      expect(reason(programmesWithChange(FILE, c)), why).toBe(why);
    expect(reason(parseWaslProgrammes([]))).toBe('WASL_PROGRAMMES_INVALID');
    expect(reason(parseWaslProgrammes([...waslProgrammesToJson(FILE), waslProgrammesToJson(FILE)[0]]))).toBe(
      'WASL_PROGRAMMES_INVALID',
    );
    expect(expectOk(parseWaslProgrammes(waslProgrammesToJson(FILE)))).toEqual(FILE);
  });

  it('changes one heading on the register and carries every other board position, the late-amount ruling included', () => {
    const board = expectOk(loadBoardPositions(T));
    expect(expectOk(parseBoardPositions(boardPositionsToJson(board)))).toEqual(board);
    const added = expectOk(
      boardWithGoodsChange(board, { action: 'ADD', code: '930200', description: 'Revolvers and pistols' }),
    ).parsed;
    expect(added.excludedGoods.at(-1)).toEqual({ code: '930200', description: 'Revolvers and pistols' });
    expect({ ...added, excludedGoods: board.excludedGoods }).toEqual(board);
    const removed = expectOk(boardWithGoodsChange(added, { action: 'REMOVE', code: '930200', description: '' })).parsed;
    expect(removed).toEqual(board);
    for (const [c, why] of [
      [{ action: 'ADD' as const, code: '72', description: 'x x x' }, 'GOODS_CODE_MALFORMED'],
      [{ action: 'ADD' as const, code: '2204', description: 'Wine' }, 'GOODS_ALREADY_EXCLUDED'],
      [{ action: 'ADD' as const, code: '7216', description: '' }, 'GOODS_DESCRIPTION_REQUIRED'],
      [{ action: 'REMOVE' as const, code: '7216', description: '' }, 'GOODS_NOT_EXCLUDED'],
    ] as const)
      expect(reason(boardWithGoodsChange(board, c)), why).toBe(why);
  });
});
