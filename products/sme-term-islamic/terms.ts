/**
 * The tenant's term sheet for SME finance by Tawarruq (commodity Murabaha).
 * Strict: an unknown key, a credit limit without its policy reference, a
 * guarantee without its programme reference, a missing currency, or a
 * malformed variant does not parse. The structure's permissions (broker,
 * commodity, agency) are the tenant board's, as for personal Tawarruq.
 *
 * The term sheet names its currency (SAR or AED, ADR 0005) and lists one or
 * more variants (variants.ts). The product minimum, the administration fee,
 * the structure, the credit rule and the guarantee are the module's and apply
 * to every variant.
 */

import { type BusinessCreditRule, parseBusinessCreditRule } from '@sanad/core/decisioning/business-affordability.ts';
import { type GuaranteeTerms, parseGuarantee } from '@sanad/core/decisioning/guarantee.ts';
import { type CurrencyCode, type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

import { type SmeVariant, parseCurrency, parseVariants } from './variants.ts';

export interface SmeIslamicTerms {
  readonly currency: CurrencyCode;
  readonly minAmount: Money;
  /** The broker the board approved, by reference. */
  readonly brokerRef: string;
  readonly commodityCode: string;
  /** Whether the institution may sell on as the enterprise's agent. Board-specific. */
  readonly agencyPermitted: boolean;
  readonly adminFee: Money;
  readonly variants: readonly SmeVariant[];
  readonly credit: BusinessCreditRule;
  readonly guarantee?: GuaranteeTerms;
}

const KEYS = new Set([
  'currency',
  'minAmountMinorUnits',
  'brokerRef',
  'commodityCode',
  'agencyPermitted',
  'adminFeeMinorUnits',
  'variants',
  'credit',
  'guarantee',
]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntString = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);

export function parseSmeIslamicTerms(raw: unknown): Result<SmeIslamicTerms> {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'SME Tawarruq terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0)
    return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in SME Tawarruq terms', {
      keys: unknown.join(','),
    });
  const currency = parseCurrency(raw['currency']);
  if (!currency.ok) return currency;
  const c = currency.value;
  if (!isIntString(raw['minAmountMinorUnits']) || BigInt(raw['minAmountMinorUnits']) <= 0n)
    return bad('TERMS_AMOUNTS', 'minAmountMinorUnits is a positive integer string');
  if (typeof raw['brokerRef'] !== 'string' || raw['brokerRef'].length === 0)
    return bad('TERMS_BROKER', 'brokerRef names the board-approved broker');
  if (typeof raw['commodityCode'] !== 'string' || raw['commodityCode'].length === 0)
    return bad('TERMS_COMMODITY', 'commodityCode is required');
  if (typeof raw['agencyPermitted'] !== 'boolean') return bad('TERMS_AGENCY', 'agencyPermitted is a boolean');
  if (raw['adminFeeMinorUnits'] !== undefined && !isIntString(raw['adminFeeMinorUnits']))
    return bad('TERMS_FEE', 'adminFeeMinorUnits is an integer string');
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
    brokerRef: raw['brokerRef'],
    commodityCode: raw['commodityCode'],
    agencyPermitted: raw['agencyPermitted'],
    adminFee: money(raw['adminFeeMinorUnits'] === undefined ? 0n : BigInt(raw['adminFeeMinorUnits']), c),
    variants: variants.value,
    credit: credit.value,
    ...(guarantee.value === undefined ? {} : { guarantee: guarantee.value }),
  });
}
