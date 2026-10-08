/**
 * SME credit assessment: knock-outs, a sectioned weighted scorecard, a risk
 * level with risk-aligned terms, and the approval route (straight-through or
 * credit committee).
 *
 * Everything that decides an outcome is the institution's credit policy,
 * parsed strictly from configuration: which facts are read, every knock-out
 * threshold, every section and criterion weight, every scoring band, every
 * risk band and its terms, and the straight-through conditions. Nothing here
 * encodes a threshold. A policy carries `source: 'TENANT_CREDIT_POLICY'` and a
 * `policyRef` on every threshold-bearing element, so a screen or an audit pack
 * can say whose figure each one is (and say "illustrative" when it is).
 *
 * Integers only. Facts are `bigint` (ratios per ten thousand, so 14000 = 1.40×
 * and 388 = 3.88%), `boolean`, or a code string. Weights and scores are per ten
 * thousand. The cumulative score is computed in one step from the full product
 * of weights and scores and rounded down once, so it never carries the error
 * of rounding each section first.
 *
 * The result is the trace a reviewer reads: every knock-out with its threshold,
 * actual value and pass/fail; every criterion with its input, the band chosen,
 * its score and risk label; every straight-through check. The trace is a
 * result, not a log line, and a rejection's context never carries a fact's
 * value (it may be personal data); it names the fact only.
 */

import { CURRENCY_CODES, type CurrencyCode, type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

// ------------------------------------------------------------------- types

export type FactValue = bigint | boolean | string;
/** Named facts from the bureau, the financial analysis and the application. */
export type SmeAssessmentFacts = Readonly<Record<string, FactValue>>;
export type FactType = 'INTEGER' | 'BOOLEAN' | 'CODE';
export type Operator = 'GTE' | 'LTE' | 'GT' | 'LT' | 'EQ';
/** `ANY` matches everything; allowed only as a criterion's last band. */
export type BandOperator = Operator | 'ANY';
export type CriterionRisk = 'LOW' | 'MODERATE' | 'HIGH';
export type AssessmentOutcome = 'STRAIGHT_THROUGH' | 'COMMITTEE' | 'REFER' | 'DECLINE';

export const OPERATORS: readonly Operator[] = ['GTE', 'LTE', 'GT', 'LT', 'EQ'];
export const CRITERION_RISKS: readonly CriterionRisk[] = ['LOW', 'MODERATE', 'HIGH'];

export interface Bilingual {
  readonly en: string;
  readonly ar: string;
}

export interface KnockoutRule {
  readonly code: string;
  readonly fact: string;
  readonly operator: Operator;
  readonly threshold: FactValue;
  readonly label: Bilingual;
  readonly policyRef: string;
}

export interface ScoreBand {
  readonly operator: BandOperator;
  /** Absent only for `ANY`. */
  readonly threshold?: FactValue;
  readonly scorePerTenThousand: number;
  readonly risk: CriterionRisk;
  readonly label: Bilingual;
}

export interface Criterion {
  readonly code: string;
  readonly fact: string;
  /** Weight within its section; a section's criteria sum to 10000. */
  readonly weightPerTenThousand: number;
  /** Evaluated in order; the first that matches is chosen. The last is `ANY`. */
  readonly bands: readonly ScoreBand[];
  readonly label: Bilingual;
  readonly policyRef: string;
}

export interface ScorecardSection {
  readonly code: string;
  /** Weight in the cumulative score; sections sum to 10000. */
  readonly weightPerTenThousand: number;
  readonly label: Bilingual;
  readonly criteria: readonly Criterion[];
}

export interface RiskAlignedTerms {
  readonly maxFinancing: Money;
  readonly minEquityContributionPerTenThousand: number;
  /** How many conditions and covenants the facility may carry at this risk level. */
  readonly maxConditions: number;
}

export interface RiskBand {
  readonly level: string;
  /** Inclusive lower bound on the cumulative score. Bands are strictly descending. */
  readonly minScorePerTenThousand: number;
  readonly label: Bilingual;
  readonly terms: RiskAlignedTerms;
  readonly policyRef: string;
}

export interface StraightThroughRule {
  readonly maxFinancing: Money;
  readonly allowedRiskLevels: readonly string[];
  readonly minCollateralCoveragePerTenThousand: number;
  readonly collateralCoverageFact: string;
  readonly policyRef: string;
}

export interface SmeAssessmentPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly currency: CurrencyCode;
  readonly effectiveFromEpochSeconds: bigint;
  readonly source: 'TENANT_CREDIT_POLICY';
  readonly policyRef: string;
  readonly facts: Readonly<Record<string, FactType>>;
  readonly knockouts: readonly KnockoutRule[];
  readonly sections: readonly ScorecardSection[];
  readonly riskBands: readonly RiskBand[];
  /** What happens when the cumulative score is below the lowest risk band. */
  readonly belowFloorOutcome: 'DECLINE' | 'REFER';
  /** The fact compared with a risk band's minimum equity contribution. */
  readonly equityContributionFact: string;
  /** What happens when the request is outside its risk band's terms. */
  readonly outsideRiskAlignedTerms: 'DECLINE' | 'COMMITTEE';
  readonly straightThrough: StraightThroughRule;
}

