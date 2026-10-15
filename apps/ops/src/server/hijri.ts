/**
 * Hijri dates for contracts in Saudi Arabia, on the Umm al-Qura calendar —
 * the Kingdom's official calendar — through the platform's ICU data
 * (`islamic-umalqura`). A civil (Gregorian) date is read at noon UTC so no
 * time zone can move it to the neighbouring day. Display only: nothing is
 * computed from a Hijri date.
 */
import type { HijriFormatter } from '@sanad/core/documents/offer-letter.ts';

const FORMAT = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** '2026-10-15' → '٣ جمادى الأولى ١٤٤٨ هـ' (Umm al-Qura). */
export const ummAlQura: HijriFormatter = (isoDate: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (m === null) return '';
  return FORMAT.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)));
};
