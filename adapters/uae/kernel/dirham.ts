/**
 * Dirham amounts at the UAE rail boundary (ADR 0005).
 *
 * Every UAE rail answers in AED, and every amount it returns becomes a
 * `Money` in AED here, at the boundary — never in SAR by the kernel's
 * default. A vendor decimal becomes minor units (fils) by digit
 * manipulation; a JSON number with a fractional part is refused rather than
 * converted, because by the time it is a number it has already been a float.
 * An answer that names another currency is malformed, not converted.
 */

import { type Money, money } from '../../../core/kernel/money.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import { decimalToMinor } from '../../kernel/rail-adapter.ts';

export const UAE_CURRENCY = 'AED' as const;

/**
 * A vendor amount to AED minor units. `currency`, where the rail states one,
 * must be AED. Accepts a decimal string ("1234.50") or a whole-dirham integer;
 * refuses a fractional JSON number and anything with more than two decimals.
 */
export function aed(value: unknown, currency?: unknown): Money | undefined {
  if (currency !== undefined && currency !== UAE_CURRENCY) return undefined;
  if (typeof value === 'number' && !Number.isInteger(value)) return undefined;
  const minor = decimalToMinor(value);
  return minor === undefined ? undefined : money(minor, UAE_CURRENCY);
}

/**
 * A `{ Amount, Currency }` object in the Open Finance / ISO 20022 style, where
 * the amount is a decimal STRING that may carry up to five decimals. Only a
 * string is accepted (a JSON number has already been a float); digits beyond
 * the fils must be zero, because a dirham has no smaller unit; the currency
 * must be AED.
 */
export function aedAmountObject(value: unknown, amountKey = 'Amount', currencyKey = 'Currency'): Money | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const amount = rec[amountKey];
  if (rec[currencyKey] !== UAE_CURRENCY || typeof amount !== 'string') return undefined;
  const m = /^(\d{1,13})(?:\.(\d{1,5}))?$/.exec(amount);
  if (m === null) return undefined;
  const fraction = m[2] ?? '';
  if (/[1-9]/.test(fraction.slice(2))) return undefined;
  return money(BigInt(m[1] ?? '0') * 100n + BigInt(fraction.slice(0, 2).padEnd(2, '0')), UAE_CURRENCY);
}

/** AED minor units to the decimal string an ISO 20022-style instruction carries ("500000.00"), by digit manipulation. */
export function aedDecimal(m: Money): string {
  const negative = m.minorUnits < 0n;
  const abs = negative ? -m.minorUnits : m.minorUnits;
  const fils = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${(abs / 100n).toString()}.${fils}`;
}

/** An instruction or report the platform sends to a UAE rail must be in AED. */
export function requireAed(m: Money): Result<true> {
  return m.currency === UAE_CURRENCY
    ? ok(true)
    : reject(
        'OP-DETERMINACY',
        'CURRENCY_MISMATCH',
        'A UAE rail is instructed in dirhams only; an amount in another currency is refused, never converted',
      );
}
