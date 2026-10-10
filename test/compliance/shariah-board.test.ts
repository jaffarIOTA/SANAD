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

import { buildLegRenderRequest } from '../../products/murabaha-scf/documents/render.ts';
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
