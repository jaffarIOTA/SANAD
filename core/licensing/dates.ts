/**
 * Calendar arithmetic for licence terms, in integers only.
 *
 * Core reads no clock and constructs no `Date` (SH-06, test/architecture), so
 * the civil-date conversions are the well-known integer algorithms (days from
 * civil and back, proleptic Gregorian, UTC) over `bigint`. No float is ever
 * produced: every division is a `bigint` division of non-negative operands.
 *
 * Two wire forms, both UTC:
 *   - a **date**, `YYYY-MM-DD`, meaning 00:00:00 UTC of that day;
 *   - an **instant**, `YYYY-MM-DDTHH:MM:SSZ`, to the second.
 */

const SECONDS_PER_DAY = 86_400n;

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** `YYYY-MM-DD`, a real calendar day between 2000 and 9999, or undefined. */
export function parseDate(text: unknown): CivilDate | undefined {
  if (typeof text !== 'string') return undefined;
  const m = DATE.exec(text);
  if (m === null) return undefined;
  const year = Number.parseInt(m[1] ?? '', 10);
  const month = Number.parseInt(m[2] ?? '', 10);
  const day = Number.parseInt(m[3] ?? '', 10);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

/** Days since 1970-01-01 (proleptic Gregorian). */
export function dayNumber(d: CivilDate): bigint {
  const y = BigInt(d.month <= 2 ? d.year - 1 : d.year);
  const m = BigInt(d.month);
  const era = y / 400n; // y >= 1999 here, so truncation is floor
  const yoe = y - era * 400n;
  const mp = m > 2n ? m - 3n : m + 9n;
  const doy = (153n * mp + 2n) / 5n + BigInt(d.day) - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146_097n + doe - 719_468n;
}

/** The civil date of a day number (inverse of `dayNumber`), for days on or after 1970-01-01. */
export function civilOf(days: bigint): CivilDate {
  const z = days + 719_468n;
  const era = z / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const day = doy - (153n * mp + 2n) / 5n + 1n;
  const month = mp < 10n ? mp + 3n : mp - 9n;
  const year = yoe + era * 400n + (month <= 2n ? 1n : 0n);
  return { year: Number(year), month: Number(month), day: Number(day) };
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

export function formatDate(d: CivilDate): string {
  return `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
}

/** 00:00:00 UTC of the day, in epoch seconds. */
export function startOfDay(d: CivilDate): bigint {
  return dayNumber(d) * SECONDS_PER_DAY;
}

/** `YYYY-MM-DDTHH:MM:SSZ` → epoch seconds, or undefined. */
export function parseInstant(text: unknown): bigint | undefined {
  if (typeof text !== 'string') return undefined;
  const m = INSTANT.exec(text);
  if (m === null) return undefined;
  const date = parseDate(`${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}`);
  const h = Number.parseInt(m[4] ?? '', 10);
  const min = Number.parseInt(m[5] ?? '', 10);
  const s = Number.parseInt(m[6] ?? '', 10);
  if (date === undefined || h > 23 || min > 59 || s > 59) return undefined;
  return startOfDay(date) + BigInt(h * 3_600 + min * 60 + s);
}

/** Epoch seconds → `YYYY-MM-DDTHH:MM:SSZ`. */
export function formatInstant(epochSeconds: bigint): string {
  const days = epochSeconds / SECONDS_PER_DAY;
  const rest = epochSeconds - days * SECONDS_PER_DAY;
  const h = Number(rest / 3_600n);
  const min = Number((rest % 3_600n) / 60n);
  const s = Number(rest % 60n);
  return `${formatDate(civilOf(days))}T${pad(h, 2)}:${pad(min, 2)}:${pad(s, 2)}Z`;
}

/**
 * The same day `months` calendar months later, clamped to the last day of the
 * target month (31 January + 1 month = 28 or 29 February).
 */
export function addMonths(d: CivilDate, months: number): CivilDate {
  const index = d.year * 12 + (d.month - 1) + months;
  const monthIndex = index % 12;
  const year = (index - monthIndex) / 12; // exact: index - monthIndex is a multiple of 12
  const month = monthIndex + 1;
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}

export function addDays(d: CivilDate, days: number): CivilDate {
  return civilOf(dayNumber(d) + BigInt(days));
}

/** Whole days, rounded up: one second left is one day remaining. Zero or less stays as it is. */
export function ceilDays(seconds: bigint): number {
  if (seconds <= 0n) return 0;
  return Number((seconds + SECONDS_PER_DAY - 1n) / SECONDS_PER_DAY);
}

export { SECONDS_PER_DAY };