// ------------------------------------------------------------------- trace

export interface KnockoutTrace {
  readonly code: string;
  readonly fact: string;
  readonly operator: Operator;
  readonly threshold: FactValue;
  readonly actual: FactValue;
  readonly passed: boolean;
  readonly label: Bilingual;
  readonly policyRef: string;
}

export interface CriterionTrace {
  readonly code: string;
  readonly fact: string;
  readonly input: FactValue;
  readonly bandIndex: number;
  readonly band: Bilingual;
  readonly scorePerTenThousand: bigint;
  readonly risk: CriterionRisk;
  readonly weightPerTenThousand: bigint;
  readonly label: Bilingual;
}

export interface SectionTrace {
  readonly code: string;
  readonly label: Bilingual;
  readonly weightPerTenThousand: bigint;
  /** Rounded down. */
  readonly scorePerTenThousand: bigint;
  readonly criteria: readonly CriterionTrace[];
}

export interface ScorecardTrace {
  readonly sections: readonly SectionTrace[];
  /** Computed from the unrounded products, rounded down once. */
  readonly cumulativeScorePerTenThousand: bigint;
}

export interface StraightThroughCheck {
  readonly check: 'AMOUNT_WITHIN_STP_MAXIMUM' | 'RISK_LEVEL_ALLOWED' | 'COLLATERAL_COVERAGE_MINIMUM';
  readonly required: string;
  readonly actual: string;
  readonly passed: boolean;
}

export interface RouteReason {
  readonly code: string;
  readonly detail: string;
}

export interface SmeAssessment {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyRef: string;
  readonly outcome: AssessmentOutcome;
  readonly knockouts: readonly KnockoutTrace[];
  readonly failedKnockouts: readonly string[];
  /** Absent when a knock-out failed: nothing below a knock-out runs. */
  readonly scorecard?: ScorecardTrace;
  /** Absent when declined at knock-out or scored below the floor. */
  readonly riskLevel?: string;
  readonly riskLabel?: Bilingual;
  readonly terms?: RiskAlignedTerms;
  readonly straightThroughChecks: readonly StraightThroughCheck[];
  readonly reasons: readonly RouteReason[];
}

// ------------------------------------------------------------------- parse

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPerTenThousand = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 10_000;
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(v);
const isPolicyRef = (v: unknown): v is string => typeof v === 'string' && v.trim().length >= 3;

type Bad = Result<never>;
const bad = (reason: string, detail: string, context?: Readonly<Record<string, string>>): Bad =>
  reject('OP-DETERMINACY', reason, detail, context);

function unknownKeys(raw: Record<string, unknown>, allowed: readonly string[], where: string): Bad | undefined {
  const extra = Object.keys(raw).filter((k) => !allowed.includes(k));
  return extra.length > 0
    ? bad('SME_ASSESSMENT_UNKNOWN_KEY', `Unknown key in ${where}`, { keys: extra.join(','), where })
    : undefined;
}

function parseLabel(raw: unknown, where: string): Result<Bilingual> {
  if (!isRecord(raw) || !isNonEmpty(raw['en']) || !isNonEmpty(raw['ar']) || Object.keys(raw).length !== 2) {
    return bad('SME_ASSESSMENT_LABEL', 'A label carries exactly en and ar, both non-empty', { where });
  }
  return ok({ en: raw['en'], ar: raw['ar'] });
}

/** An integer threshold is a JSON safe integer or a string of digits; never a fraction. */
function parseThreshold(raw: unknown, type: FactType, where: string): Result<FactValue> {
  if (type === 'INTEGER') {
    if (typeof raw === 'number' && Number.isSafeInteger(raw)) return ok(BigInt(raw));
    if (typeof raw === 'string' && /^-?\d+$/.test(raw)) return ok(BigInt(raw));
    return bad('SME_ASSESSMENT_THRESHOLD', 'An integer threshold is a whole number', { where });
  }
  if (type === 'BOOLEAN')
    return typeof raw === 'boolean'
      ? ok(raw)
      : bad('SME_ASSESSMENT_THRESHOLD', 'A flag threshold is true or false', { where });
  return isNonEmpty(raw)
    ? ok(raw)
    : bad('SME_ASSESSMENT_THRESHOLD', 'A code threshold is a non-empty string', { where });
}

