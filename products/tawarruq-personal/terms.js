/**
 * The tenant's term sheet for personal Tawarruq. Strict: an unknown key or a
 * threshold without its citation does not parse.
 */

import { money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';





















const KEYS = new Set(['minMonths', 'maxMonths', 'maxAmountMinorUnits', 'brokerRef', 'commodityCode', 'agencyPermitted', 'adminFeeMinorUnits', 'affordability']);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isIntString = (v) => typeof v === 'string' && /^\d+$/.test(v);
const bad = (reason, detail) => reject('OP-DETERMINACY', reason, detail);

export function parseTawarruqTerms(raw) {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'Tawarruq terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in Tawarruq terms', { keys: unknown.join(',') });
  if (!isPosInt(raw['minMonths']) || !isPosInt(raw['maxMonths']) || raw['minMonths'] > raw['maxMonths']) return bad('TERMS_MONTHS', 'minMonths ≤ maxMonths, both positive integers');
  if (!isIntString(raw['maxAmountMinorUnits'])) return bad('TERMS_MAX_AMOUNT', 'maxAmountMinorUnits is an integer string');
  if (typeof raw['brokerRef'] !== 'string' || raw['brokerRef'].length === 0) return bad('TERMS_BROKER', 'brokerRef names the board-approved broker');
  if (typeof raw['commodityCode'] !== 'string' || raw['commodityCode'].length === 0) return bad('TERMS_COMMODITY', 'commodityCode is required');
  if (typeof raw['agencyPermitted'] !== 'boolean') return bad('TERMS_AGENCY', 'agencyPermitted is a boolean');
  if (raw['adminFeeMinorUnits'] !== undefined && !isIntString(raw['adminFeeMinorUnits'])) return bad('TERMS_FEE', 'adminFeeMinorUnits is an integer string');
  const aff = raw['affordability'];
  if (!isRecord(aff) || !isPosInt(aff['maxDeductionPerTenThousand']) || aff['maxDeductionPerTenThousand'] > 10000) return bad('TERMS_AFFORDABILITY', 'affordability.maxDeductionPerTenThousand is an integer in (0, 10000]');
  if (typeof aff['citation'] !== 'string' || aff['citation'].trim().length < 10) return bad('TERMS_CITATION_REQUIRED', 'A regulatory threshold carries the regulation and article it comes from');
  return ok({
    minMonths: raw['minMonths'], maxMonths: raw['maxMonths'], maxAmount: money(BigInt(raw['maxAmountMinorUnits'])),
    brokerRef: raw['brokerRef'], commodityCode: raw['commodityCode'], agencyPermitted: raw['agencyPermitted'],
    adminFee: money(raw['adminFeeMinorUnits'] === undefined ? 0n : BigInt(raw['adminFeeMinorUnits'])),
    affordability: { maxDeductionPerTenThousand: aff['maxDeductionPerTenThousand'], citation: aff['citation'] },
  });
}
