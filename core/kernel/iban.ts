/**
 * International Bank Account Numbers (ISO 13616): shape, country length and
 * the mod-97 check, for the jurisdictions Sanad serves. Pure, no number type:
 * the remainder is taken digit by digit over the string.
 *
 * Lengths are the registry's (SWIFT IBAN Registry): AE 23, SA 24. A country
 * outside the list is refused rather than guessed.
 */
import { type Result, ok, reject } from './result.ts';

export const IBAN_LENGTH: Readonly<Record<string, number>> = { AE: 23, SA: 24 };

/** Spaces removed, upper case: the electronic form. */
export const normaliseIban = (raw: string): string => raw.replace(/\s+/g, '').toUpperCase();

function mod97(digits: string): number {
  let rest = 0;
  for (const ch of digits) rest = (rest * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return rest;
}

/** The IBAN in electronic form, if it is well formed, of the expected country and length, and passes mod 97. */
export function validateIban(raw: string, country: string): Result<string> {
  const iban = normaliseIban(raw);
  const length = IBAN_LENGTH[country];
  if (length === undefined) return reject('OP-DETERMINACY', 'IBAN_COUNTRY_UNSUPPORTED', 'No IBAN rule for this country', { country });
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban) || iban.slice(0, 2) !== country || iban.length !== length)
    return reject('OP-DETERMINACY', 'IBAN_INVALID', 'The IBAN is not a well-formed account number of this country', {
      country,
      expectedLength: String(length),
    });
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`;
  const digits = [...rearranged].map((c) => (/\d/.test(c) ? c : String(c.charCodeAt(0) - 55))).join('');
  if (mod97(digits) !== 1) return reject('OP-DETERMINACY', 'IBAN_INVALID', 'The IBAN fails its check digits', { country });
  return ok(iban);
}

/** Country, check digits and the last four only: AE07 •••• 1234. */
export const maskIban = (iban: string): string => `${iban.slice(0, 4)} •••• ${iban.slice(-4)}`;
