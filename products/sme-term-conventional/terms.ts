/**
 * The tenant's term sheet for conventional SME term finance. Strict: an
 * unknown key, a limit without its policy reference, or a guarantee without
 * its programme reference does not parse.
 */

import { type BusinessCreditRule, parseBusinessCreditRule } from '@sanad/core/decisioning/business-affordability.ts';
import { type GuaranteeTerms, parseGuarantee } from '@sanad/core/decisioning/guarantee.ts';
import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

export interface SmeConventionalTerms {
  readonly minMonths: number;
  readonly maxMonths: number;
  readonly minAmount: Money;
  readonly maxAmount: Money;
  readonly adminFee: Money;
  readonly credit: BusinessCreditRule;
  readonly guarantee?: GuaranteeTerms;
}

const KEYS = new Set(['minMonths', 'maxMonths', 'minAmountMinorUnits', 'maxAmountMinorUnits', 'adminFeeMinorUnits', 'credit', 'guarantee']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isIntString = (v: unknown): v is string => typeof v === 'string' && /^\d+$/.test(v);
const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);

export function parseSmeConventionalTerms(raw: unknown): Result<SmeConventionalTerms> {
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