function operatorFits(op: Operator, type: FactType): boolean {
  return type === 'INTEGER' || op === 'EQ';
}

function factTypeOf(facts: Readonly<Record<string, FactType>>, name: unknown, where: string): Result<FactType> {
  if (typeof name !== 'string' || !Object.hasOwn(facts, name))
    return bad('SME_ASSESSMENT_UNDECLARED_FACT', 'Every fact a rule reads is declared in facts', { where });
  return ok(facts[name] as FactType);
}

function parseKnockout(raw: unknown, facts: Readonly<Record<string, FactType>>, i: number): Result<KnockoutRule> {
  const where = `knockouts[${String(i)}]`;
  if (!isRecord(raw)) return bad('SME_ASSESSMENT_KNOCKOUT', 'A knock-out is an object', { where });
  const extra = unknownKeys(raw, ['code', 'fact', 'operator', 'threshold', 'label', 'policyRef'], where);
  if (extra) return extra;
  if (!isCode(raw['code'])) return bad('SME_ASSESSMENT_KNOCKOUT', 'A knock-out has a code', { where });
  const type = factTypeOf(facts, raw['fact'], where);
  if (!type.ok) return type;
  const op = raw['operator'];
  if (!OPERATORS.includes(op as Operator) || !operatorFits(op as Operator, type.value))
    return bad(
      'SME_ASSESSMENT_OPERATOR',
      'The operator is one of GTE, LTE, GT, LT, EQ, and only EQ for a flag or code',
      { where },
    );
  const threshold = parseThreshold(raw['threshold'], type.value, where);
  if (!threshold.ok) return threshold;
  const label = parseLabel(raw['label'], where);
  if (!label.ok) return label;
  if (!isPolicyRef(raw['policyRef']))
    return bad('SME_ASSESSMENT_POLICY_REF', 'Every knock-out names the policy its threshold comes from', { where });
  return ok({
    code: raw['code'],
    fact: raw['fact'] as string,
    operator: op as Operator,
    threshold: threshold.value,
    label: label.value,
    policyRef: raw['policyRef'],
  });
}

function parseBand(raw: unknown, type: FactType, where: string, last: boolean): Result<ScoreBand> {
  if (!isRecord(raw)) return bad('SME_ASSESSMENT_BAND', 'A band is an object', { where });
  const extra = unknownKeys(raw, ['operator', 'threshold', 'scorePerTenThousand', 'risk', 'label'], where);
  if (extra) return extra;
  const op = raw['operator'];
  if (op === 'ANY') {
    if (!last) return bad('SME_ASSESSMENT_BAND_ORDER', 'ANY is allowed only as the last band', { where });
    if (raw['threshold'] !== undefined) return bad('SME_ASSESSMENT_BAND', 'An ANY band has no threshold', { where });
  } else {
    if (last)
      return bad('SME_ASSESSMENT_BAND_ORDER', 'The last band is ANY, so every input lands in a band', { where });
    if (!OPERATORS.includes(op as Operator) || !operatorFits(op as Operator, type))
      return bad(
        'SME_ASSESSMENT_OPERATOR',
        'The operator is one of GTE, LTE, GT, LT, EQ, ANY, and only EQ for a flag or code',
        { where },
      );
  }
  if (!isPerTenThousand(raw['scorePerTenThousand']))
    return bad('SME_ASSESSMENT_SCORE', 'A band score is a whole number in [0, 10000]', { where });
  if (!CRITERION_RISKS.includes(raw['risk'] as CriterionRisk))
    return bad('SME_ASSESSMENT_RISK', 'A band risk is LOW, MODERATE or HIGH', { where });
  const label = parseLabel(raw['label'], where);
  if (!label.ok) return label;
  let threshold: FactValue | undefined;
  if (op !== 'ANY') {
    const t = parseThreshold(raw['threshold'], type, where);
    if (!t.ok) return t;
    threshold = t.value;
  }
  return ok({
    operator: op as BandOperator,
    ...(threshold === undefined ? {} : { threshold }),
    scorePerTenThousand: raw['scorePerTenThousand'],
    risk: raw['risk'] as CriterionRisk,
    label: label.value,
  });
}

