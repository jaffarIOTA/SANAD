/**
 * ISO 8601 dates at the UAE rail boundary.
 *
 * The public standards the UAE rails are modelled on (Open Finance, OIDC,
 * ISO 20022, VIES, Companies House) state times as ISO 8601 strings, not epoch
 * integers. They become epoch seconds here, strictly: a date-time must carry a
 * zone (`Z` or `±HH:MM`), a date alone is midnight UTC, and anything else —
 * including a calendar date that does not exist — is `undefined`, which every
 * caller treats as malformed. No clock is read.
 */

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcSeconds(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): bigint | undefined {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return undefined;
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(ms);
  // Date.UTC rolls 2026-02-30 over into March; a rolled date is not the date the rail sent.
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return undefined;
  return BigInt(ms) / 1000n;
}

/** An ISO 8601 date-time with a zone, or a bare date (midnight UTC), to epoch seconds. */
export function isoEpoch(v: unknown): bigint | undefined {
  if (typeof v !== 'string') return undefined;
  const dt = DATE_TIME.exec(v);
  if (dt !== null) {
    const [, y, mo, d, h, mi, s, zone] = dt;
    const base = utcSeconds(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
    if (base === undefined || zone === undefined) return undefined;
    if (zone === 'Z') return base;
    const sign = zone.startsWith('-') ? -1n : 1n;
    const oh = BigInt(zone.slice(1, 3));
    const om = BigInt(zone.slice(4, 6));
    if (oh > 14n || om > 59n) return undefined;
    return base - sign * (oh * 3600n + om * 60n);
  }
  const date = DATE.exec(v);
  if (date !== null) return utcSeconds(Number(date[1]), Number(date[2]), Number(date[3]));
  return undefined;
}

/** Epoch seconds to an ISO 8601 UTC date-time without fractional seconds, for request parameters. */
export function isoUtc(epochSeconds: bigint): string {
  return `${new Date(Number(epochSeconds) * 1000).toISOString().slice(0, 19)}Z`;
}
