/**
 * Credit policy as versioned, effective-dated data.
 *
 * The institution's Credit function owns what is in here, and changes to it are
 * approved on the institution's own governance cycle rather than on our release
 * cycle (BR-C08). Nothing in this file encodes a threshold, a band or a cut-off;
 * this file describes the *shape* a policy takes and refuses one that is
 * internally inconsistent.
 *
 * Note what a policy cannot express: a price. A policy decides whether to lend
 * capacity and how much, and returns an outcome, a grade and a limit. The profit
 * on a transaction is an amount agreed at quotation and disclosed in the
 * instrument; it is not an output of the credit model, and there is no section
 * here in which someone could put one (SH-01, SH-15).
 */

import type { CurrencyCode } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import { type Expr, referencedFields } from './expression.ts';

export type DecisionOutcome = 'APPROVE' | 'REFER' | 'DECLINE';

/**
 * Reason wording. Authored by the institution in both languages, because a
 * decline reason is a regulated communication and is derived from the rule
 * trace rather than composed by hand at the point of refusal (BR-C04, RC-11).
 */
export interface ReasonText {
  readonly ar: string;
  readonly en: string;
}

/** A hard rule. Nothing below it runs if it fires. */
export interface Knockout {
  readonly code: string;
  readonly when: Expr;
  readonly outcome: 'DECLINE' | 'REFER';
  readonly reasonCode: string;
}

export interface ScoreBand {
  readonly when: Expr;
  readonly points: number;
  /** Surfaced where this band is the reason the application fell short. */
  readonly reasonCode?: string;
}

export interface Characteristic {
  readonly code: string;
  readonly maxPoints: number;
  /** First matching band wins. Order is significant and is preserved. */
  readonly bands: readonly ScoreBand[];
  /** Awarded where no band matches. */
  readonly defaultPoints: number;
  readonly defaultReasonCode?: string;
}

export interface Scorecard {
  readonly baseScore: number;
  readonly characteristics: readonly Characteristic[];
}

export interface GradeBand {
  readonly grade: string;
  /** Inclusive floor. Bands are checked from the highest floor downward. */
  readonly minScore: number;
  readonly outcome: DecisionOutcome;
  readonly reasonCode?: string;
}

export type LimitCap =
  | { readonly code: string; readonly kind: 'ABSOLUTE'; readonly maxMoneyMinorUnits: string }
  | { readonly code: string; readonly kind: 'EXPRESSION'; readonly max: Expr; readonly when?: Expr }
  /** Never more than the programme has left. */
  | { readonly code: string; readonly kind: 'PROGRAMME_HEADROOM' }
  /** Concentration: no counterparty takes more than a share of the programme. */
  | {
      readonly code: string;
      readonly kind: 'SHARE_OF_PROGRAMME_LIMIT';
      readonly shareBasisPoints: number;
    }
  /** Net the limit down by exposure the institution already carries. */
  | { readonly code: string; readonly kind: 'NET_OF_EXISTING_EXPOSURE' };

export interface LimitRule {
  /** Grade code to an expression yielding minor units. */
  readonly basisByGrade: Readonly<Record<string, Expr>>;
  /** Granularity, in minor units. The result rounds down to a multiple of this. */
  readonly roundDownToMultipleOfMinorUnits: string;
  /** Below this, an approval is not worth issuing; the case refers instead. */
  readonly minimumViableMinorUnits: string;
  /** Applied in declared order; the first binding cap is recorded. */
  readonly caps: readonly LimitCap[];
}

export interface DataRequirements {
  /** Consents without which the policy will not evaluate (RC-05). */
  readonly requiredConsents: readonly (keyof DataRequirementConsents)[];
  /**
   * Maximum age of each source, in seconds, keyed by the snapshot path of its
   * `retrievedSecondsAgo` field. Beyond it the data is stale and the case
   * refers rather than deciding on figures nobody stands behind (BR-B10).
   */
  readonly maximumSourceAgeSeconds: Readonly<Record<string, number>>;
  readonly staleDataReasonCode: string;
  readonly missingConsentReasonCode: string;
}

export interface DataRequirementConsents {
  readonly eInvoicing: boolean;
  readonly creditBureau: boolean;
  readonly openBanking: boolean;
  readonly workforce: boolean;
}

export interface PolicyApproval {
  readonly creditApprovalRef: string;
  readonly approvedByRole: string;
  readonly approvedOnEpochSeconds: string;
}

