 function _nullishCoalesce(lhs, rhsFn) { if (lhs != null) { return lhs; } else { return rhsFn(); } }/**
 * The BNPL term sheet a tenant configures.
 *
 * The ceilings here come from the SAMA Rules for Regulating Buy-Now-Pay-Later
 * Companies (November 2023, Jumada I 1445H), Chapter IV. Each is named with
 * its article so the next reader can check it against the published text
 * rather than this file. SAMA may raise or lower the consumer limit (Art. 22(1),
 * "subject to increase or decrease by SAMA"); a tenant that holds such a
 * decision records its reference and the limit may then exceed the figure in
 * the Rules. Nothing else lifts it.
 */

import { money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';

export const BNPL_RULES = 'SAMA Rules for Regulating BNPL Companies, Nov 2023 (Jumada I 1445H)';
/** Art. 22(1): total outstanding BNPL financing per consumer natural person, SAR 10,000. */
export const ART_22_1_CONSUMER_LIMIT_MINOR_UNITS = 1_000_000n;
/** Art. 22(2): the number of instalments granted to the consumer must not exceed 12. */
export const ART_22_2_MAX_INSTALMENTS = 12;

/** Art. 22(3): collection through electronic channels only; a cash request is prohibited. */
 
const COLLECTION_METHODS = new Set(['SADAD', 'CARD', 'OPEN_BANKING_PIS', 'DIRECT_DEBIT']);















const KEYS = new Set(['instalments', 'intervalDays', 'consumerLimitMinorUnits', 'merchantDiscountPerTenThousand', 'citation', 'samaLimitVariationRef', 'collectionMethods']);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v) => typeof v === 'number' && Number.isInteger(v) && v > 0;
const bad = (reason, detail, context) => reject('OP-DETERMINACY', reason, detail, context);

export function parseBnplTerms(raw) {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'BNPL terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in BNPL terms', { keys: unknown.join(',') });
  if (!isPosInt(raw['instalments']) || raw['instalments'] > ART_22_2_MAX_INSTALMENTS) {
    return bad('TERMS_INSTALMENTS', `instalments is a positive integer, at most ${String(ART_22_2_MAX_INSTALMENTS)}`, { citation: `${BNPL_RULES}, Art. 22(2)` });
  }
  if (!isPosInt(raw['intervalDays'])) return bad('TERMS_INTERVAL', 'intervalDays is a positive integer');
  if (typeof raw['consumerLimitMinorUnits'] !== 'string' || !/^\d+$/.test(raw['consumerLimitMinorUnits'])) return bad('TERMS_LIMIT', 'consumerLimitMinorUnits is an integer string');
  const limit = BigInt(raw['consumerLimitMinorUnits']);
  const variation = raw['samaLimitVariationRef'];
  if (variation !== undefined && (typeof variation !== 'string' || variation.trim().length < 6)) return bad('TERMS_LIMIT_VARIATION_REF', 'samaLimitVariationRef is the reference of the SAMA decision varying the limit');
  if (limit > ART_22_1_CONSUMER_LIMIT_MINOR_UNITS && variation === undefined) {
    return bad('TERMS_LIMIT_ABOVE_RULES', 'The consumer limit exceeds the figure in the Rules and no SAMA variation is recorded', {
      limitMinorUnits: String(limit), rulesMinorUnits: String(ART_22_1_CONSUMER_LIMIT_MINOR_UNITS), citation: `${BNPL_RULES}, Art. 22(1)`,
    });
  }
  const mdr = raw['merchantDiscountPerTenThousand'];
  if (typeof mdr !== 'number' || !Number.isInteger(mdr) || mdr < 0 || mdr > 10000) return bad('TERMS_MDR', 'merchantDiscountPerTenThousand is an integer in [0, 10000]');
  if (typeof raw['citation'] !== 'string' || raw['citation'].trim().length < 10) return bad('TERMS_CITATION_REQUIRED', 'The consumer limit carries the regulation and article it comes from');
  const methodsRaw = _nullishCoalesce(raw['collectionMethods'], () => ( ['SADAD', 'CARD', 'OPEN_BANKING_PIS']));
  if (!Array.isArray(methodsRaw) || methodsRaw.length === 0) return bad('TERMS_COLLECTION', 'collectionMethods lists at least one electronic channel');
  const notElectronic = methodsRaw.filter((m) => typeof m !== 'string' || !COLLECTION_METHODS.has(m));
  if (notElectronic.length > 0) {
    return bad('TERMS_COLLECTION_NOT_ELECTRONIC', 'Collection is through electronic channels only; a cash request is prohibited', { rejected: notElectronic.map(String).join(','), citation: `${BNPL_RULES}, Art. 22(3)` });
  }
  return ok({
    instalments: raw['instalments'], intervalDays: raw['intervalDays'], consumerLimit: money(limit), merchantDiscountPerTenThousand: mdr, citation: raw['citation'],
    ...(typeof variation === 'string' ? { samaLimitVariationRef: variation.trim() } : {}),
    collectionMethods: methodsRaw ,
  });
}
