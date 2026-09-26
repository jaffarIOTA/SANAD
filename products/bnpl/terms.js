import { money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';










const KEYS = new Set(['instalments', 'intervalDays', 'consumerLimitMinorUnits', 'merchantDiscountPerTenThousand', 'citation']);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const bad = (reason, detail) => reject('OP-DETERMINACY', reason, detail);

export function parseBnplTerms(raw) {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'BNPL terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in BNPL terms', { keys: unknown.join(',') });
  if (!isPosInt(raw['instalments']) || raw['instalments'] > 12) return bad('TERMS_INSTALMENTS', 'instalments is a positive integer, at most 12');
  if (!isPosInt(raw['intervalDays'])) return bad('TERMS_INTERVAL', 'intervalDays is a positive integer');
  if (typeof raw['consumerLimitMinorUnits'] !== 'string' || !/^\d+$/.test(raw['consumerLimitMinorUnits'])) return bad('TERMS_LIMIT', 'consumerLimitMinorUnits is an integer string');
  const mdr = raw['merchantDiscountPerTenThousand'];
  if (typeof mdr !== 'number' || !Number.isInteger(mdr) || mdr < 0 || mdr > 10000) return bad('TERMS_MDR', 'merchantDiscountPerTenThousand is an integer in [0, 10000]');
  if (typeof raw['citation'] !== 'string' || raw['citation'].trim().length < 10) return bad('TERMS_CITATION_REQUIRED', 'The consumer limit carries the regulation and article it comes from');
  return ok({ instalments: raw['instalments'], intervalDays: raw['intervalDays'], consumerLimit: money(BigInt(raw['consumerLimitMinorUnits'])), merchantDiscountPerTenThousand: mdr, citation: raw['citation'] });
}
