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
 * - a leg is rendered only against an approved template version (SH-17);
 * - a late amount is proposed, billed and given to charity only on the basis,
 *   after the grace and to the recipients the board ruled (SH-13), and not at
 *   all where it has ruled none.
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

/** A charity the board approved to receive late amounts. Its account is where a disbursement is paid. */
export interface ApprovedRecipient {
  readonly recipientId: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly iban: string;
}

/**
 * The board's ruling on late amounts (SH-13, SH-14): a fixed amount per
 * instalment left unpaid beyond the grace days, held for charity and never the
 * institution's income, and the recipients it may be given to. A fixed amount
 * on purpose: the board rules the amount, not a proportion of the debt.
 */
export interface LateAmountPositions {
  /** Names the ruling an amount was computed under; recorded on every charity entry. */
  readonly computationBasisKey: string;
  /** Whole days after the due date before an unpaid instalment attracts a late amount. */
  readonly graceDays: number;
  readonly amountPerInstalmentMinorUnits: bigint;
  readonly approvedRecipients: readonly ApprovedRecipient[];
}

export interface BoardPositions {
  readonly shariahApprovalRef: string;
  /** The shortest risk-holding interval the board accepts, in seconds. A structure may require longer, never shorter. */
  readonly minimumRiskPeriodSeconds: number;
  /** Goods classification codes the board excludes. */
  readonly excludedGoods: readonly ExcludedGoods[];
  readonly approvedTemplates: readonly ApprovedTemplate[];
  /** Absent where the board has ruled no late amounts: none is ever proposed. */
  readonly lateAmounts?: LateAmountPositions;
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
  const { shariahApprovalRef, minimumRiskPeriodSeconds, excludedGoods, approvedTemplates, lateAmounts } = input;
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
  const late = lateAmounts === undefined ? undefined : parseLateAmounts(lateAmounts);
  if (late === null) return bad('BOARD_LATE_AMOUNTS_INVALID');
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
    ...(late === undefined ? {} : { lateAmounts: late }),
  });
}

/**
 * The positions as configuration JSON: what a BOARD_POSITIONS revision carries and `parseBoardPositions` reads back
 * unchanged. A revision that changes the goods register carries every other position as it stood.
 */
export function boardPositionsToJson(b: BoardPositions): Record<string, unknown> {
  return {
    shariahApprovalRef: b.shariahApprovalRef,
    minimumRiskPeriodSeconds: b.minimumRiskPeriodSeconds,
    excludedGoods: b.excludedGoods.map((g) => ({ ...g })),
    approvedTemplates: b.approvedTemplates.map((t) => ({ ...t })),
    ...(b.lateAmounts === undefined
      ? {}
      : {
          lateAmounts: {
            computationBasisKey: b.lateAmounts.computationBasisKey,
            graceDays: b.lateAmounts.graceDays,
            amountPerInstalmentMinorUnits: b.lateAmounts.amountPerInstalmentMinorUnits.toString(),
            approvedRecipients: b.lateAmounts.approvedRecipients.map((r) => ({ ...r })),
          },
        }),
  };
}

const SAUDI_IBAN = /^SA\d{22}$/;

/** The late-amount ruling, or null where any part of it is malformed: a ruling half-read is not applied. */
function parseLateAmounts(input: unknown): LateAmountPositions | null {
  if (!isRecord(input)) return null;
  const { computationBasisKey, graceDays, amountPerInstalmentMinorUnits, approvedRecipients } = input;
  if (!text(computationBasisKey)) return null;
  if (typeof graceDays !== 'number' || !Number.isInteger(graceDays) || graceDays < 0 || graceDays > 90) return null;
  if (typeof amountPerInstalmentMinorUnits !== 'string' || !/^[1-9]\d{0,11}$/.test(amountPerInstalmentMinorUnits))
    return null;
  if (
    !Array.isArray(approvedRecipients) ||
    !approvedRecipients.every(
      (r) =>
        isRecord(r) &&
        text(r['recipientId']) &&
        text(r['nameAr']) &&
        text(r['nameEn']) &&
        typeof r['iban'] === 'string' &&
        SAUDI_IBAN.test(r['iban']),
    )
  )
    return null;
  const ids = approvedRecipients.map((r) => String((r as Record<string, unknown>)['recipientId']));
  if (new Set(ids).size !== ids.length) return null;
  return {
    computationBasisKey,
    graceDays,
    amountPerInstalmentMinorUnits: BigInt(amountPerInstalmentMinorUnits),
    approvedRecipients: approvedRecipients.map((r) => {
      const x = r as Record<string, unknown>;
      return {
        recipientId: String(x['recipientId']),
        nameAr: String(x['nameAr']),
        nameEn: String(x['nameEn']),
        iban: String(x['iban']),
      };
    }),
  };
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