function parseCriterion(raw: unknown, facts: Readonly<Record<string, FactType>>, where: string): Result<Criterion> {
  if (!isRecord(raw)) return bad('SME_ASSESSMENT_CRITERION', 'A criterion is an object', { where });
  const extra = unknownKeys(raw, ['code', 'fact', 'weightPerTenThousand', 'bands', 'label', 'policyRef'], where);
  if (extra) return extra;
  if (!isCode(raw['code'])) return bad('SME_ASSESSMENT_CRITERION', 'A criterion has a code', { where });
  const type = factTypeOf(facts, raw['fact'], where);
  if (!type.ok) return type;
  if (!isPerTenThousand(raw['weightPerTenThousand']) || raw['weightPerTenThousand'] === 0)
    return bad('SME_ASSESSMENT_WEIGHT', 'A criterion weight is a whole number in (0, 10000]', { where });
  const rawBands = raw['bands'];
  if (!Array.isArray(rawBands) || rawBands.length === 0)
    return bad('SME_ASSESSMENT_BAND', 'A criterion has one or more bands', { where });
  const bands: ScoreBand[] = [];
  for (const [i, b] of rawBands.entries()) {
    const band = parseBand(b, type.value, `${where}.bands[${String(i)}]`, i === rawBands.length - 1);
    if (!band.ok) return band;
    bands.push(band.value);
  }
  const label = parseLabel(raw['label'], where);
  if (!label.ok) return label;
  if (!isPolicyRef(raw['policyRef']))
    return bad('SME_ASSESSMENT_POLICY_REF', 'Every criterion names the policy its bands come from', { where });
  return ok({
    code: raw['code'],
    fact: raw['fact'] as string,
    weightPerTenThousand: raw['weightPerTenThousand'],
    bands,
    label: label.value,
    policyRef: raw['policyRef'],
  });
}

function parseSection(raw: unknown, facts: Readonly<Record<string, FactType>>, i: number): Result<ScorecardSection> {
  const where = `sections[${String(i)}]`;
  if (!isRecord(raw)) return bad('SME_ASSESSMENT_SECTION', 'A section is an object', { where });
  const extra = unknownKeys(raw, ['code', 'weightPerTenThousand', 'label', 'criteria'], where);
  if (extra) return extra;
  if (!isCode(raw['code'])) return bad('SME_ASSESSMENT_SECTION', 'A section has a code', { where });
  if (!isPerTenThousand(raw['weightPerTenThousand']) || raw['weightPerTenThousand'] === 0)
    return bad('SME_ASSESSMENT_WEIGHT', 'A section weight is a whole number in (0, 10000]', { where });
  const label = parseLabel(raw['label'], where);
  if (!label.ok) return label;
  const rawCriteria = raw['criteria'];
  if (!Array.isArray(rawCriteria) || rawCriteria.length === 0)
    return bad('SME_ASSESSMENT_CRITERION', 'A section has one or more criteria', { where });
  const criteria: Criterion[] = [];
  for (const [j, c] of rawCriteria.entries()) {
    const criterion = parseCriterion(c, facts, `${where}.criteria[${String(j)}]`);
    if (!criterion.ok) return criterion;
    criteria.push(criterion.value);
  }
  const weightSum = criteria.reduce((s, c) => s + c.weightPerTenThousand, 0);
  if (weightSum !== 10_000)
    return bad('SME_ASSESSMENT_WEIGHTS_NOT_WHOLE', 'A section’s criterion weights sum to 10000', {
      where,
      sum: String(weightSum),
    });
  return ok({ code: raw['code'], weightPerTenThousand: raw['weightPerTenThousand'], label: label.value, criteria });
}

function parseMinorUnits(raw: unknown, currency: CurrencyCode, where: string): Result<Money> {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw) || BigInt(raw) <= 0n)
    return bad('SME_ASSESSMENT_AMOUNT', 'An amount is a positive integer string of minor units', { where });
  return ok(money(BigInt(raw), currency));
}

