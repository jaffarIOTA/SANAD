/**
 * The Shariah board's standing positions for one institution (SR-025).
 *
 * What the board ruled, held as configuration and changed only through a
 * maker-checker revision (area BOARD_POSITIONS): the approval it ruled under,
 * the shortest risk-holding interval it accepts, the goods it excludes, and the
 * document template versions it approved. The structure definitions and every
 * transaction are checked against it:
 *
 * - a structure under another approval, or with a risk interval below the floor,
 *   is refused (SH-06);
 * - an invoice line whose goods classification is on the register is refused
 *   when the transaction opens (SH-11);
 * - a leg is rendered only against an approved template version (SH-17).
 *
 * The values themselves are the board's. Nothing here decides them.
 */

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

import type { StructureDefinition } from './definition.ts';

export interface ExcludedGoods {
  readonly code: string;
  readonly description: string;
}

export interface ApprovedTemplate {
  /** The document the structure names for a leg (e.g. `murabaha_offer`). */
  readonly document: string;
  readonly templateVersionId: string;
}

export interface BoardPositions {
  readonly shariahApprovalRef: string;
  /** The shortest risk-holding interval the board accepts, in seconds. A structure may require longer, never shorter. */
  readonly minimumRiskPeriodSeconds: number;
  /** Goods classification codes the board excludes. */
  readonly excludedGoods: readonly ExcludedGoods[];
  readonly approvedTemplates: readonly ApprovedTemplate[];
}

export interface InvoiceLineGoods {
  readonly lineNo: number;
  readonly goodsClassificationCode: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function parseBoardPositions(input: unknown): Result<BoardPositions> {
  const bad = (reason: string) => reject('OP-DETERMINACY', reason, 'The board positions do not load', { reason });
  if (!isRecord(input)) return bad('BOARD_POSITIONS_MALFORMED');
  const { shariahApprovalRef, minimumRiskPeriodSeconds, excludedGoods, approvedTemplates } = input;
  if (!text(shariahApprovalRef)) return bad('BOARD_APPROVAL_REF_REQUIRED');
  if (
    typeof minimumRiskPeriodSeconds !== 'number' ||
    !Number.isInteger(minimumRiskPeriodSeconds) ||
    minimumRiskPeriodSeconds < 1
  )
    return bad('BOARD_RISK_FLOOR_INVALID');
  if (
    !Array.isArray(excludedGoods) ||
    !excludedGoods.every((g) => isRecord(g) && text(g['code']) && text(g['description']))
  )
    return bad('BOARD_EXCLUDED_GOODS_INVALID');
  if (
    !Array.isArray(approvedTemplates) ||
    !approvedTemplates.every((t) => isRecord(t) && text(t['document']) && text(t['templateVersionId']))
  )
    return bad('BOARD_TEMPLATES_INVALID');
  return ok({
    shariahApprovalRef,
    minimumRiskPeriodSeconds,
    excludedGoods: excludedGoods.map((g) => ({
      code: String(g['code']).trim(),
      description: String(g['description']),
    })),
    approvedTemplates: approvedTemplates.map((t) => ({
      document: String(t['document']),
      templateVersionId: String(t['templateVersionId']),
    })),
  });
}

/** A structure is in force only under the board's approval and at or above its risk floor. */
export function structureWithinBoard(
  structure: StructureDefinition,
  board: BoardPositions,
): Result<StructureDefinition> {
  if (structure.shariahApprovalRef !== board.shariahApprovalRef)
    return reject(
      'SH-06',
      'STRUCTURE_NOT_UNDER_BOARD_APPROVAL',
      'This structure is not under the approval the board ruled',
      {
        definitionId: structure.definitionId,
      },
    );
  for (const gate of structure.gates)
    if (gate.kind === 'ELAPSE' && gate.minimumSeconds < board.minimumRiskPeriodSeconds)
      return reject(
        'SH-06',
        'RISK_PERIOD_BELOW_BOARD_FLOOR',
        'The risk-holding interval is shorter than the board accepts',
        { gateId: gate.id, minimumSeconds: gate.minimumSeconds, boardFloor: board.minimumRiskPeriodSeconds },
      );
  return ok(structure);
}

/** Every invoice line's goods against the register; the first excluded line refuses the trade. */
export function screenGoods(lines: readonly InvoiceLineGoods[], board: BoardPositions): Result<true> {
  if (lines.length === 0)
    return reject('SH-11', 'GOODS_UNCLASSIFIED', 'The goods must be known before they can be financed');
  const excluded = new Set(board.excludedGoods.map((g) => g.code));
  for (const line of lines) {
    if (line.goodsClassificationCode.trim().length === 0)
      return reject('SH-11', 'GOODS_UNCLASSIFIED', 'Every invoice line carries a goods classification', {
        lineNo: line.lineNo,
      });
    if (excluded.has(line.goodsClassificationCode.trim()))
      return reject('SH-11', 'GOODS_EXCLUDED', 'These goods are excluded by the board and cannot be financed', {
        lineNo: line.lineNo,
        goodsClassificationCode: line.goodsClassificationCode,
      });
  }
  return ok(true);
}

/** A template version the board approved for this document. */
export function templateApproved(board: BoardPositions, templateVersionId: string, document?: string): boolean {
  return board.approvedTemplates.some(
    (t) => t.templateVersionId === templateVersionId && (document === undefined || t.document === document),
  );
}
