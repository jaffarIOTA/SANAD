/**
 * The tenant's term sheet for conventional SME term finance. Strict: an
 * unknown key, a limit without its policy reference, or a guarantee without
 * its programme reference does not parse.
 */

import { parseBusinessCreditRule } from '../../core/decisioning/business-affordability.js';
import { parseGuarantee } from '../../core/decisioning/guarantee.js';
import { money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';











const KEYS = new Set(['minMonths', 'maxMonths', 'minAmountMinorUnits', 'maxAmountMinorUnits', 'adminFeeMinorUnits', 'credit', 'guarantee']);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isIntString = (v) => typeof v === 'string' && /^\d+$/.test(v);
const bad = (reason, detail) => reject('OP-DETERMINACY', reason, detail);

export function parseSmeConventionalTerms(raw) {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'SME term finance terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in SME term finance terms', { keys: unknown.join(',') });
  if (!isPosInt(raw['minMonths']) || !isPosInt(raw['maxMonths']) || raw['minMonths'] > raw['maxMonths']) return bad('TERMS_MONTHS', 'minMonths ≤ maxMonths, both positive integers');
  if (!isIntString(raw['minAmountMinorUnits']) || !isIntString(raw['maxAmountMinorUnits'])) return bad('TERMS_AMOUNTS', 'minAmountMinorUnits and maxAmountMinorUnits are integer strings');
  if (BigInt(raw['minAmountMinorUnits']) <= 0n || BigInt(raw['minAmountMinorUnits']) > BigInt(raw['maxAmountMinorUnits'])) return bad('TERMS_AMOUNT_RANGE', '0 < minimum ≤ maximum');
  if (raw['adminFeeMinorUnits'] !== undefined && !isIntString(raw['adminFeeMinorUnits'])) return bad('TERMS_FEE', 'adminFeeMinorUnits is an integer string');
  const credit = parseBusinessCreditRule(raw['credit'], (s) => money(BigInt(s)));
  if (!credit.ok) return credit;
  const guarantee = parseGuarantee(raw['guarantee']);
  if (!guarantee.ok) return guarantee;
  return ok({
    minMonths: raw['minMonths'], maxMonths: raw['maxMonths'],
    minAmount: money(BigInt(raw['minAmountMinorUnits'])), maxAmount: money(BigInt(raw['maxAmountMinorUnits'])),
    adminFee: money(raw['adminFeeMinorUnits'] === undefined ? 0n : BigInt(raw['adminFeeMinorUnits'])),
    credit: credit.value,
    ...(guarantee.value === undefined ? {} : { guarantee: guarantee.value }),
  });
}
