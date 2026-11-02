/**
 * SR-025: the board's standing positions bind the structure, the interval, the
 * goods and the documents.
 *
 * Each case attempts what the board did not permit and passes only when it is
 * refused: a structure under another approval or below the board's risk floor
 * (SH-06), goods on the excluded register or unclassified (SH-11), a template
 * version the board did not approve (SH-17). Murabaha execute() under the same
 * rules is in test/unit/product-engine.test.ts. The maker-checker over these
 * parameters is proven against the database in test/contract/shariah-revisions.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { money } from '../../core/kernel/money.ts';
import { buildLegRenderRequest } from '../../products/murabaha-scf/documents/render.ts';
import { lateAmountsDue } from '../../products/murabaha-scf/ledger/late-amounts.ts';
import {
  parseBoardPositions,
  screenGoods,
  structureWithinBoard,
} from '../../products/murabaha-scf/structures/board-positions.ts';
import type { StructureDefinition } from '../../products/murabaha-scf/structures/definition.ts';
import {
  PERMITTED_GOODS,
  TEST_TEMPLATE_VERSION,
  at,
  boardFor,
  chain,
  riskPeriodSecondsFor,
  structureFor,
} from '../support/fixtures.ts';

const board = boardFor('bank-a');
const withInterval = (s: StructureDefinition, seconds: number): StructureDefinition => ({
  ...s,
  gates: s.gates.map((g) => (g.kind === 'ELAPSE' ? { ...g, minimumSeconds: seconds } : g)),
});

describe('the board positions bind (SR-025)', () => {
  it('refuses a structure under another approval', () => {
    const r = structureWithinBoard({ ...structureFor('bank-a'), shariahApprovalRef: 'SSB-OTHER-1' }, board);
    expect(!r.ok && r.error).toMatchObject({ control: 'SH-06', reason: 'STRUCTURE_NOT_UNDER_BOARD_APPROVAL' });
  });

  it('refuses a risk interval below the board floor, and accepts one at or above it', () => {
    const below = structureWithinBoard(withInterval(structureFor('bank-a'), board.minimumRiskPeriodSeconds - 1), board);
    expect(!below.ok && below.error).toMatchObject({ control: 'SH-06', reason: 'RISK_PERIOD_BELOW_BOARD_FLOOR' });
    expect(structureWithinBoard(withInterval(structureFor('bank-a'), board.minimumRiskPeriodSeconds), board).ok).toBe(
      true,
    );
  });

  it("holds each tenant's structures to its own board: fintech-b's longer floor refuses bank-a's interval", () => {
    const fintech = boardFor('fintech-b');
    const r = structureWithinBoard(
      { ...withInterval(structureFor('fintech-b'), riskPeriodSecondsFor('bank-a')) },
      fintech,
    );
    expect(!r.ok && r.error.reason).toBe('RISK_PERIOD_BELOW_BOARD_FLOOR');
  });

  it('refuses goods on the excluded register, and unclassified goods', () => {
    const excluded = screenGoods(
      [
        { lineNo: 1, goodsClassificationCode: '8471' },
        { lineNo: 2, goodsClassificationCode: '2204' },
      ],
      board,
    );
    expect(!excluded.ok && excluded.error).toMatchObject({ control: 'SH-11', reason: 'GOODS_EXCLUDED' });
    expect(!excluded.ok && excluded.error.context?.['lineNo']).toBe(2);
    for (const lines of [[], [{ lineNo: 1, goodsClassificationCode: ' ' }]]) {
      const r = screenGoods(lines, board);
      expect(!r.ok && r.error.reason).toBe('GOODS_UNCLASSIFIED');
    }
    expect(screenGoods(PERMITTED_GOODS, board).ok).toBe(true);
  });

  it('refuses a board configuration that does not load', () => {
    for (const bad of [
      {},
      { ...board, shariahApprovalRef: '' },
      { ...board, minimumRiskPeriodSeconds: 0 },
      { ...board, excludedGoods: [{ code: '2204' }] },
      { ...board, approvedTemplates: [{ document: 'x' }] },
    ])
      expect(parseBoardPositions(bad).ok).toBe(false);
  });
});

describe('the board’s ruling on late amounts binds (SH-13, Wasl W4b-2)', () => {
  const ruling = {
    computationBasisKey: 'SSB-T-1/late',
    graceDays: 5,
    amountPerInstalmentMinorUnits: '50000',
    approvedRecipients: [{ recipientId: 'r1', nameAr: 'أ', nameEn: 'A', iban: 'SA1380000000000000000101' }],
  };
  const { lateAmounts: _ruled, ...unruled } = board;
  const position = (asOf: string, state: 'OVERDUE' | 'PAID', outstanding: bigint) => ({
    asOf,
    instalments: [
      {
        number: 1,
        dueDate: '2026-12-17',
        amount: money(100_000n, 'SAR'),
        paid: money(100_000n - outstanding, 'SAR'),
        paidCharge: money(0n, 'SAR'),
        paidPrincipal: money(100_000n - outstanding, 'SAR'),
        outstanding: money(outstanding, 'SAR'),
        state,
      },
    ],
    arrears: money(outstanding, 'SAR'),
    daysPastDue: 0,
    totalPaid: money(100_000n - outstanding, 'SAR'),
    outstandingPrincipal: money(outstanding, 'SAR'),
    outstandingTotal: money(outstanding, 'SAR'),
    overpaid: money(0n, 'SAR'),
  });

  it('loads a well-formed ruling, and a board without one rules no late amounts', () => {
    const r = parseBoardPositions({ ...unruled, lateAmounts: ruling });
    expect(r.ok && r.value.lateAmounts).toMatchObject({ graceDays: 5, amountPerInstalmentMinorUnits: 50_000n });
    const none = parseBoardPositions(unruled);
    expect(none.ok && none.value.lateAmounts).toBeUndefined();
    expect(lateAmountsDue(position('2027-01-31', 'OVERDUE', 100_000n), undefined, new Set(), 'SAR')).toEqual([]);
  });

  it('refuses a ruling half-read: no basis, a negative or fractional grace, an amount as a number, a bad IBAN, a repeated recipient', () => {
    for (const bad of [
      { ...ruling, computationBasisKey: '' },
      { ...ruling, graceDays: -1 },
      { ...ruling, graceDays: 2.5 },
      { ...ruling, amountPerInstalmentMinorUnits: 500 },
      { ...ruling, amountPerInstalmentMinorUnits: '0' },
      { ...ruling, approvedRecipients: [{ ...ruling.approvedRecipients[0], iban: 'SA00' }] },
      { ...ruling, approvedRecipients: [ruling.approvedRecipients[0], ruling.approvedRecipients[0]] },
    ])
      expect(parseBoardPositions({ ...unruled, lateAmounts: bad }).ok).toBe(false);
  });

  it('is due only beyond the grace, on an instalment still unpaid, once', () => {
    const r = parseBoardPositions({ ...unruled, lateAmounts: ruling });
    const late = r.ok ? r.value.lateAmounts : undefined;
    // Due on the 17th, five days' grace: the 22nd is within it, the 23rd beyond.
    expect(lateAmountsDue(position('2026-12-22', 'OVERDUE', 100_000n), late, new Set(), 'SAR')).toEqual([]);
    expect(lateAmountsDue(position('2026-12-23', 'OVERDUE', 100_000n), late, new Set(), 'SAR')).toEqual([
      expect.objectContaining({ sequenceNumber: 1, daysPastDue: 6, amount: money(50_000n, 'SAR') }),
    ]);
    expect(lateAmountsDue(position('2026-12-23', 'PAID', 0n), late, new Set(), 'SAR')).toEqual([]);
    expect(lateAmountsDue(position('2026-12-23', 'OVERDUE', 100_000n), late, new Set([1]), 'SAR')).toEqual([]);
  });
});

describe('a leg renders only against a template version the board approved (SR-025)', () => {
  const legs = chain([
    {
      legType: 'SALE_OFFER',
      sequenceNo: 1,
      executedAt: at(1_000_000),
      counterpartyRole: 'INSTITUTION',
      counterpartyCr: '7001000001',
    },
  ]);
  const params = (templateVersionId: string) => ({
    requestId: 'req-0001',
    tenantId: 'bank-a',
    templateVersionId,
    translationLocale: 'en-SA' as const,
    mergeFields: {},
    shariahApprovalId: 'SSB-A-2026-014',
    correlationId: 'cor-0001',
    board,
  });

  it('refuses an unapproved version and renders an approved one', () => {
    const refused = buildLegRenderRequest([legs[0]!], params('murabaha_offer@99'));
    expect(!refused.ok && refused.error).toMatchObject({ control: 'SH-17', reason: 'TEMPLATE_VERSION_NOT_APPROVED' });
    expect(buildLegRenderRequest([legs[0]!], params('murabaha_offer@3')).ok).toBe(true);
    expect(buildLegRenderRequest([legs[0]!], params(TEST_TEMPLATE_VERSION)).ok).toBe(true);
  });
});
