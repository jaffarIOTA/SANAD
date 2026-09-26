import { type Money, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';

export interface BnplTerms {
  readonly instalments: number;
  readonly intervalDays: number;
  readonly consumerLimit: Money;
  /** Per ten thousand of the basket, charged to the merchant. Never to the consumer. */
  readonly merchantDiscountPerTenThousand: number;
  readonly citation: string;
}

const KEYS = new Set(['instalments', 'intervalDays', 'consumerLimitMinorUnits', 'merchantDiscountPerTenThousand', 'citation']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);

export function parseBnplTerms(raw: unknown): Result<BnplTerms> {
  if (!isRecord(raw)) return bad('TERMS_MALFORMED', 'BNPL terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in BNPL terms', { keys: unknown.join(',') });
  if (!isPosInt(raw['instalments']) || raw['instalments'] > 12) return bad('TERMS_INSTALMENTS', 'instalments is a positive integer, at most 12');
  if (!isPosInt(raw['intervalDays'])) return bad('TERMS_INTERVAL', 'intervalDays is a positive integer');
  if (typeof raw['consumerLimitMinorUnits'] !== 'string' || !/^\d+$/.test(raw['consumerLimitMinorUnits'])) return bad('TERMS_LIMIT', 'consumerLimitMinorUnits is an integer string');
  const mdr = raw['merchantDiscountPerTenThousand'];
  if (typeof mdr !== 'number' || !Number.isInteger(mdr) || mdr < 0 || mdr > 10_000) return bad('TERMS_MDR', 'merchantDiscountPerTenThousand is an integer in [0, 10000]');
  if (typeof raw['citation'] !== 'string' || raw['citation'].trim().length < 10) return bad('TERMS_CITATION_REQUIRED', 'The consumer limit carries the regulation and article it comes from');
  return ok({ instalments: raw['instalments'], intervalDays: raw['intervalDays'], consumerLimit: money(BigInt(raw['consumerLimitMinorUnits'])), merchantDiscountPerTenThousand: mdr, citation: raw['citation'] });
}
