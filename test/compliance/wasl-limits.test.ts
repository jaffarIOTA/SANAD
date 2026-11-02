/**
 * Wasl W5a — facilities, limits and concentration. Each case attempts to draw
 * beyond what the institution allowed, and passes only when nothing is held:
 *
 *   - a trade for a distributor with no approved facility;
 *   - a facility approved on one person's word, rejected without a reason,
 *     larger than its programme, or proposed twice at once;
 *   - a cost beyond the facility, beyond the programme, or beyond any
 *     concentration rule the institution has chosen — and only the rules it
 *     has chosen: a rule it has not enabled refuses nothing;
 *   - capacity stranded by a trade that was unwound, or never repaid by one
 *     that settled;
 *   - a concentration policy half-read.
 *
 * The book is in memory (bank-a); the concentration policy is the checked-in
 * file unless a case replaces it, as an approved Admin revision would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import {
  type ConcentrationPolicy,
  NO_CONCENTRATION_RULES,
  checkDrawdown,
  concentrationPolicyToJson,
  parseConcentrationPolicy,
} from '@sanad/products/murabaha-scf/limits/drawdown-limits.ts';

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
import { percentOf, perTenThousand, policyFromForm } from '../../apps/admin/src/server/concentration.ts';
import { approveRequest, keyRequest, submit } from '../../apps/ops/src/server/store.ts';
import {
  decideFacility,
  facilityApprovals,
  facilityFor,
  proposeFacility,
  resetFacilities,
} from '../../services/origination/src/wasl/facilities.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import { recordTestApprovals } from '../support/shariah-approvals.ts';
import { limitMovement } from '../../services/origination/src/wasl/steps.ts';

vi.mock('../../apps/ops/src/server/invoices.ts', async (original) => {
  const actual = await original<typeof import('../../apps/ops/src/server/invoices.ts')>();
  return {
    ...actual,
    invoiceGoodsLines: (uuid: string) =>
      uuid.startsWith('9e470000-') ? [{ lineNo: 1, goodsClassificationCode: '7216' }] : actual.invoiceGoodsLines(uuid),
  };
});

// The concentration policy in force, replaceable per case as an approved Admin revision would replace it.
const policy = vi.hoisted(() => ({ override: undefined as unknown }));
vi.mock('@sanad/config/loader.ts', async (original) => {
  const actual = await original<typeof import('@sanad/config/loader.ts')>();
  return {
    ...actual,
    loadWaslConcentration: (tenant: Parameters<typeof actual.loadWaslConcentration>[0]) =>
      policy.override === undefined
        ? actual.loadWaslConcentration(tenant)
        : { ok: true, value: policy.override as ConcentrationPolicy },
  };
});

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CREDIT = 'stf-credit-01';
const APPROVER = 'stf-senior-01';
const RAWABI = 'Rawabi Industrial Supplies Establishment';
const PRG = 'prg-0001';

let clock = Date.UTC(2026, 9, 22, 9, 0, 0);
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
  policy.override = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const reason = (r: Result<unknown>): string => (r.ok ? 'ok' : `${r.error.control} ${r.error.reason}`);

/** A facility for Rawabi in the programme, proposed by credit and approved by a different person. */
async function facility(limitMinorUnits: bigint): Promise<void> {
  const p = expectOk(
    await proposeFacility(T, CREDIT, {
      counterpartyId: RAWABI,
      programmeId: PRG,
      limitMinorUnits,
      rationale: 'Two years of trading with the anchor, no arrears',
    }),
  );
  advance(60);
  expectOk(await decideFacility(T, APPROVER, { approvalId: p.approvalId, approve: true, note: '' }));
}