function parseRiskBand(raw: unknown, currency: CurrencyCode, i: number): Result<RiskBand> {
  const where = `riskBands[${String(i)}]`;
  if (!isRecord(raw)) return bad('SME_ASSESSMENT_RISK_BAND', 'A risk band is an object', { where });
  const extra = unknownKeys(raw, ['level', 'minScorePerTenThousand', 'label', 'terms', 'policyRef'], where);
  if (extra) return extra;
  if (typeof raw['level'] !== 'string' || !/^[A-Z][A-Z_]*$/.test(raw['level']))
    return bad('SME_ASSESSMENT_RISK_BAND', 'A risk level is an upper-case code', { where });
  if (!isPerTenThousand(raw['minScorePerTenThousand']))
    return bad('SME_ASSESSMENT_RISK_BAND', 'A risk band minimum is a whole number in [0, 10000]', { where });
  const label = parseLabel(raw['label'], where);
  if (!label.ok) return label;
  const t = raw['terms'];
  if (!isRecord(t)) return bad('SME_ASSESSMENT_TERMS', 'A risk band carries its terms', { where });
  const extraT = unknownKeys(
    t,
    ['maxFinancingMinorUnits', 'minEquityContributionPerTenThousand', 'maxConditions'],
    `${where}.terms`,
  );
  if (extraT) return extraT;
  const max = parseMinorUnits(t['maxFinancingMinorUnits'], currency, `${where}.terms`);
  if (!max.ok) return max;
  if (!isPerTenThousand(t['minEquityContributionPerTenThousand']))
    return bad('SME_ASSESSMENT_TERMS', 'minEquityContributionPerTenThousand is a whole number in [0, 10000]', {
      where,
    });
  const conditions = t['maxConditions'];
  if (typeof conditions !== 'number' || !Number.isInteger(conditions) || conditions < 0 || conditions > 100)
    return bad('SME_ASSESSMENT_TERMS', 'maxConditions is a whole number in [0, 100]', { where });
  if (!isPolicyRef(raw['policyRef']))
    return bad('SME_ASSESSMENT_POLICY_REF', 'Every risk band names the policy its terms come from', { where });
  return ok({
    level: raw['level'],
    minScorePerTenThousand: raw['minScorePerTenThousand'],
    label: label.value,
    terms: {
      maxFinancing: max.value,
      minEquityContributionPerTenThousand: t['minEquityContributionPerTenThousand'],
      maxConditions: conditions,
    },
    policyRef: raw['policyRef'],
  });
}

const FACT_TYPES: readonly FactType[] = ['INTEGER', 'BOOLEAN', 'CODE'];

