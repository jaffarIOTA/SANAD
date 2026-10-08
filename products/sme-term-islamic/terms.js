/**
 * The tenant's term sheet for SME finance by Tawarruq (commodity Murabaha).
 * Strict: an unknown key, a credit limit without its policy reference, or a
 * guarantee without its programme reference does not parse. The structure's
 * permissions (broker, commodity, agency) are the tenant board's, as for
 * personal Tawarruq.
 */

import { parseBusinessCreditRule } from '../../core/decisioning/business-affordability.js';
import { parseGuarantee } from '../../core/decisioning/guarantee.js';
import { money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';
















const KEYS = new Set(['minMonths', 'maxMonths', 'minAmountMinorUnits', 'maxAmountMinorUnits', 'brokerRef', 'commodityCode', 'agencyPermitted', 'adminFeeMinorUnits', 'credit', 'guarantee']);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isIntString = (v) => typeof v === 'string' && /^\d+$/.test(v);
const bad = (reason, detail) => reject('OP-DETERMINACY', reason, detail);

export function parseSmeIslamicTerms(raw) {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'SME Tawarruq terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in SME Tawarruq terms', { keys: unknown.join(',') });
  if (!isPosInt(raw['minMonths']) || !isPosInt(raw['maxMonths']) || raw['minMonths'] > raw['maxMonths']) return bad('TERMS_MONTHS', 'minMonths ≤ maxMonths, both positive integers');
  if (!isIntString(raw['minAmountMinorUnits']) || !isIntString(raw['maxAmountMinorUnits'])) return bad('TERMS_AMOUNTS', 'minAmountMinorUnits and maxAmountMinorUnits are integer strings');
  if (BigInt(raw['minAmountMinorUnits']) <= 0n || BigInt(raw['minAmountMinorUnits']) > BigInt(raw['maxAmountMinorUnits'])) return bad('TERMS_AMOUNT_RANGE', '0 < minimum ≤ maximum');
  if (typeof raw['brokerRef'] !== 'string' || raw['brokerRef'].length === 0) return bad('TERMS_BROKER', 'brokerRef names the board-approved broker');
  if (typeof raw['commodityCode'] !== 'string' || raw['commodityCode'].length === 0) return bad('TERMS_COMMODITY', 'commodityCode is required');
  if (typeof raw['agencyPermitted'] !== 'boolean') return bad('TERMS_AGENCY', 'agencyPermitted is a boolean');
  if (raw['adminFeeMinorUnits'] !== undefined && !isIntString(raw['adminFeeMinorUnits'])) return bad('TERMS_FEE', 'adminFeeMinorUnits is an integer string');
  const credit = parseBusinessCreditRule(raw['credit'], (s) => money(BigInt(s)));
  if (!credit.ok) return credit;
  const guarantee = parseGuarantee(raw['guarantee']);
  if (!guarantee.ok) return guarantee;
  return ok({
    minMonths: raw['minMonths'], maxMonths: raw['maxMonths'],
    minAmount: money(BigInt(raw['minAmountMinorUnits'])), maxAmount: money(BigInt(raw['maxAmountMinorUnits'])),
    brokerRef: raw['brokerRef'], commodityCode: raw['commodityCode'], agencyPermitted: raw['agencyPermitted'],
    adminFee: money(raw['adminFeeMinorUnits'] === undefined ? 0n : BigInt(raw['adminFeeMinorUnits'])),
    credit: credit.value,
    ...(guarantee.value === undefined ? {} : { guarantee: guarantee.value }),
  });
}