let serial = 0;
/** A fresh Rawabi request for `amountMinorUnits`, approved and opened: the transaction in DRAFT. */
async function opened(amountMinorUnits = 9_800_000n): Promise<TransactionView> {
  serial += 1;
  const keyed = expectOk(
    keyRequest({
      tenantId: T,
      programmeId: PRG,
      counterpartyId: RAWABI,
      channel: 'MAKER_CHECKER',
      invoiceUuid: `9e470000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
      invoiceNumber: `W5A-${String(serial)}`,
      issuerCr: '1010000002',
      recipientCr: '7001000001',
      amountMinorUnits,
      tenorDays: 60,
      maker: { principalId: 'stf-maker-02', tenantId: T },
    }),
  );
  expectOk(submit(keyed.requestId));
  // The committee approves any size of request, so a large trade reaches the limits rather than the approval tiers.
  expectOk(
    approveRequest(keyed.requestId, { principalId: 'stf-committee-01', tenantId: T, authority: 'CREDIT_COMMITTEE' }),
  );
  advance(1);
  return expectOk(await openTransactionForRequest(T, keyed.requestId, 'stf-senior-02'));
}

const costOf = (v: TransactionView) => v.transaction.core.pricing.costAmount.minorUnits;
const stateOf = async (ref: string) => (await getTransaction(T, ref))?.transaction.state;

describe('no facility, no trade', () => {
  it('a distributor with no approved facility draws nothing, and the transaction stays in DRAFT', async () => {
    const v = await opened();
    expect(reason(await validateAndReserve(T, v.transactionRef, MAKER))).toBe('OP-LIMIT NO_FACILITY');
    expect(await stateOf(v.transactionRef)).toBe('DRAFT');
  });

  it('a proposed facility is not a facility until a second person approves it', async () => {
    const v = await opened();
    expectOk(
      await proposeFacility(T, CREDIT, {
        counterpartyId: RAWABI,
        programmeId: PRG,
        limitMinorUnits: 10n ** 9n,
        rationale: 'r r r',
      }),
    );
    expect(reason(await validateAndReserve(T, v.transactionRef, MAKER))).toBe('OP-LIMIT NO_FACILITY');
  });
});

describe('a facility takes two people', () => {
  it('the proposer cannot approve their own proposal; a rejection says why; a second proposal waits', async () => {
    const p = expectOk(
      await proposeFacility(T, CREDIT, {
        counterpartyId: RAWABI,
        programmeId: PRG,
        limitMinorUnits: 10n ** 9n,
        rationale: 'r r r',
      }),
    );
    expect(reason(await decideFacility(T, CREDIT, { approvalId: p.approvalId, approve: true, note: '' }))).toBe(
      'OP-DETERMINACY FOUR_EYES_SELF_APPROVAL',
    );
    expect(reason(await decideFacility(T, APPROVER, { approvalId: p.approvalId, approve: false, note: '' }))).toBe(
      'OP-DETERMINACY REJECTION_REASON_REQUIRED',
    );
    expect(
      reason(
        await proposeFacility(T, 'stf-credit-02', {
          counterpartyId: RAWABI,
          programmeId: PRG,
          limitMinorUnits: 10n ** 8n,
          rationale: 'another',
        }),
      ),
    ).toBe('OP-DETERMINACY FACILITY_PROPOSAL_OPEN');
    expect(await facilityFor(T, RAWABI, PRG)).toBeUndefined();
    const rejected = expectOk(
      await decideFacility(T, APPROVER, { approvalId: p.approvalId, approve: false, note: 'Accounts are stale' }),
    );
    expect(rejected).toMatchObject({ state: 'REJECTED', decidedBy: APPROVER, decisionNote: 'Accounts are stale' });
    expect(
      reason(await decideFacility(T, 'stf-senior-02', { approvalId: p.approvalId, approve: true, note: '' })),
    ).toBe('OP-DETERMINACY FACILITY_ALREADY_DECIDED');
  });

  it('a facility is never larger than its programme, never zero, and always says what it rests on', async () => {
    for (const [limitMinorUnits, rationale, why] of [
      [5_000_000_001n, 'r r r', 'OP-LIMIT FACILITY_ABOVE_PROGRAMME'],
      [0n, 'r r r', 'OP-DETERMINACY FACILITY_LIMIT_NOT_POSITIVE'],
      [10n ** 9n, ' ', 'OP-DETERMINACY FACILITY_RATIONALE_REQUIRED'],
    ] as const)
      expect(
        reason(
          await proposeFacility(T, CREDIT, { counterpartyId: RAWABI, programmeId: PRG, limitMinorUnits, rationale }),
        ),
      ).toBe(why);
    expect(await facilityApprovals(T)).toEqual([]);
  });

  it('a later approval supersedes the earlier, and is never set below what is already held', async () => {
    await facility(10n ** 9n);
    const v = await opened();
    expectOk(await validateAndReserve(T, v.transactionRef, MAKER));
    const lower = expectOk(
      await proposeFacility(T, CREDIT, {
        counterpartyId: RAWABI,
        programmeId: PRG,
        limitMinorUnits: costOf(v) - 1n,
        rationale: 'cut',
      }),
    );
    advance(60);
    expect(reason(await decideFacility(T, APPROVER, { approvalId: lower.approvalId, approve: true, note: '' }))).toBe(
      'OP-LIMIT FACILITY_BELOW_EXPOSURE',
    );
    expect((await facilityFor(T, RAWABI, PRG))?.limit.minorUnits).toBe(10n ** 9n);
  });
});

describe('the cost fits the facility and the programme', () => {
  it('beyond the facility nothing is held; within it, the hold names the facility', async () => {
    const v = await opened();
    await facility(costOf(v) - 1n);
    expect(reason(await validateAndReserve(T, v.transactionRef, MAKER))).toBe('OP-LIMIT FACILITY_LIMIT_EXCEEDED');
    expect(await stateOf(v.transactionRef)).toBe('DRAFT');
  });

  it('a hold counts until it is released: an unwound trade frees the facility; a held one does not', async () => {
    const first = await opened();
    await facility(costOf(first) + costOf(first) / 2n);
    const held = expectOk(await validateAndReserve(T, first.transactionRef, MAKER));
    expect(held.events.at(-1)?.detail).toMatchObject({
      heldAgainst: 'FACILITY',
      amountMinor: costOf(first).toString(),
    });
    const second = await opened();
    expect(reason(await validateAndReserve(T, second.transactionRef, MAKER))).toBe('OP-LIMIT FACILITY_LIMIT_EXCEEDED');
    advance(1);
    expectOk(await executeWaad(T, first.transactionRef, MAKER));
    advance(1);
    expectOk(await executePurchase(T, first.transactionRef, MAKER));
    // Bought: still counted.
    expect(reason(await validateAndReserve(T, second.transactionRef, MAKER))).toBe('OP-LIMIT FACILITY_LIMIT_EXCEEDED');
    advance(1);
    expectOk(await unwindTransaction(T, first.transactionRef, 'stf-checker-01', 'Goods returned to the anchor'));
    expect(expectOk(await validateAndReserve(T, second.transactionRef, MAKER)).transaction.state).toBe(
      'LIMIT_RESERVED',
    );
  });

  it('the database moves the facility as the transaction moves: hold, consume, release, repay', () => {
    expect(limitMovement('TRADE_VALIDATION', 'LIMIT_RESERVED')).toBe('HOLD');
    expect(limitMovement('DRAFT', 'LIMIT_RESERVED')).toBe('HOLD');
    expect(limitMovement('WAAD_EXECUTED', 'PURCHASE_EXECUTED')).toBe('CONSUME');
    expect(limitMovement('WAAD_EXECUTED', 'UNWIND')).toBe('RELEASE');
    expect(limitMovement('OFFER_LAPSED', 'UNWIND')).toBe('REPAY');
    expect(limitMovement('ACTIVE', 'SETTLED')).toBe('REPAY');
    expect(limitMovement('ACTIVE', 'ACTIVE')).toBeUndefined();
    expect(limitMovement('SALE_OFFERED', 'EXECUTED')).toBeUndefined();
  });
});

describe('concentration: only the rules the institution chose', () => {
  const rules = (over: Partial<ConcentrationPolicy>): ConcentrationPolicy => ({
    ...NO_CONCENTRATION_RULES,
    policyRef: 'test-policy',
    ...over,
  });

  it('the single-trade cap refuses a trade above it (bank-a’s file: SAR 5 million)', async () => {
    await facility(10n ** 9n);
    const v = await opened(600_000_000n);
    expect(reason(await validateAndReserve(T, v.transactionRef, MAKER))).toBe(
      'OP-LIMIT CONCENTRATION_SINGLE_TRADE_CAP',
    );
    // Not chosen, it refuses nothing.
    policy.override = rules({});
    expect(expectOk(await validateAndReserve(T, v.transactionRef, MAKER)).transaction.state).toBe('LIMIT_RESERVED');
  });

  it('a distributor’s share of its programme, when chosen', async () => {
    await facility(10n ** 9n);
    const v = await opened();
    // One ten-thousandth of SAR 50 million is SAR 5,000: less than this trade.
    policy.override = rules({ distributorShareOfProgramme: { enabled: true, maxSharePerTenThousand: 1 } });
    expect(reason(await validateAndReserve(T, v.transactionRef, MAKER))).toBe(
      'OP-LIMIT CONCENTRATION_DISTRIBUTOR_SHARE',
    );
    policy.override = rules({ distributorShareOfProgramme: { enabled: false, maxSharePerTenThousand: 1 } });
    expectOk(await validateAndReserve(T, v.transactionRef, MAKER));
  });

  it('an anchor’s share of the book, when chosen — measured against limits, so an empty book is judged the same', async () => {
    await facility(10n ** 9n);
    const v = await opened();
    policy.override = rules({ anchorShareOfBook: { enabled: true, maxSharePerTenThousand: 1 } });
    expect(reason(await validateAndReserve(T, v.transactionRef, MAKER))).toBe('OP-LIMIT CONCENTRATION_ANCHOR_SHARE');
    // Two-thirds of the book (SAR 75 million) is room enough for the first trade in an empty book.
    policy.override = rules({ anchorShareOfBook: { enabled: true, maxSharePerTenThousand: 6600 } });
    expectOk(await validateAndReserve(T, v.transactionRef, MAKER));
  });

  it('the limits are checked in order: facility, programme, then the chosen rules', () => {
    const e = {
      cost: 100n,
      facilityLimit: 1_000n,
      facilityHeld: 0n,
      programmeLimit: 10_000n,
      programmeHeld: 0n,
      anchorHeld: 0n,
      bookLimit: 20_000n,
    };
    const all = rules({
      singleTradeCap: { enabled: true, maxCostMinorUnits: 50n },
      distributorShareOfProgramme: { enabled: true, maxSharePerTenThousand: 1 },
      anchorShareOfBook: { enabled: true, maxSharePerTenThousand: 1 },
    });
    const why = (x: Result<true>) => (x.ok ? 'ok' : x.error.reason);
    expect(why(checkDrawdown({ ...e, facilityLimit: undefined }, all))).toBe('NO_FACILITY');
    expect(why(checkDrawdown({ ...e, facilityHeld: 950n }, all))).toBe('FACILITY_LIMIT_EXCEEDED');
    expect(why(checkDrawdown({ ...e, programmeHeld: 9_950n }, all))).toBe('PROGRAMME_LIMIT_EXCEEDED');
    expect(why(checkDrawdown(e, all))).toBe('CONCENTRATION_SINGLE_TRADE_CAP');
    // Exactly at a share is within it.
    expect(
      why(checkDrawdown(e, rules({ distributorShareOfProgramme: { enabled: true, maxSharePerTenThousand: 100 } }))),
    ).toBe('ok');
    expect(why(checkDrawdown(e, NO_CONCENTRATION_RULES))).toBe('ok');
  });

  it('a policy half-read is refused, and a whole one reads back as it was written', () => {
    const whole = rules({ singleTradeCap: { enabled: true, maxCostMinorUnits: 500n } });
    expect(expectOk(parseConcentrationPolicy(concentrationPolicyToJson(whole)))).toEqual(whole);
    const json = concentrationPolicyToJson(whole);
    for (const bad of [
      { ...json, policyRef: '' },
      { ...json, singleTradeCap: { enabled: true, maxCostMinorUnits: '0' } },
      { ...json, singleTradeCap: { enabled: true, maxCostMinorUnits: 500 } },
      { ...json, distributorShareOfProgramme: { enabled: true, maxSharePerTenThousand: 0 } },
      { ...json, distributorShareOfProgramme: { enabled: true, maxSharePerTenThousand: 10_001 } },
      { ...json, anchorShareOfBook: { enabled: true, maxSharePerTenThousand: 25.5 } },
      { ...json, anchorShareOfBook: undefined },
    ])
      expect(parseConcentrationPolicy(bad).ok).toBe(false);
  });
});

describe('Admin → Concentration reads the form in whole numbers', () => {
  const form = {
    policyRef: 'bank-a-2026-11',
    tradeCapEnabled: true,
    tradeCapRiyals: '5,000,000',
    distributorShareEnabled: true,
    distributorSharePercent: '12.5',
    anchorShareEnabled: false,
    anchorSharePercent: '',
  };

  it('percent to per ten thousand, and riyals to minor units, without floating point', () => {
    expect([perTenThousand('25'), perTenThousand('12.5'), perTenThousand('0.01'), perTenThousand('100')]).toEqual([
      2500, 1250, 1, 10_000,
    ]);
    for (const bad of ['0', '100.01', '12.345', '1e2', '-5', 'ten', ''])
      expect(perTenThousand(bad), bad).toBeUndefined();
    expect([percentOf(2500), percentOf(1250), percentOf(1205), percentOf(1)]).toEqual(['25', '12.5', '12.05', '0.01']);
    const r = expectOk(policyFromForm(form));
    expect(r.parsed).toMatchObject({
      singleTradeCap: { enabled: true, maxCostMinorUnits: 500_000_000n },
      distributorShareOfProgramme: { enabled: true, maxSharePerTenThousand: 1250 },
      anchorShareOfBook: { enabled: false },
    });
  });

  it('a rule that applies needs its value; one that does not may leave it blank', () => {
    expect(reason(policyFromForm({ ...form, tradeCapRiyals: '' }))).toBe('OP-DETERMINACY TRADE_CAP_REQUIRED');
    expect(reason(policyFromForm({ ...form, tradeCapRiyals: '0' }))).toBe(
      'OP-DETERMINACY CONCENTRATION_TRADE_CAP_INVALID',
    );
    expect(reason(policyFromForm({ ...form, distributorSharePercent: '120' }))).toBe(
      'OP-DETERMINACY DISTRIBUTOR_SHARE_MALFORMED',
    );
    expect(policyFromForm({ ...form, tradeCapEnabled: false, tradeCapRiyals: '' }).ok).toBe(true);
  });
});