export interface CreditPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly tenantId: string;
  /** Programme ids this applies to, or `ALL`. */
  readonly programmeScope: readonly string[] | 'ALL';
  readonly currency: CurrencyCode;

  readonly effectiveFromEpochSeconds: string;
  readonly effectiveToEpochSeconds?: string;

  readonly approval: PolicyApproval;

  readonly dataRequirements: DataRequirements;
  readonly knockouts: readonly Knockout[];
  readonly scorecard: Scorecard;
  readonly grades: readonly GradeBand[];
  readonly limit: LimitRule;

  /** Every reason code the policy can emit, with its bilingual wording. */
  readonly reasons: Readonly<Record<string, ReasonText>>;

  /** Optional note for the audit pack. Not evaluated. */
  readonly notes?: string;
}

/** Sections a policy file may contain. Anything else is refused on load. */
const PERMITTED_SECTIONS = new Set([
  'policyId',
  'version',
  'tenantId',
  'programmeScope',
  'currency',
  'effectiveFromEpochSeconds',
  'effectiveToEpochSeconds',
  'approval',
  'dataRequirements',
  'knockouts',
  'scorecard',
  'grades',
  'limit',
  'reasons',
  'notes',
]);

/**
 * Validate a policy loaded from configuration.
 *
 * The important check is the last one: every reason code the policy can emit
 * has wording in both languages. A policy that can decline without being able
 * to say why does not load.
 */
export function parseCreditPolicy(input: unknown): Result<CreditPolicy> {
  if (typeof input !== 'object' || input === null) {
    return reject('OP-DETERMINACY', 'POLICY_NOT_AN_OBJECT', 'Credit policy is not an object');
  }
  const p = input as CreditPolicy;

  for (const key of Object.keys(input)) {
    if (!PERMITTED_SECTIONS.has(key)) {
      return reject(
        'OP-DETERMINACY',
        'UNKNOWN_POLICY_SECTION',
        'Credit policy contains a section the engine does not recognise; a policy decides capacity, never price',
        { section: key },
      );
    }
  }

  if (!p.approval?.creditApprovalRef) {
    return reject(
      'OP-DETERMINACY',
      'POLICY_NOT_APPROVED',
      'A credit policy must carry the approval reference it was signed off under',
      { policyId: String(p.policyId) },
    );
  }

  if (p.grades.length === 0) {
    return reject('OP-DETERMINACY', 'NO_GRADE_BANDS', 'A policy must declare at least one grade band');
  }

  const gradeCodes = new Set<string>();
  for (const g of p.grades) {
    if (gradeCodes.has(g.grade)) {
      return reject('OP-DETERMINACY', 'DUPLICATE_GRADE', 'Grade codes must be unique', {
        grade: g.grade,
      });
    }
    gradeCodes.add(g.grade);
  }

  // Every grade that can approve must have a way to size a limit.
  for (const g of p.grades) {
    if (g.outcome === 'APPROVE' && p.limit.basisByGrade[g.grade] === undefined) {
      return reject(
        'OP-DETERMINACY',
        'APPROVING_GRADE_HAS_NO_LIMIT_BASIS',
        'A grade that approves must declare how its limit is sized',
        { grade: g.grade },
      );
    }
  }

  // Scorecard sanity: no characteristic can award more than it declares.
  const seenCharacteristics = new Set<string>();
  for (const c of p.scorecard.characteristics) {
    if (seenCharacteristics.has(c.code)) {
      return reject('OP-DETERMINACY', 'DUPLICATE_CHARACTERISTIC', 'Characteristic codes must be unique', {
        code: c.code,
      });
    }
    seenCharacteristics.add(c.code);
    for (const b of c.bands) {
      if (b.points > c.maxPoints) {
        return reject(
          'OP-DETERMINACY',
          'BAND_EXCEEDS_CHARACTERISTIC_MAX',
          'A band awards more points than its characteristic declares',
          { code: c.code, points: b.points, maxPoints: c.maxPoints },
        );
      }
    }
  }

  const koCodes = new Set<string>();
  for (const k of p.knockouts) {
    if (koCodes.has(k.code)) {
      return reject('OP-DETERMINACY', 'DUPLICATE_KNOCKOUT', 'Knockout codes must be unique', {
        code: k.code,
      });
    }
    koCodes.add(k.code);
  }

  // Effective dating must be coherent.
  const from = safeBigInt(p.effectiveFromEpochSeconds);
  if (from === undefined) {
    return reject('OP-DETERMINACY', 'MALFORMED_EFFECTIVE_FROM', 'effectiveFromEpochSeconds is not an integer');
  }
  if (p.effectiveToEpochSeconds !== undefined) {
    const to = safeBigInt(p.effectiveToEpochSeconds);
    if (to === undefined || to <= from) {
      return reject(
        'OP-DETERMINACY',
        'EFFECTIVE_WINDOW_INVALID',
        'effectiveToEpochSeconds must be later than effectiveFromEpochSeconds',
      );
    }
  }

  // Every emittable reason code must have wording, in both languages.
  const missing: string[] = [];
  for (const code of emittableReasonCodes(p)) {
    const text = p.reasons[code];
    if (text === undefined || text.ar.trim().length === 0 || text.en.trim().length === 0) {
      missing.push(code);
    }
  }
  if (missing.length > 0) {
    return reject(
      'OP-DETERMINACY',
      'REASON_WORDING_MISSING',
      'Every reason the policy can emit must have approved Arabic and English wording; a decline the counterparty cannot be told the reason for is not issuable',
      { missing: missing.join(',') },
    );
  }

  return ok(p);
}

