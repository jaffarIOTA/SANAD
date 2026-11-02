/**
 * Checks on what a document says (document intelligence D2): the rules a
 * checklist item declares, evaluated against what was read from the document.
 *
 * Each check comes out PASS, FAIL (with what was observed and the limit it
 * was held to) or UNREADABLE — and that is all it does. It is shown to the
 * checker beside the document; it never validates or refuses the document,
 * and it never changes how the checklist counts it (product owner,
 * 2026-10-19: always four eyes). A failed check is a reason for the checker
 * to look, in both languages; the checker decides.
 *
 * Pure: dates are compared as civil day numbers, never through a clock. A
 * Hijri date is compared through the converter the caller supplies; one it
 * cannot convert is UNREADABLE, never guessed.
 */
import { type Result, ok, reject } from '../kernel/result.ts';
import type { CheckResult, CivilDate, Understanding } from './understanding.ts';

export type DocumentCheckRule =
  /** The document's own expiry date is after the reading date (plus any margin the policy wants left). */
  | { readonly check: 'NOT_EXPIRED'; readonly minimumRemainingDays?: number }
  /** The document was issued no more than this many days before the reading date. */
  | { readonly check: 'ISSUED_WITHIN'; readonly days: number }
  /** A statement's period ends no more than this many days before the reading date. */
  | { readonly check: 'PERIOD_ENDS_WITHIN'; readonly days: number }
  /** A statement's period covers at least this many whole months. */
  | { readonly check: 'PERIOD_COVERS'; readonly months: number }
  /** The registration (CR, licence) number on the document is the application's. */
  | { readonly check: 'REGISTRATION_MATCHES' }
  /** The business's name appears on the document, in either script. */
  | { readonly check: 'NAME_FOUND' }
  /** The issuer's authenticity service confirms the document (D3): a rail's answer, not a reading. */
  | { readonly check: 'AUTHENTIC' };

/**
 * What the issuer's authenticity service said about a document (D3), passed
 * in by the caller who asked it. Not asked — no consent, the rail down, a
 * type it does not cover — is NOT_CHECKED, with why: never a pass.
 */
export type Authenticity =
  | {
      readonly status: 'AUTHENTIC' | 'NOT_AUTHENTIC';
      /** The service's own reference for the answer, so it can be reproduced. */
      readonly reference: string;
      readonly source: 'LIVE' | 'FIXTURE';
    }
  | {
      readonly status: 'NOT_CHECKED';
      readonly reason: 'NO_CONSENT' | 'RAIL_UNAVAILABLE' | 'TYPE_NOT_COVERED' | 'REFUSED';
    };

