/**
 * The decision pack of a business application (UAE M4): what the credit
 * decision rests on and what it attaches.
 *
 * - **Deviations** are read from the assessment, never typed: every route
 *   reason that departs from the policy (score below the floor, an amount or
 *   contribution outside the risk band's terms, a failed straight-through
 *   check). Each needs a written justification before a committee may
 *   approve. A failed knock-out is not a deviation: it declines.
 * - **Conditions** precedent (met before first drawdown) and subsequent (met
 *   within a number of days after it), stated in both languages.
 * - **Covenants** taken from the tenant's templates only, so a threshold is
 *   always the institution's configured one, never a figure typed at the desk.
 *
 * Conditions and covenants together are capped by the risk band's
 * `maxConditions`. The pack is frozen at approval by the SHA-256 of its
 * canonical form, so what the committee approved can be shown unchanged.
 *
 * Pure. Product-agnostic: which covenants exist and their thresholds are
 * configuration (`config/tenants/<t>/credit-policy/decision-pack.json`).
 */
import { createHash } from 'node:crypto';

import type { RouteReason } from '../decisioning/sme-assessment.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import { containsIdentityNumber } from './business-application.ts';

const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Result<never> =>
  reject('OP-DETERMINACY', reason, detail, context);

const ARABIC_LETTER = /[؀-ۿ]/;

// =============================================================================
// Policy
// =============================================================================

export const COVENANT_KINDS = ['FINANCIAL', 'INFORMATION', 'NEGATIVE'] as const;
export type CovenantKind = (typeof COVENANT_KINDS)[number];
export const TEST_FREQUENCIES = ['QUARTERLY', 'SEMI_ANNUAL', 'ANNUAL'] as const;
export type TestFrequency = (typeof TEST_FREQUENCIES)[number];

export interface CovenantTemplate {
  readonly code: string;
  readonly kind: CovenantKind;
  /** FINANCIAL only: the ratio tested, and the minimum it must hold, per ten thousand. */
  readonly metric?: string;
  readonly minimumPerTenThousand?: number;
  /** Absent for a NEGATIVE covenant, which holds at all times. */
  readonly frequency?: TestFrequency;
  readonly labelEn: string;
  readonly labelAr: string;
}

export interface DecisionPackPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly policyRef: string;
  readonly covenantTemplates: readonly CovenantTemplate[];
  /** The longest a condition subsequent may run after first drawdown. */
  readonly maxSubsequentDueDays: number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const whole = (v: unknown, min: number, max: number): number | undefined => {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : typeof v === 'number' ? v : undefined;
  return n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

export function parseDecisionPackPolicy(raw: unknown): Result<DecisionPackPolicy> {
  if (raw === null || typeof raw !== 'object') return bad('DECISION_PACK_POLICY_INVALID', 'The policy is an object');
  const r = raw as Record<string, unknown>;
  const policyId = str(r['policyId']);
  const version = str(r['version']);
  const policyRef = str(r['policyRef']);
  if (policyId === undefined || version === undefined || policyRef === undefined)
    return bad('DECISION_PACK_POLICY_INVALID', 'The policy names its id, version and source');
  const maxDays = whole(r['maxSubsequentDueDays'], 1, 3650);
  if (maxDays === undefined)
    return bad('DECISION_PACK_POLICY_INVALID', 'The longest condition subsequent is a whole number of days');
  if (!Array.isArray(r['covenantTemplates']))
    return bad('DECISION_PACK_POLICY_INVALID', 'The policy lists its covenant templates');
  const templates: CovenantTemplate[] = [];
  for (const t of r['covenantTemplates'] as unknown[]) {
    const c = (t ?? {}) as Record<string, unknown>;
    const code = str(c['code']);
    const kind = c['kind'];
    const labelEn = str(c['labelEn']);
    const labelAr = str(c['labelAr']);
    if (code === undefined || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code) || labelEn === undefined || labelAr === undefined)
      return bad('DECISION_PACK_POLICY_INVALID', 'Each covenant template has a code and a label in both languages');
    if (!(COVENANT_KINDS as readonly unknown[]).includes(kind))
      return bad('DECISION_PACK_POLICY_INVALID', 'A covenant is financial, information or negative', { code });
    const frequency = c['frequency'];
    if (frequency !== undefined && !(TEST_FREQUENCIES as readonly unknown[]).includes(frequency))
      return bad('DECISION_PACK_POLICY_INVALID', 'A covenant is tested quarterly, half-yearly or annually', { code });
    if (kind !== 'NEGATIVE' && frequency === undefined)
      return bad('DECISION_PACK_POLICY_INVALID', 'A financial or information covenant has a test frequency', { code });
    let metric: string | undefined;
    let minimum: number | undefined;
    if (kind === 'FINANCIAL') {
      metric = str(c['metric']);
      minimum = whole(c['minimumPerTenThousand'], 1, 1_000_000);
      if (metric === undefined || minimum === undefined)
        return bad('DECISION_PACK_POLICY_INVALID', 'A financial covenant names its ratio and minimum', { code });
    }
    if (templates.some((x) => x.code === code))
      return bad('DECISION_PACK_POLICY_INVALID', 'Covenant template codes are unique', { code });
    templates.push({
      code,
      kind: kind as CovenantKind,
      ...(metric === undefined ? {} : { metric }),
      ...(minimum === undefined ? {} : { minimumPerTenThousand: minimum }),
      ...(frequency === undefined ? {} : { frequency: frequency as TestFrequency }),
      labelEn,
      labelAr,
    });
  }
  return ok({ policyId, version, policyRef, covenantTemplates: templates, maxSubsequentDueDays: maxDays });
}