/** All reason codes reachable from this policy. */
export function emittableReasonCodes(p: CreditPolicy): readonly string[] {
  const codes = new Set<string>();
  for (const k of p.knockouts) codes.add(k.reasonCode);
  for (const c of p.scorecard.characteristics) {
    if (c.defaultReasonCode !== undefined) codes.add(c.defaultReasonCode);
    for (const b of c.bands) if (b.reasonCode !== undefined) codes.add(b.reasonCode);
  }
  for (const g of p.grades) if (g.reasonCode !== undefined) codes.add(g.reasonCode);
  codes.add(p.dataRequirements.staleDataReasonCode);
  codes.add(p.dataRequirements.missingConsentReasonCode);
  return [...codes].sort();
}

/** Every snapshot path the policy reads. Used to check policy against snapshot shape. */
export function policyReferencedFields(p: CreditPolicy): readonly string[] {
  const fields = new Set<string>();
  for (const k of p.knockouts) referencedFields(k.when, fields);
  for (const c of p.scorecard.characteristics) {
    for (const b of c.bands) referencedFields(b.when, fields);
  }
  for (const expr of Object.values(p.limit.basisByGrade)) referencedFields(expr, fields);
  for (const cap of p.limit.caps) {
    if (cap.kind === 'EXPRESSION') {
      referencedFields(cap.max, fields);
      if (cap.when !== undefined) referencedFields(cap.when, fields);
    }
  }
  for (const path of Object.keys(p.dataRequirements.maximumSourceAgeSeconds)) fields.add(path);
  return [...fields].sort();
}

/**
 * Pick the version in force at a given moment.
 *
 * `asOfEpochSeconds` is supplied by the caller — normally the snapshot's capture
 * time — so a historic decision replays against the policy that actually
 * governed it, not against whatever is current (DP-07).
 */
export function resolveEffectivePolicy(
  versions: readonly CreditPolicy[],
  asOfEpochSeconds: bigint,
): Result<CreditPolicy> {
  const inForce = versions
    .filter((v) => {
      const from = safeBigInt(v.effectiveFromEpochSeconds);
      if (from === undefined || from > asOfEpochSeconds) return false;
      if (v.effectiveToEpochSeconds === undefined) return true;
      const to = safeBigInt(v.effectiveToEpochSeconds);
      return to !== undefined && to > asOfEpochSeconds;
    })
    .sort((a, b) => {
      const af = safeBigInt(a.effectiveFromEpochSeconds) ?? 0n;
      const bf = safeBigInt(b.effectiveFromEpochSeconds) ?? 0n;
      return af === bf ? 0 : af < bf ? 1 : -1;
    });

  const latest = inForce[0];
  if (latest === undefined) {
    return reject(
      'OP-DETERMINACY',
      'NO_POLICY_IN_FORCE',
      'No credit policy version is in force for the moment being evaluated',
      { asOfEpochSeconds: String(asOfEpochSeconds) },
    );
  }
  if (inForce.length > 1) {
    const tied = inForce.filter(
      (v) => v.effectiveFromEpochSeconds === latest.effectiveFromEpochSeconds,
    );
    if (tied.length > 1) {
      return reject(
        'OP-DETERMINACY',
        'AMBIGUOUS_POLICY_VERSIONS',
        'More than one policy version shares the same effective date; the governing version is ambiguous',
        { policyId: latest.policyId, count: tied.length },
      );
    }
  }
  return ok(latest);
}

function safeBigInt(v: string): bigint | undefined {
  try {
    return BigInt(v);
  } catch {
    return undefined;
  }
}