const CHECKS = new Set<DocumentCheckRule['check']>([
  'NOT_EXPIRED',
  'ISSUED_WITHIN',
  'PERIOD_ENDS_WITHIN',
  'PERIOD_COVERS',
  'REGISTRATION_MATCHES',
  'NAME_FOUND',
  'AUTHENTIC',
]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;

/** Parse a checklist item's check rules. One malformed rule refuses the checklist, never half-applies it. */
export function parseCheckRules(raw: unknown, where: string): Result<readonly DocumentCheckRule[]> {
  const bad = (detail: string) => reject('OP-DETERMINACY', 'CHECKLIST_INVALID', `${where}: ${detail}`);
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return bad('checks is a list');
  const rules: DocumentCheckRule[] = [];
  for (const r of raw) {
    if (!isRecord(r) || !CHECKS.has(r['check'] as DocumentCheckRule['check']))
      return bad('each check names a known check');
    switch (r['check']) {
      case 'NOT_EXPIRED':
        if (r['minimumRemainingDays'] !== undefined && !count(r['minimumRemainingDays'], 3650))
          return bad('minimumRemainingDays is a whole number of days');
        rules.push(
          r['minimumRemainingDays'] === undefined
            ? { check: 'NOT_EXPIRED' }
            : { check: 'NOT_EXPIRED', minimumRemainingDays: r['minimumRemainingDays'] },
        );
        break;
      case 'ISSUED_WITHIN':
      case 'PERIOD_ENDS_WITHIN':
        if (!count(r['days'], 3650)) return bad(`${r['check']} names a whole number of days`);
        rules.push({ check: r['check'], days: r['days'] });
        break;
      case 'PERIOD_COVERS':
        if (!count(r['months'], 60)) return bad('PERIOD_COVERS names a whole number of months');
        rules.push({ check: 'PERIOD_COVERS', months: r['months'] });
        break;
      default:
        rules.push({ check: r['check'] as 'REGISTRATION_MATCHES' | 'NAME_FOUND' | 'AUTHENTIC' });
    }
  }
  if (new Set(rules.map((r) => r.check)).size !== rules.length) return bad('a check is declared twice');
  return ok(rules);
}

// -- Civil dates as day numbers (proleptic Gregorian), by integer arithmetic ----------

function dayNumber(iso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return undefined;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const y = Number(m[1]) - (mo <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719_468;
}

/** The same day `months` later, clamped to the month's end (31 Jan + 1 month = 28 or 29 Feb). */
function plusMonths(iso: string, months: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (m === null) return undefined;
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + months;
  const y = Math.floor(total / 12);
  const mo = (total % 12) + 1;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] ?? 31;
  const d = Math.min(Number(m[3]), last);
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// -- Evaluation -------------------------------------------------------------------------

/** AUTHENTIC from the issuer's answer: confirmed passes, refuted fails, not asked is unreadable with why. */
function authenticityCheck(a: Authenticity | undefined): CheckResult {
  if (a === undefined) return { check: 'AUTHENTIC', outcome: 'UNREADABLE', reason: 'RAIL_UNAVAILABLE' };
  if (a.status === 'NOT_CHECKED') return { check: 'AUTHENTIC', outcome: 'UNREADABLE', reason: a.reason };
  return {
    check: 'AUTHENTIC',
    outcome: a.status === 'AUTHENTIC' ? 'PASS' : 'FAIL',
    reference: a.reference,
    source: a.source,
  };
}

export interface CheckContext {
  /** The reading date: the civil date (Gregorian, yyyy-mm-dd) in the institution's time zone. */
  readonly asOf: string;
  /** A Hijri (Umm al-Qura) date as its Gregorian date; undefined where it cannot be converted. */
  readonly toGregorian: (date: CivilDate) => string | undefined;
  /** The issuer's answer on this document, where an AUTHENTIC check is declared (D3). */
  readonly authenticity?: Authenticity;
}

/**
 * Evaluate a checklist item's rules against what was read. A document not
 * recognised as a kind the item accepts has its content checks UNREADABLE:
 * the dates of the wrong document say nothing about the right one.
 */
export function evaluateChecks(
  rules: readonly DocumentCheckRule[],
  understanding: Understanding,
  typeMatches: boolean,
  ctx: CheckContext,
): readonly CheckResult[] {
  const today = dayNumber(ctx.asOf);
  const gregorian = (d: CivilDate): number | undefined =>
    dayNumber(d.calendar === 'GREGORIAN' ? d.date : (ctx.toGregorian(d) ?? ''));
  const fact = <F extends Understanding['facts'][number]['fact']>(name: F) =>
    understanding.facts.find((f) => f.fact === name && f.status === 'READ');
  const unreadable = (check: DocumentCheckRule['check']): CheckResult => ({ check, outcome: 'UNREADABLE' });

  return rules.map((rule): CheckResult => {
    // Authenticity is the issuer's answer on the document presented, not a reading of its text: it stands whatever the reading.
    if (rule.check === 'AUTHENTIC') return authenticityCheck(ctx.authenticity);
    if (!typeMatches || today === undefined) return unreadable(rule.check);
    switch (rule.check) {
      case 'NOT_EXPIRED': {
        const f = fact('EXPIRY_DATE');
        const expiry = f?.status === 'READ' && 'value' in f ? gregorian(f.value) : undefined;
        if (expiry === undefined || f === undefined || !('value' in f)) return unreadable(rule.check);
        const left = expiry - today;
        return {
          check: rule.check,
          outcome: left > (rule.minimumRemainingDays ?? 0) ? 'PASS' : 'FAIL',
          observed: f.value.date,
          ...(f.value.calendar === 'HIJRI' ? { calendar: 'HIJRI' as const } : {}),
          ...(rule.minimumRemainingDays === undefined ? {} : { limit: `${String(rule.minimumRemainingDays)}d` }),
        };
      }
      case 'ISSUED_WITHIN': {
        const f = fact('ISSUE_DATE');
        const issued = f !== undefined && 'value' in f ? gregorian(f.value) : undefined;
        if (issued === undefined || f === undefined || !('value' in f)) return unreadable(rule.check);
        return {
          check: rule.check,
          outcome: today - issued <= rule.days && issued <= today ? 'PASS' : 'FAIL',
          observed: f.value.date,
          ...(f.value.calendar === 'HIJRI' ? { calendar: 'HIJRI' as const } : {}),
          limit: `${String(rule.days)}d`,
        };
      }
      case 'PERIOD_ENDS_WITHIN':
      case 'PERIOD_COVERS': {
        const f = fact('STATEMENT_PERIOD');
        if (f === undefined || !('from' in f)) return unreadable(rule.check);
        const from = gregorian(f.from);
        const to = gregorian(f.to);
        if (from === undefined || to === undefined || to < from) return unreadable(rule.check);
        if (rule.check === 'PERIOD_ENDS_WITHIN')
          return {
            check: rule.check,
            outcome: today - to <= rule.days && to <= today ? 'PASS' : 'FAIL',
            observed: f.to.date,
            limit: `${String(rule.days)}d`,
          };
        // Whole months: the period covers N months when it reaches the day before the same date N months on.
        const fromIso = f.from.calendar === 'GREGORIAN' ? f.from.date : ctx.toGregorian(f.from);
        const end = fromIso === undefined ? undefined : plusMonths(fromIso, rule.months);
        const needed = end === undefined ? undefined : dayNumber(end);
        if (needed === undefined) return unreadable(rule.check);
        return {
          check: rule.check,
          outcome: to >= needed - 1 ? 'PASS' : 'FAIL',
          observed: `${f.from.date}..${f.to.date}`,
          limit: `${String(rule.months)}m`,
        };
      }
      case 'REGISTRATION_MATCHES': {
        const m = understanding.matches?.registration;
        return m === undefined || m === 'NOT_READ'
          ? unreadable(rule.check)
          : { check: rule.check, outcome: m === 'MATCHES' ? 'PASS' : 'FAIL' };
      }
      case 'NAME_FOUND': {
        // The name not being found is not a mismatch: rendered Arabic may simply not have been read.
        const m = understanding.matches?.name;
        return m === 'FOUND' ? { check: rule.check, outcome: 'PASS' } : unreadable(rule.check);
      }
    }
  });
}
