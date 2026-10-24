/**
 * The Programmes and Goods register areas (Wasl W5b). Each change is the
 * area's whole configuration with one edit applied, parsed by the production
 * parser before it may be proposed, and in force only when a different
 * administrator approves it.
 *
 *   - Programmes: add, change or remove one programme — its names, its limit,
 *     and its anchor with the account the institution pays the anchor at. A
 *     change is also checked against what the book and the facilities hold
 *     (programme-changes.ts), here and again at approval.
 *   - Goods register: add or remove one heading on the board's excluded-goods
 *     register. Every other board position is carried as it stood.
 *
 * Amounts are entered in riyals and converted in whole numbers.
 */

import { type WaslProgramme, parseWaslProgrammes, waslProgrammesToJson } from '@sanad/config/loader.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import {
  type BoardPositions,
  boardPositionsToJson,
  parseBoardPositions,
} from '@sanad/products/murabaha-scf/structures/board-positions.ts';

export { resolveBoard, resolveProgrammes } from '@sanad/origination/wasl/configuration.ts';
export { checkProgrammesChange } from '@sanad/origination/wasl/programme-changes.ts';

export interface ProgrammeChange {
  readonly action: 'SAVE' | 'REMOVE';
  readonly programmeId: string;
  readonly nameEn: string;
  readonly nameAr: string;
  /** Whole riyals. */
  readonly limitRiyals: string;
  readonly anchorRegistrationNo: string;
  readonly anchorNameEn: string;
  readonly anchorNameAr: string;
  readonly anchorSettlementIban: string;
}

/** The programmes with one programme added, changed or removed, as a revision payload and as parsed. */
export function programmesWithChange(
  current: readonly WaslProgramme[],
  change: ProgrammeChange,
): Result<{ readonly payload: unknown; readonly parsed: readonly WaslProgramme[] }> {
  const id = change.programmeId.trim();
  if (!/^prg-\d{4}$/.test(id))
    return reject('OP-DETERMINACY', 'PROGRAMME_ID_MALFORMED', 'A programme id is prg- and four digits');
  const json = waslProgrammesToJson(current) as Record<string, unknown>[];
  let next: Record<string, unknown>[];
  if (change.action === 'REMOVE') {
    if (!json.some((p) => p['programmeId'] === id))
      return reject('OP-DETERMINACY', 'PROGRAMME_NOT_FOUND', 'There is no such programme to remove');
    next = json.filter((p) => p['programmeId'] !== id);
  } else {
    const riyals = change.limitRiyals.replace(/[^\d]/g, '');
    if (!/^\d{1,13}$/.test(riyals))
      return reject('OP-DETERMINACY', 'PROGRAMME_LIMIT_MALFORMED', 'The limit is a whole number of riyals');
    const entry = {
      programmeId: id,
      nameEn: change.nameEn.trim(),
      nameAr: change.nameAr.trim(),
      structureCode: 'MURABAHA',
      programmeLimitMinorUnits: (BigInt(riyals) * 100n).toString(),
      anchor: {
        registrationNo: change.anchorRegistrationNo.trim(),
        nameEn: change.anchorNameEn.trim(),
        nameAr: change.anchorNameAr.trim(),
        settlementIban: change.anchorSettlementIban.replace(/\s+/g, '').toUpperCase(),
      },
    };
    next = json.some((p) => p['programmeId'] === id)
      ? json.map((p) => (p['programmeId'] === id ? entry : p))
      : [...json, entry];
  }
  const parsed = parseWaslProgrammes(next);
  if (!parsed.ok) return parsed;
  return ok({ payload: next, parsed: parsed.value });
}

/** An HS heading (four digits) or subheading (six). */
const HS_CODE = /^\d{4}(\d{2})?$/;

/** The board's positions with one heading added to, or removed from, the excluded-goods register. */
export function boardWithGoodsChange(
  current: BoardPositions,
  change: { readonly action: 'ADD' | 'REMOVE'; readonly code: string; readonly description: string },
): Result<{ readonly payload: unknown; readonly parsed: BoardPositions }> {
  const code = change.code.trim();
  if (!HS_CODE.test(code))
    return reject('OP-DETERMINACY', 'GOODS_CODE_MALFORMED', 'A goods code is an HS heading of four or six digits');
  const json = boardPositionsToJson(current) as { excludedGoods: { code: string; description: string }[] };
  const listed = json.excludedGoods.some((g) => g.code === code);
  if (change.action === 'ADD') {
    if (listed) return reject('OP-DETERMINACY', 'GOODS_ALREADY_EXCLUDED', 'This heading is already on the register');
    if (change.description.trim().length < 3)
      return reject('OP-DETERMINACY', 'GOODS_DESCRIPTION_REQUIRED', 'Describe the goods the heading covers');
  } else if (!listed) return reject('OP-DETERMINACY', 'GOODS_NOT_EXCLUDED', 'This heading is not on the register');
  const excludedGoods =
    change.action === 'ADD'
      ? [...json.excludedGoods, { code, description: change.description.trim().slice(0, 200) }]
      : json.excludedGoods.filter((g) => g.code !== code);
  const payload = { ...json, excludedGoods };
  const parsed = parseBoardPositions(payload);
  if (!parsed.ok) return parsed;
  return ok({ payload, parsed: parsed.value });
}
