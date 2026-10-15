/**
 * IBAN validation (ISO 13616) for the two jurisdictions: the registry's
 * published example accounts pass; a wrong check digit, country or length is
 * refused; spacing and case are the paper form, not an error.
 */
import { describe, expect, it } from 'vitest';

import { maskIban, normaliseIban, validateIban } from '../../core/kernel/iban.ts';

const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'valid' : r.error?.reason);

describe('validateIban', () => {
  it('accepts the published example IBANs of the UAE and Saudi Arabia, in paper or electronic form', () => {
    expect(validateIban('AE07 0331 2345 6789 0123 456', 'AE')).toEqual({ ok: true, value: 'AE070331234567890123456' });
    expect(validateIban('sa0380000000608010167519', 'SA')).toEqual({ ok: true, value: 'SA0380000000608010167519' });
  });
  it('refuses a wrong check digit, another country, a wrong length and stray characters', () => {
    expect(reason(validateIban('AE080331234567890123456', 'AE'))).toBe('IBAN_INVALID');
    expect(reason(validateIban('SA0380000000608010167519', 'AE'))).toBe('IBAN_INVALID');
    expect(reason(validateIban('AE07033123456789012345', 'AE'))).toBe('IBAN_INVALID');
    expect(reason(validateIban('AE07-0331-2345-6789-0123-456', 'AE'))).toBe('IBAN_INVALID');
  });
  it('refuses a country it has no rule for rather than guessing', () => {
    expect(reason(validateIban('GB82WEST12345698765432', 'GB'))).toBe('IBAN_COUNTRY_UNSUPPORTED');
  });
  it('normalises and masks', () => {
    expect(normaliseIban(' ae07 0331 ')).toBe('AE070331');
    expect(maskIban('AE070331234567890123456')).toBe('AE07 •••• 3456');
  });
});