export function parseSmeAssessmentPolicy(raw: unknown): Result<SmeAssessmentPolicy> {
  if (!isRecord(raw)) return bad('SME_ASSESSMENT_MALFORMED', 'The SME assessment policy is an object');
  const extra = unknownKeys(
    raw,
    [
      'policyId',
      'version',
      'currency',
      'effectiveFromEpochSeconds',
      'source',
      'policyRef',
      'notes',
      'facts',
      'knockouts',
      'sections',
      'riskBands',
      'belowFloorOutcome',
      'equityContributionFact',
      'outsideRiskAlignedTerms',
      'straightThrough',
    ],
    'the policy',
  );
  if (extra) return extra;
  if (!isNonEmpty(raw['policyId']) || !isNonEmpty(raw['version']))
    return bad('SME_ASSESSMENT_IDENTITY', 'The policy has a policyId and a version');
  const currency = raw['currency'];
  if (!CURRENCY_CODES.includes(currency as CurrencyCode))
    return bad('SME_ASSESSMENT_CURRENCY', 'currency is one of the supported currency codes');
  const eff = raw['effectiveFromEpochSeconds'];
  if (typeof eff !== 'string' || !/^\d+$/.test(eff))
    return bad('SME_ASSESSMENT_EFFECTIVE', 'effectiveFromEpochSeconds is an integer string');
  if (raw['source'] !== 'TENANT_CREDIT_POLICY')
    return bad(
      'SME_ASSESSMENT_SOURCE',
      "source is 'TENANT_CREDIT_POLICY': these thresholds are the institution's, and say so",
    );
  if (!isPolicyRef(raw['policyRef']))
    return bad('SME_ASSESSMENT_POLICY_REF', 'policyRef names the credit policy and version');
  if (raw['notes'] !== undefined && typeof raw['notes'] !== 'string')
    return bad('SME_ASSESSMENT_MALFORMED', 'notes is text');

  const rawFacts = raw['facts'];
  if (!isRecord(rawFacts) || Object.keys(rawFacts).length === 0)
    return bad('SME_ASSESSMENT_FACTS', 'facts declares each fact the policy reads and its type');
  const facts: Record<string, FactType> = {};
  for (const [name, type] of Object.entries(rawFacts)) {
    if (!isCode(name) || !FACT_TYPES.includes(type as FactType))
      return bad('SME_ASSESSMENT_FACTS', 'Each fact is a code typed INTEGER, BOOLEAN or CODE', { fact: name });
    facts[name] = type as FactType;
  }

  const rawKnockouts = raw['knockouts'];
  if (!Array.isArray(rawKnockouts)) return bad('SME_ASSESSMENT_KNOCKOUT', 'knockouts is a list (possibly empty)');
  const knockouts: KnockoutRule[] = [];
  for (const [i, k] of rawKnockouts.entries()) {
    const knockout = parseKnockout(k, facts, i);
    if (!knockout.ok) return knockout;
    knockouts.push(knockout.value);
  }
  if (new Set(knockouts.map((k) => k.code)).size !== knockouts.length)
    return bad('SME_ASSESSMENT_DUPLICATE_CODE', 'Knock-out codes are unique');

  const rawSections = raw['sections'];
  if (!Array.isArray(rawSections) || rawSections.length === 0)
    return bad('SME_ASSESSMENT_SECTION', 'sections lists one or more scorecard sections');
  const sections: ScorecardSection[] = [];
  for (const [i, s] of rawSections.entries()) {
    const section = parseSection(s, facts, i);
    if (!section.ok) return section;
    sections.push(section.value);
  }
  const sectionSum = sections.reduce((s, x) => s + x.weightPerTenThousand, 0);
  if (sectionSum !== 10_000)
    return bad('SME_ASSESSMENT_WEIGHTS_NOT_WHOLE', 'Section weights sum to 10000', {
      where: 'sections',
      sum: String(sectionSum),
    });
  const criterionCodes = sections.flatMap((s) => s.criteria.map((c) => c.code));
  if (
    new Set(sections.map((s) => s.code)).size !== sections.length ||
    new Set(criterionCodes).size !== criterionCodes.length
  )
    return bad('SME_ASSESSMENT_DUPLICATE_CODE', 'Section and criterion codes are unique');

  const rawRisk = raw['riskBands'];
  if (!Array.isArray(rawRisk) || rawRisk.length === 0)
    return bad('SME_ASSESSMENT_RISK_BAND', 'riskBands lists one or more risk levels');
  const riskBands: RiskBand[] = [];
  for (const [i, r] of rawRisk.entries()) {
    const band = parseRiskBand(r, currency as CurrencyCode, i);
    if (!band.ok) return band;
    const prev = riskBands[riskBands.length - 1];
    if (prev !== undefined && band.value.minScorePerTenThousand >= prev.minScorePerTenThousand)
      return bad(
        'SME_ASSESSMENT_RISK_BAND_ORDER',
        'Risk bands are listed from best to worst with strictly descending minimums',
        { where: `riskBands[${String(i)}]` },
      );
    riskBands.push(band.value);
  }
  if (new Set(riskBands.map((r) => r.level)).size !== riskBands.length)
    return bad('SME_ASSESSMENT_DUPLICATE_CODE', 'Risk levels are unique');

  const floor = raw['belowFloorOutcome'];
  if (floor !== 'DECLINE' && floor !== 'REFER')
    return bad('SME_ASSESSMENT_FLOOR', 'belowFloorOutcome is DECLINE or REFER');
  const outside = raw['outsideRiskAlignedTerms'];
  if (outside !== 'DECLINE' && outside !== 'COMMITTEE')
    return bad('SME_ASSESSMENT_OUTSIDE_TERMS', 'outsideRiskAlignedTerms is DECLINE or COMMITTEE');
  const equityFact = raw['equityContributionFact'];
  if (typeof equityFact !== 'string' || facts[equityFact] !== 'INTEGER')
    return bad('SME_ASSESSMENT_UNDECLARED_FACT', 'equityContributionFact names a declared INTEGER fact');

  const stp = raw['straightThrough'];
  if (!isRecord(stp)) return bad('SME_ASSESSMENT_STP', 'straightThrough states the straight-through conditions');
  const extraS = unknownKeys(
    stp,
    [
      'maxFinancingMinorUnits',
      'allowedRiskLevels',
      'minCollateralCoveragePerTenThousand',
      'collateralCoverageFact',
      'policyRef',
    ],
    'straightThrough',
  );
  if (extraS) return extraS;
  const stpMax = parseMinorUnits(stp['maxFinancingMinorUnits'], currency as CurrencyCode, 'straightThrough');
  if (!stpMax.ok) return stpMax;
  const levels = stp['allowedRiskLevels'];
  if (!Array.isArray(levels) || levels.length === 0 || !levels.every((l) => riskBands.some((r) => r.level === l)))
    return bad('SME_ASSESSMENT_STP', 'allowedRiskLevels lists one or more of the policy’s risk levels');
  const minCover = stp['minCollateralCoveragePerTenThousand'];
  if (typeof minCover !== 'number' || !Number.isInteger(minCover) || minCover < 0 || minCover > 1_000_000)
    return bad('SME_ASSESSMENT_STP', 'minCollateralCoveragePerTenThousand is a whole number in [0, 1000000]');
  const coverFact = stp['collateralCoverageFact'];
  if (typeof coverFact !== 'string' || facts[coverFact] !== 'INTEGER')
    return bad('SME_ASSESSMENT_UNDECLARED_FACT', 'collateralCoverageFact names a declared INTEGER fact');
  if (!isPolicyRef(stp['policyRef']))
    return bad('SME_ASSESSMENT_POLICY_REF', 'The straight-through rule names the policy it comes from');

  return ok({
    policyId: raw['policyId'],
    version: raw['version'],
    currency: currency as CurrencyCode,
    effectiveFromEpochSeconds: BigInt(eff),
    source: 'TENANT_CREDIT_POLICY',
    policyRef: raw['policyRef'],
    facts,
    knockouts,
    sections,
    riskBands,
    belowFloorOutcome: floor,
    equityContributionFact: equityFact,
    outsideRiskAlignedTerms: outside,
    straightThrough: {
      maxFinancing: stpMax.value,
      allowedRiskLevels: levels as string[],
      minCollateralCoveragePerTenThousand: minCover,
      collateralCoverageFact: coverFact,
      policyRef: stp['policyRef'],
    },
  });
}

