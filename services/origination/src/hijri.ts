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

const PARTS = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

/** '2026-10-15' → '1448-05-03' (Umm al-Qura, yyyy-mm-dd), as a contract stores the Hijri date beside the Gregorian. */
export const ummAlQuraIso = (isoDate: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (m === null) return '';
  const parts = PARTS.formatToParts(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)));
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const year = part('year').replace(/\D/g, '');
  return year === '' ? '' : `${year}-${part('month')}-${part('day')}`;
};

const DAY_MS = 86_400_000;
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * '1448-05-03' (Umm al-Qura) → '2026-10-15': the Gregorian day whose
 * Umm al-Qura date it is, for comparing a date read off a document
 * (document intelligence D2). ICU formats into the calendar but does not parse
 * out of it, so the days around the estimate are searched; a date with no
 * such day (a 30th in a 29-day month, a mistyped year) is undefined — never
 * the nearest day.
 */
export function gregorianOfUmmAlQura(hijriIso: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(hijriIso);
  if (m === null) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1300 || y > 1600 || mo < 1 || mo > 12 || d < 1 || d > 30) return undefined;
  const want = `${m[1]}-${m[2]}-${m[3]}`;
  // A Hijri year is 354.37 days; 1 Muharram 1 AH was 16 July 622 (Julian). The estimate is within days of the answer.
  const daysSinceEpoch = Math.round((y - 1) * 354.367 + (mo - 1) * 29.53 + (d - 1)) - 492_148;
  const estimate = Date.UTC(1970, 0, 1, 12) + daysSinceEpoch * DAY_MS;
  for (let offset = 0; offset <= 45; offset += 1)
    for (const sign of offset === 0 ? [0] : [-1, 1]) {
      const iso = isoOf(estimate + sign * offset * DAY_MS);
      if (ummAlQuraIso(iso) === want) return iso;
    }
  return undefined;
}

/** '2026-10-15' → '٣ جمادى الأولى ١٤٤٨ هـ' (Umm al-Qura). */
export const ummAlQura: HijriFormatter = (isoDate: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (m === null) return '';
  return FORMAT.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)));
};
