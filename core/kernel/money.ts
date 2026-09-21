/**
 * Money — minor-unit integers with an explicit currency.
 *
 * `bigint`, never `number`, and never a floating point value anywhere in the
 * financial path (CLAUDE.md §8, SDD BE-06). The database stores the same minor
 * units, so there is one representation end to end and no rounding seam.
 *
 * There is no multiplication by a fraction, no percentage helper and no division.
 * Those are the operations a rate would need, and no rate exists (SH-01). Profit
 * arrives as an amount that was decided at quotation time; this module only adds,
 * subtracts and compares.
 */

import { type Result, ok, reject } from './result.ts';

/** ISO 4217. SAR at launch; the union exists so a second currency is a config change. */
export type CurrencyCode = 'SAR';

export interface Money {
  readonly minorUnits: bigint;
  readonly currency: CurrencyCode;
}

export function money(minorUnits: bigint | number, currency: CurrencyCode = 'SAR'): Money {
  if (typeof minorUnits === 'number') {
    if (!Number.isInteger(minorUnits)) {
      throw new TypeError(`money() requires whole minor units, received ${minorUnits}`);
    }
    return { minorUnits: BigInt(minorUnits), currency };
  }
  return { minorUnits, currency };
}

export const zero = (currency: CurrencyCode = 'SAR'): Money => ({ minorUnits: 0n, currency });

export const isNegative = (m: Money): boolean => m.minorUnits < 0n;
export const isZero = (m: Money): boolean => m.minorUnits === 0n;
export const isPositive = (m: Money): boolean => m.minorUnits > 0n;

export const sameCurrency = (a: Money, b: Money): boolean => a.currency === b.currency;

export const equals = (a: Money, b: Money): boolean =>
  a.currency === b.currency && a.minorUnits === b.minorUnits;

/**
 * Ordering. Comparing across currencies is a programming error, not a domain
 * rejection — there is no meaningful answer to return.
 */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b, 'compare');
  if (a.minorUnits < b.minorUnits) return -1;
  if (a.minorUnits > b.minorUnits) return 1;
  return 0;
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'add');
  return { minorUnits: a.minorUnits + b.minorUnits, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b, 'subtract');
  return { minorUnits: a.minorUnits - b.minorUnits, currency: a.currency };
}

export function sum(amounts: readonly Money[], currency: CurrencyCode = 'SAR'): Money {
  let total = 0n;
  for (const amount of amounts) {
    if (amount.currency !== currency) {
      throw new TypeError(`sum() mixed currencies: expected ${currency}, found ${amount.currency}`);
    }
    total += amount.minorUnits;
  }
  return { minorUnits: total, currency };
}

/**
 * Validates an amount that must be present and non-negative before a contract can
 * reach an executable state (SH-03 — any null in the determinacy set blocks
 * execution).
 */
export function requireDeterminate(
  amount: Money | undefined,
  field: string,
): Result<Money> {
  if (amount === undefined) {
    return reject('SH-03', 'AMOUNT_INDETERMINATE', `${field} must be determinate before execution`, {
      field,
    });
  }
  if (isNegative(amount)) {
    return reject('SH-03', 'AMOUNT_NEGATIVE', `${field} must not be negative`, { field });
  }
  return ok(amount);
}

function assertSameCurrency(a: Money, b: Money, op: string): void {
  if (a.currency !== b.currency) {
    throw new TypeError(`money.${op}() across currencies: ${a.currency} and ${b.currency}`);
  }
}
