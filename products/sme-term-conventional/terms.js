/**
 * The tenant's term sheet for conventional SME term finance. Strict: an
 * unknown key, a limit without its policy reference, a guarantee without its
 * programme reference, a missing currency, or a malformed variant does not
 * parse.
 *
 * The term sheet names its currency (SAR or AED, ADR 0005) and lists one or
 * more variants (variants.ts). The product minimum, the administration fee,
 * the credit rule and the guarantee are the module's and apply to every
 * variant; a variant carries its own ceiling, tenor band, grace, contribution
 * band, years in operation, purposes, checklist and collateral.
 */

import { parseBusinessCreditRule } from '../../core/decisioning/business-affordability.js';
import { parseGuarantee } from '../../core/decisioning/guarantee.js';
import { money } from '../../core/kernel/money.js';
import { ok, reject } from '../../core/kernel/result.js';

import { parseCurrency, parseVariants } from './variants.js';










const KEYS = new Set(['currency', 'minAmountMinorUnits', 'adminFeeMinorUnits', 'variants', 'credit', 'guarantee']);
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntString = (v) => typeof v === 'string' && /^\d+$/.test(v);
const bad = (reason, detail) => reject('OP-DETERMINACY', reason, detail);

export function parseSmeConventionalTerms(raw) {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'SME term finance terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in SME term finance terms', { keys: unknown.join(',') });
  const currency = parseCurrency(raw['currency']);
  if (!currency.ok) return currency;
  const c = currency.value;
  if (!isIntString(raw['minAmountMinorUnits']) || BigInt(raw['minAmountMinorUnits']) <= 0n) return bad('TERMS_AMOUNTS', 'minAmountMinorUnits is a positive integer string');
  if (raw['adminFeeMinorUnits'] !== undefined && !isIntString(raw['adminFeeMinorUnits'])) return bad('TERMS_FEE', 'adminFeeMinorUnits is an integer string');
  const minAmount = money(BigInt(raw['minAmountMinorUnits']), c);
  const variants = parseVariants(raw['variants'], c, minAmount);
  if (!variants.ok) return variants;
  const credit = parseBusinessCreditRule(raw['credit'], (s) => money(BigInt(s), c));
  if (!credit.ok) return credit;
  const guarantee = parseGuarantee(raw['guarantee']);
  if (!guarantee.ok) return guarantee;
  return ok({
    currency: c,
    minAmount,
    adminFee: money(raw['adminFeeMinorUnits'] === undefined ? 0n : BigInt(raw['adminFeeMinorUnits']), c),
    variants: variants.value,
    credit: credit.value,
    ...(guarantee.value === undefined ? {} : { guarantee: guarantee.value }),
  });
}