// =============================================================================
// Pack items
// =============================================================================

interface Added {
  readonly addedBy: string;
  readonly addedAtEpochSeconds: bigint;
  readonly withdrawnBy?: string;
}

export interface Condition extends Added {
  readonly conditionId: string;
  readonly kind: 'PRECEDENT' | 'SUBSEQUENT';
  readonly textEn: string;
  readonly textAr: string;
  /** SUBSEQUENT only: within how many days of first drawdown it must be met. */
  readonly dueDaysAfterDisbursement?: number;
}

export interface Covenant extends Added {
  readonly covenantId: string;
  readonly template: CovenantTemplate;
}

export interface Justification {
  readonly text: string;
  readonly by: string;
  readonly atEpochSeconds: bigint;
}

export interface Deviation {
  /** The assessment's route-reason code, e.g. SCORE_BELOW_FLOOR or STP_AMOUNT_WITHIN_STP_MAXIMUM_NOT_MET. */
  readonly code: string;
  readonly detail: string;
  readonly justification?: Justification;
}

/** The route reasons that depart from policy. Straight through has none; a knock-out declines and is not overridable. */
export function deviationsOf(
  reasons: readonly RouteReason[],
  justifications: Readonly<Record<string, Justification>>,
): readonly Deviation[] {
  return reasons
    .filter((r) => r.code !== 'ALL_STP_CONDITIONS_MET' && r.code !== 'KNOCKOUT_FAILED')
    .map((r) => {
      const j = justifications[r.code];
      return { code: r.code, detail: r.detail, ...(j === undefined ? {} : { justification: j }) };
    });
}

export function validateJustification(text: string): Result<string> {
  const t = text.trim();
  if (t.length < 10 || t.length > 1000)
    return bad('JUSTIFICATION_LENGTH', 'A justification states the mitigant in 10 to 1000 characters');
  if (containsIdentityNumber(t))
    return bad('IDENTITY_NUMBER_IN_FREE_TEXT', 'No identity number belongs in a justification');
  return ok(t);
}

export interface ConditionEntry {
  readonly kind: string;
  readonly textEn: string;
  readonly textAr: string;
  readonly dueDaysAfterDisbursement?: number;
}

export function validateCondition(
  e: ConditionEntry,
  policy: DecisionPackPolicy,
): Result<Omit<Condition, 'conditionId' | keyof Added>> {
  if (e.kind !== 'PRECEDENT' && e.kind !== 'SUBSEQUENT')
    return bad('CONDITION_KIND_INVALID', 'A condition is precedent or subsequent');
  const en = e.textEn.trim();
  const ar = e.textAr.trim();
  if (en.length < 3 || en.length > 300 || ar.length < 3 || ar.length > 300)
    return bad('CONDITION_TEXT_INVALID', 'State the condition in both languages, 3 to 300 characters each');
  if (ARABIC_LETTER.test(en) || !ARABIC_LETTER.test(ar))
    return bad('CONDITION_TEXT_INVALID', 'The English text is in English and the Arabic text in Arabic');
  if (containsIdentityNumber(en) || containsIdentityNumber(ar))
    return bad('IDENTITY_NUMBER_IN_FREE_TEXT', 'No identity number belongs in a condition');
  if (e.kind === 'SUBSEQUENT') {
    const d = e.dueDaysAfterDisbursement;
    if (d === undefined || !Number.isInteger(d) || d < 1 || d > policy.maxSubsequentDueDays)
      return bad('CONDITION_DUE_INVALID', 'A condition subsequent is due a whole number of days after drawdown', {
        maxDays: String(policy.maxSubsequentDueDays),
      });
    return ok({ kind: 'SUBSEQUENT', textEn: en, textAr: ar, dueDaysAfterDisbursement: d });
  }
  if (e.dueDaysAfterDisbursement !== undefined)
    return bad('CONDITION_DUE_INVALID', 'A condition precedent is met before drawdown and has no due days');
  return ok({ kind: 'PRECEDENT', textEn: en, textAr: ar });
}

export function covenantTemplate(policy: DecisionPackPolicy, code: string): Result<CovenantTemplate> {
  const t = policy.covenantTemplates.find((x) => x.code === code);
  return t === undefined ? bad('COVENANT_UNKNOWN', 'Choose a covenant from the institution’s list', { code }) : ok(t);
}

const live = (i: Added): boolean => i.withdrawnBy === undefined;

/** How many conditions and covenants the facility carries now, against the risk band's maximum. */
export function attachedCount(conditions: readonly Condition[], covenants: readonly Covenant[]): number {
  return conditions.filter(live).length + covenants.filter(live).length;
}

// =============================================================================
// Freezing
// =============================================================================

export interface PackContent {
  readonly applicationId: string;
  readonly assessmentRef: string;
  readonly deviations: readonly Deviation[];
  readonly conditions: readonly Condition[];
  readonly covenants: readonly Covenant[];
}

/** JSON with keys sorted at every level and bigints as decimal strings: one byte sequence per pack. */
function canonical(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object')
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** The SHA-256 of what the decision rests on: the live items only, so a withdrawn one changes nothing. */
export function packDigest(p: PackContent): string {
  return createHash('sha256')
    .update(
      canonical({
        applicationId: p.applicationId,
        assessmentRef: p.assessmentRef,
        deviations: p.deviations,
        conditions: p.conditions.filter(live),
        covenants: p.covenants.filter(live),
      }),
      'utf8',
    )
    .digest('hex');
}
