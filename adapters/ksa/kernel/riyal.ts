/**
 * Riyal amounts at the Saudi rail boundary (ADR 0005), the counterpart of
 * `adapters/uae/kernel/dirham.ts`.
 *
 * A Saudi rail answers in SAR. A vendor decimal becomes minor units (halalas)
 * by digit manipulation; a JSON number with a fractional part is refused
 * rather than converted, because by the time it is a number it has already
 * been a float. An answer that names another currency is malformed, not
 * converted. An instruction the platform sends must be in SAR and positive.
 */

import { type Money, money } from '../../../core/kernel/money.ts';
import { type Result, ok, reject } from '../../../core/kernel/result.ts';
import { decimalToMinor } from './rail-adapter.ts';

export const KSA_CURRENCY = 'SAR' as const;

/** A vendor amount to SAR minor units; `currency`, where the rail states one, must be SAR. */
export function sar(value: unknown, currency?: unknown): Money | undefined {
  if (currency !== undefined && currency !== KSA_CURRENCY) return undefined;
  if (typeof value === 'number' && !Number.isInteger(value)) return undefined;
  const minor = decimalToMinor(value);
  return minor === undefined ? undefined : money(minor, KSA_CURRENCY);
}

/** An instruction to a Saudi payment rail: SAR, and strictly positive. */
export function instructableSar(m: Money): Result<true> {
  if (m.currency !== KSA_CURRENCY)
    return reject(
      'OP-DETERMINACY',
      'CURRENCY_MISMATCH',
      'A Saudi payment rail is instructed in riyals only; an amount in another currency is refused, never converted',
    );
  return m.minorUnits > 0n
    ? ok(true)
    : reject('OP-DETERMINACY', 'AMOUNT_NOT_POSITIVE', 'A payment instruction is for a positive amount');
}