// ------------------------------------------------------------------ assess

function typeOfValue(v: FactValue): FactType {
  if (typeof v === 'bigint') return 'INTEGER';
  if (typeof v === 'boolean') return 'BOOLEAN';
  return 'CODE';
}

function compareFact(actual: FactValue, op: Operator, threshold: FactValue): boolean {
  if (op === 'EQ') return actual === threshold;
  if (typeof actual !== 'bigint' || typeof threshold !== 'bigint') return false;
  switch (op) {
    case 'GTE':
      return actual >= threshold;
    case 'LTE':
      return actual <= threshold;
    case 'GT':
      return actual > threshold;
    case 'LT':
      return actual < threshold;
  }
}

const render = (v: FactValue): string => (typeof v === 'string' ? v : String(v));

/**
 * Assess one SME application against the policy. A missing or mistyped fact
 * is refused (indeterminate), never defaulted: an assessment that guessed an
 * input is not an assessment.
 */
export function assessSme(
  policy: SmeAssessmentPolicy,
  facts: SmeAssessmentFacts,
  requested: Money,
): Result<SmeAssessment> {
  if (requested.currency !== policy.currency)
    return reject(
      'OP-DETERMINACY',
      'SME_ASSESSMENT_CURRENCY_MISMATCH',
      'The requested amount is not in the policy’s currency',
      { policyCurrency: policy.currency, requestCurrency: requested.currency },
    );
  if (requested.minorUnits <= 0n)
    return reject('OP-DETERMINACY', 'SME_ASSESSMENT_AMOUNT', 'The requested amount is positive');

  for (const [name, type] of Object.entries(policy.facts)) {
    if (!Object.hasOwn(facts, name))
      return reject('OP-DETERMINACY', 'SME_FACT_MISSING', 'A fact the policy reads is absent', { fact: name });
    const value = facts[name] as FactValue;
    if (typeOfValue(value) !== type)
      return reject('OP-DETERMINACY', 'SME_FACT_TYPE', 'A fact is not of the type the policy declares', {
        fact: name,
        expected: type,
      });
  }
  const fact = (name: string): FactValue => facts[name] as FactValue;

  const base = { policyId: policy.policyId, policyVersion: policy.version, policyRef: policy.policyRef };

  const knockouts: KnockoutTrace[] = policy.knockouts.map((k) => {
    const actual = fact(k.fact);
    return {
      code: k.code,
      fact: k.fact,
      operator: k.operator,
      threshold: k.threshold,
      actual,
      passed: compareFact(actual, k.operator, k.threshold),
      label: k.label,
      policyRef: k.policyRef,
    };
  });
  const failedKnockouts = knockouts.filter((k) => !k.passed).map((k) => k.code);
  if (failedKnockouts.length > 0) {
    return ok({
      ...base,
      outcome: 'DECLINE',
      knockouts,
      failedKnockouts,
      straightThroughChecks: [],
      reasons: failedKnockouts.map((code) => ({ code: 'KNOCKOUT_FAILED', detail: code })),
    });
  }

  // Scorecard. The cumulative numerator is Σ section weight × criterion weight × score,
  // over 10000³, so it is rounded once, down.
  let cumulativeNumerator = 0n;
  const sections: SectionTrace[] = policy.sections.map((section) => {
    let sectionNumerator = 0n;
    const criteria: CriterionTrace[] = section.criteria.map((c) => {
      const input = fact(c.fact);
      const bandIndex = c.bands.findIndex(
        (b) => b.operator === 'ANY' || compareFact(input, b.operator, b.threshold as FactValue),
      );
      // The parser guarantees a final ANY band, so a band is always found.
      const band = c.bands[bandIndex] as ScoreBand;
      const score = BigInt(band.scorePerTenThousand);
      const weight = BigInt(c.weightPerTenThousand);
      sectionNumerator += weight * score;
      return {
        code: c.code,
        fact: c.fact,
        input,
        bandIndex,
        band: band.label,
        scorePerTenThousand: score,
        risk: band.risk,
        weightPerTenThousand: weight,
        label: c.label,
      };
    });
    const sectionWeight = BigInt(section.weightPerTenThousand);
    cumulativeNumerator += sectionWeight * sectionNumerator;
    return {
      code: section.code,
      label: section.label,
      weightPerTenThousand: sectionWeight,
      scorePerTenThousand: sectionNumerator / 10_000n,
      criteria,
    };
  });
  const cumulative = cumulativeNumerator / 100_000_000n;
  const scorecard: ScorecardTrace = { sections, cumulativeScorePerTenThousand: cumulative };

  const riskBand = policy.riskBands.find((r) => cumulative >= BigInt(r.minScorePerTenThousand));
  if (riskBand === undefined) {
    const lowest = policy.riskBands[policy.riskBands.length - 1] as RiskBand;
    return ok({
      ...base,
      outcome: policy.belowFloorOutcome,
      knockouts,
      failedKnockouts,
      scorecard,
      straightThroughChecks: [],
      reasons: [
        {
          code: 'SCORE_BELOW_FLOOR',
          detail: `Cumulative score ${String(cumulative)} is below the lowest risk band minimum ${String(lowest.minScorePerTenThousand)}`,
        },
      ],
    });
  }

  const reasons: RouteReason[] = [];
  const terms = riskBand.terms;
  if (requested.minorUnits > terms.maxFinancing.minorUnits)
    reasons.push({
      code: 'ABOVE_RISK_ALIGNED_MAXIMUM',
      detail: `Requested ${String(requested.minorUnits)} exceeds the ${riskBand.level} maximum ${String(terms.maxFinancing.minorUnits)} (minor units)`,
    });
  const equity = fact(policy.equityContributionFact) as bigint;
  if (equity < BigInt(terms.minEquityContributionPerTenThousand))
    reasons.push({
      code: 'EQUITY_BELOW_RISK_ALIGNED_MINIMUM',
      detail: `Equity contribution ${String(equity)} is below the ${riskBand.level} minimum ${String(terms.minEquityContributionPerTenThousand)} per ten thousand`,
    });
  const outsideTerms = reasons.length > 0;

  const stp = policy.straightThrough;
  const cover = fact(stp.collateralCoverageFact) as bigint;
  const straightThroughChecks: StraightThroughCheck[] = [
    {
      check: 'AMOUNT_WITHIN_STP_MAXIMUM',
      required: `<= ${String(stp.maxFinancing.minorUnits)}`,
      actual: String(requested.minorUnits),
      passed: requested.minorUnits <= stp.maxFinancing.minorUnits,
    },
    {
      check: 'RISK_LEVEL_ALLOWED',
      required: stp.allowedRiskLevels.join('|'),
      actual: riskBand.level,
      passed: stp.allowedRiskLevels.includes(riskBand.level),
    },
    {
      check: 'COLLATERAL_COVERAGE_MINIMUM',
      required: `>= ${String(stp.minCollateralCoveragePerTenThousand)}`,
      actual: render(cover),
      passed: cover >= BigInt(stp.minCollateralCoveragePerTenThousand),
    },
  ];
  for (const c of straightThroughChecks) {
    if (!c.passed)
      reasons.push({
        code: `STP_${c.check}_NOT_MET`,
        detail: `${c.check}: required ${c.required}, actual ${c.actual}`,
      });
  }

  let outcome: AssessmentOutcome;
  if (outsideTerms && policy.outsideRiskAlignedTerms === 'DECLINE') outcome = 'DECLINE';
  else if (reasons.length === 0) {
    outcome = 'STRAIGHT_THROUGH';
    reasons.push({
      code: 'ALL_STP_CONDITIONS_MET',
      detail:
        'Within the straight-through maximum, an allowed risk level, the required collateral coverage and the risk-aligned terms',
    });
  } else outcome = 'COMMITTEE';

  return ok({
    ...base,
    outcome,
    knockouts,
    failedKnockouts,
    scorecard,
    riskLevel: riskBand.level,
    riskLabel: riskBand.label,
    terms,
    straightThroughChecks,
    reasons,
  });
}
