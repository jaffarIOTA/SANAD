/**
 * SME financial analysis — the figures read from an applicant's statements,
 * verified one by one by an officer, and the ratios computed from them.
 *
 * Where a figure comes from:
 *
 *   - OCR            read off an uploaded statement by the document service;
 *   - RAIL           returned by a data rail (a tax return, a bureau report);
 *   - OFFICER_ENTRY  keyed in by an officer from a document they hold.
 *
 * Every figure starts as a proposal and is usable only once an officer has
 * verified it. Verification records who and when. Where the officer corrects
 * the proposed value, both values are kept — the proposal is evidence of what
 * the machine read, the correction is what the decision uses — and the figure
 * says it was corrected. A figure keyed in by an officer is verified by a
 * different officer (four eyes).
 *
 * The source reference names the document or rail response; it never carries
 * the content. Rejections name metric codes, never the figures themselves: an
 * owner's salary is a personal datum and does not belong in an error body.
 *
 * Ratios are integers per ten thousand (10 000 = 1.00x = 100%), computed in
 * bigint, each recorded with its formula, inputs and rounding direction.
 * Rounding is always in the prudent direction for a credit decision:
 *
 *   - a cover, liquidity, growth or margin ratio rounds DOWN (towards −∞), so
 *     capacity is never overstated;
 *   - a burden ratio (the owner's debt burden) rounds UP, so burden is never
 *     understated.
 *
 * Division by zero, or by a negative denominator, is a typed refusal, never
 * Infinity and never a sign flip.
 *
 * Pure. No clock: instants are passed in. No throws for domain refusals.
 */

import type { CurrencyCode, Money } from '../kernel/money.ts';
import type { BusinessFacts } from '../products/module.ts';
import { type Result, ok, reject } from '../kernel/result.ts';

// --------------------------------------------------------------------- metrics

export type FinancialMetric =
  | 'ANNUAL_REVENUE'
  | 'PRIOR_YEAR_REVENUE'
  | 'NET_PROFIT'
  | 'TOTAL_DEBT_SERVICE'
  | 'CURRENT_ASSETS'
  | 'CURRENT_LIABILITIES'
  // Owner-level, for the owner's debt burden ratio.
  | 'MONTHLY_GROSS_SALARY'
  | 'MONTHLY_DEBT_OBLIGATIONS';

export const FINANCIAL_METRICS: readonly FinancialMetric[] = [
  'ANNUAL_REVENUE',
  'PRIOR_YEAR_REVENUE',
  'NET_PROFIT',
  'TOTAL_DEBT_SERVICE',
  'CURRENT_ASSETS',
  'CURRENT_LIABILITIES',
  'MONTHLY_GROSS_SALARY',
  'MONTHLY_DEBT_OBLIGATIONS',
];

/** Net profit may be a loss. Every other metric is a non-negative amount. */
const MAY_BE_NEGATIVE: ReadonlySet<FinancialMetric> = new Set<FinancialMetric>(['NET_PROFIT']);

export type FigureSourceKind = 'OCR' | 'RAIL' | 'OFFICER_ENTRY';
export const FIGURE_SOURCE_KINDS: readonly FigureSourceKind[] = ['OCR', 'RAIL', 'OFFICER_ENTRY'];

// --------------------------------------------------------------------- figures

export interface FigureProposal {
  readonly metric: FinancialMetric;
  /** The period the figure covers, e.g. `FY2025` or `2026-09`. A label, not a date with contractual effect. */
  readonly periodLabel: string;
  readonly value: Money;
  readonly sourceKind: FigureSourceKind;
  /** The document id or rail reference the figure was read from. Never the content. */
  readonly sourceRef: string;
  /** The principal who keyed the figure in — required for OFFICER_ENTRY, absent otherwise. */
  readonly enteredBy?: string;
  readonly proposedAtEpochSeconds: bigint;
}

export interface FigureVerification {
  /** The value the decision uses: the proposal, or the officer's correction of it. */
  readonly value: Money;
  readonly verifiedBy: string;
  readonly verifiedAtEpochSeconds: bigint;
  /** True when the officer changed the proposed (OCR, rail or keyed) value. The proposal is kept. */
  readonly correctedFromProposal: boolean;
}

export interface FinancialFigure {
  readonly metric: FinancialMetric;
  readonly periodLabel: string;
  readonly sourceKind: FigureSourceKind;
  readonly sourceRef: string;
  readonly enteredBy?: string;
  readonly proposedAtEpochSeconds: bigint;
  /** What the source said. Kept after verification, corrected or not. */
  readonly proposedValue: Money;
  readonly status: 'PROPOSED' | 'VERIFIED';
  readonly verification?: FigureVerification;
}

export type VerifiedFigure = FinancialFigure & { readonly status: 'VERIFIED'; readonly verification: FigureVerification };

export const isVerified = (f: FinancialFigure): f is VerifiedFigure =>
  f.status === 'VERIFIED' && f.verification !== undefined;

/** The value a decision may use, only once verified. */
export function usableValue(f: FinancialFigure): Result<Money> {
  if (!isVerified(f)) {
    return reject('OP-DETERMINACY', 'FIGURE_NOT_VERIFIED', 'A financial figure is usable only once an officer has verified it', { metric: f.metric });
  }
  return ok(f.verification.value);
}

const REF_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/;
const PERIOD_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,31}$/;
const PRINCIPAL_SHAPE = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,127}$/;

function checkAmount(metric: FinancialMetric, value: Money, currency: CurrencyCode, what: string): Result<true> {
  if (value.currency !== currency) {
    return reject('OP-DETERMINACY', 'FIGURE_CURRENCY_MISMATCH', `The ${what} is not in the application’s currency`, { metric, expected: currency, given: value.currency });
  }
  if (value.minorUnits < 0n && !MAY_BE_NEGATIVE.has(metric)) {
    return reject('OP-DETERMINACY', 'FIGURE_NEGATIVE', `This metric cannot be negative`, { metric });
  }
  return ok(true);
}

/** Record a figure as read from its source. Not yet usable. */
export function proposeFigure(p: FigureProposal, applicationCurrency: CurrencyCode): Result<FinancialFigure> {
  if (!FINANCIAL_METRICS.includes(p.metric)) {
    return reject('OP-DETERMINACY', 'METRIC_UNKNOWN', 'The figure names a metric the financial spread does not know');
  }
  if (!FIGURE_SOURCE_KINDS.includes(p.sourceKind)) {
    return reject('OP-DETERMINACY', 'SOURCE_KIND_UNKNOWN', 'The figure’s source kind is not OCR, RAIL or OFFICER_ENTRY', { metric: p.metric });
  }
  if (!REF_SHAPE.test(p.sourceRef)) {
    return reject('OP-DETERMINACY', 'SOURCE_REF_INVALID', 'A source reference is a document or rail reference id, not content', { metric: p.metric });
  }
  if (!PERIOD_SHAPE.test(p.periodLabel)) {
    return reject('OP-DETERMINACY', 'PERIOD_LABEL_INVALID', 'A figure names the period it covers', { metric: p.metric });
  }
  if (p.sourceKind === 'OFFICER_ENTRY' && (p.enteredBy === undefined || !PRINCIPAL_SHAPE.test(p.enteredBy))) {
    return reject('OP-DETERMINACY', 'ENTERED_BY_REQUIRED', 'A figure keyed in by an officer records which officer keyed it', { metric: p.metric });
  }
  if (p.sourceKind !== 'OFFICER_ENTRY' && p.enteredBy !== undefined) {
    return reject('OP-DETERMINACY', 'ENTERED_BY_UNEXPECTED', 'Only an officer-keyed figure has an entering officer', { metric: p.metric });
  }
  const amount = checkAmount(p.metric, p.value, applicationCurrency, 'proposed figure');
  if (!amount.ok) return amount;
  const base = {
    metric: p.metric,
    periodLabel: p.periodLabel,
    sourceKind: p.sourceKind,
    sourceRef: p.sourceRef,
    proposedAtEpochSeconds: p.proposedAtEpochSeconds,
    proposedValue: p.value,
    status: 'PROPOSED' as const,
  };
  return ok(p.enteredBy === undefined ? base : { ...base, enteredBy: p.enteredBy });
}

export interface VerifyParams {
  readonly verifiedBy: string;
  readonly verifiedAtEpochSeconds: bigint;
  /** The officer's correction. Absent, or equal to the proposal, means the proposal is confirmed as read. */
  readonly correctedValue?: Money;
}

/**
 * An officer verifies a figure, confirming or correcting it. A verified figure
 * is not re-verified: a later correction is a new proposal that supersedes it.
 */
export function verifyFigure(f: FinancialFigure, v: VerifyParams, applicationCurrency: CurrencyCode): Result<VerifiedFigure> {
  if (f.status === 'VERIFIED') {
    return reject('OP-DETERMINACY', 'FIGURE_ALREADY_VERIFIED', 'A verified figure is superseded by a new proposal, never re-verified', { metric: f.metric });
  }
  if (!PRINCIPAL_SHAPE.test(v.verifiedBy)) {
    return reject('OP-DETERMINACY', 'VERIFIER_REQUIRED', 'Verification records the officer who verified', { metric: f.metric });
  }
  if (f.sourceKind === 'OFFICER_ENTRY' && f.enteredBy === v.verifiedBy) {
    return reject('OP-DETERMINACY', 'FOUR_EYES_REQUIRED', 'A figure keyed in by an officer is verified by a different officer', { metric: f.metric });
  }
  if (v.verifiedAtEpochSeconds < f.proposedAtEpochSeconds) {
    return reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', 'A figure is verified after it is proposed', { metric: f.metric });
  }
  if (f.proposedValue.currency !== applicationCurrency) {
    return reject('OP-DETERMINACY', 'FIGURE_CURRENCY_MISMATCH', 'The proposed figure is not in the application’s currency', { metric: f.metric, expected: applicationCurrency, given: f.proposedValue.currency });
  }
  const value = v.correctedValue ?? f.proposedValue;
  const amount = checkAmount(f.metric, value, applicationCurrency, 'corrected figure');
  if (!amount.ok) return amount;
  const correctedFromProposal = value.minorUnits !== f.proposedValue.minorUnits;
  return ok({
    ...f,
    status: 'VERIFIED',
    verification: { value, verifiedBy: v.verifiedBy, verifiedAtEpochSeconds: v.verifiedAtEpochSeconds, correctedFromProposal },
  });
}

// ---------------------------------------------------------------------- spread

/** The metrics a full SME spread needs before any ratio is taken. */
export const BUSINESS_SPREAD_METRICS: readonly FinancialMetric[] = [
  'ANNUAL_REVENUE',
  'PRIOR_YEAR_REVENUE',
  'NET_PROFIT',
  'TOTAL_DEBT_SERVICE',
  'CURRENT_ASSETS',
  'CURRENT_LIABILITIES',
];

/** The business spread plus the owner-level figures for the owner's debt burden. */
export const FULL_SPREAD_METRICS: readonly FinancialMetric[] = [
  ...BUSINESS_SPREAD_METRICS,
  'MONTHLY_GROSS_SALARY',
  'MONTHLY_DEBT_OBLIGATIONS',
];

export interface VerifiedSpread {
  readonly currency: CurrencyCode;
  /** One verified figure per metric that was present and verified. Every required metric is here. */
  readonly figures: Readonly<Partial<Record<FinancialMetric, VerifiedFigure>>>;
  readonly requiredMetrics: readonly FinancialMetric[];
  /** How many verified figures the officer corrected from what the source said. A count, for the review summary. */
  readonly correctedCount: number;
}

/**
 * A spread is complete only when every required metric has exactly one
 * verified figure in the application's currency. Unverified figures for other
 * metrics do not block; a required metric that is missing or unverified does,
 * and the refusal lists which (metric codes only).
 */
export function completeSpread(
  figures: readonly FinancialFigure[],
  required: readonly FinancialMetric[],
  applicationCurrency: CurrencyCode,
): Result<VerifiedSpread> {
  const verified: Partial<Record<FinancialMetric, VerifiedFigure>> = {};
  for (const f of figures) {
    if (!isVerified(f)) continue;
    if (f.verification.value.currency !== applicationCurrency) {
      return reject('OP-DETERMINACY', 'FIGURE_CURRENCY_MISMATCH', 'A verified figure is not in the application’s currency', { metric: f.metric, expected: applicationCurrency, given: f.verification.value.currency });
    }
    if (verified[f.metric] !== undefined) {
      return reject('OP-DETERMINACY', 'METRIC_AMBIGUOUS', 'More than one verified figure for the same metric; supersede one before spreading', { metric: f.metric });
    }
    verified[f.metric] = f;
  }
  const missing = required.filter((m) => verified[m] === undefined);
  if (missing.length > 0) {
    return reject('OP-DETERMINACY', 'SPREAD_INCOMPLETE', 'Every required metric must be verified by an officer before the spread is used', { missing: missing.join(',') });
  }
  const correctedCount = Object.values(verified).filter((f) => f?.verification.correctedFromProposal === true).length;
  return ok({ currency: applicationCurrency, figures: verified, requiredMetrics: [...required], correctedCount });
}

function valueOf(spread: VerifiedSpread, metric: FinancialMetric): Result<VerifiedFigure> {
  const f = spread.figures[metric];
  if (f === undefined) {
    return reject('OP-DETERMINACY', 'METRIC_NOT_IN_SPREAD', 'The ratio needs a verified figure the spread does not hold', { metric });
  }
  return ok(f);
}

// ---------------------------------------------------------------------- ratios

export type FinancialRatioCode =
  | 'DEBT_SERVICE_COVER'
  | 'CURRENT_RATIO'
  | 'SALES_GROWTH'
  | 'NET_MARGIN'
  | 'OWNER_DEBT_BURDEN';

export type RatioRounding = 'FLOOR' | 'CEILING';

/** 10 000 per ten thousand = 1.00x = 100%. */
export const PER_TEN_THOUSAND = 10_000n;

export interface FinancialRatio {
  readonly code: FinancialRatioCode;
  /** The ratio as an integer per ten thousand. */
  readonly perTenThousand: bigint;
  readonly formula: string;
  readonly rounding: RatioRounding;
  /** The exact fraction before rounding, as minor units, so the ratio can be recomputed. */
  readonly numeratorMinorUnits: bigint;
  readonly denominatorMinorUnits: bigint;
  readonly inputs: readonly { readonly metric: FinancialMetric; readonly periodLabel: string; readonly sourceRef: string }[];
}

interface RatioDefinition {
  readonly code: FinancialRatioCode;
  readonly formula: string;
  readonly rounding: RatioRounding;
  readonly numerator: readonly FinancialMetric[];
  readonly denominator: FinancialMetric;
  /** numerator minor units from the figures, in the order listed. */
  readonly numeratorOf: (values: readonly bigint[]) => bigint;
}

export const RATIO_DEFINITIONS: Readonly<Record<FinancialRatioCode, RatioDefinition>> = {
  DEBT_SERVICE_COVER: {
    code: 'DEBT_SERVICE_COVER',
    formula: 'NET_PROFIT ÷ TOTAL_DEBT_SERVICE',
    rounding: 'FLOOR',
    numerator: ['NET_PROFIT'],
    denominator: 'TOTAL_DEBT_SERVICE',
    numeratorOf: ([p]) => p!,
  },
  CURRENT_RATIO: {
    code: 'CURRENT_RATIO',
    formula: 'CURRENT_ASSETS ÷ CURRENT_LIABILITIES',
    rounding: 'FLOOR',
    numerator: ['CURRENT_ASSETS'],
    denominator: 'CURRENT_LIABILITIES',
    numeratorOf: ([a]) => a!,
  },
  SALES_GROWTH: {
    code: 'SALES_GROWTH',
    formula: '(ANNUAL_REVENUE − PRIOR_YEAR_REVENUE) ÷ PRIOR_YEAR_REVENUE',
    rounding: 'FLOOR',
    numerator: ['ANNUAL_REVENUE', 'PRIOR_YEAR_REVENUE'],
    denominator: 'PRIOR_YEAR_REVENUE',
    numeratorOf: ([current, prior]) => current! - prior!,
  },
  NET_MARGIN: {
    code: 'NET_MARGIN',
    formula: 'NET_PROFIT ÷ ANNUAL_REVENUE',
    rounding: 'FLOOR',
    numerator: ['NET_PROFIT'],
    denominator: 'ANNUAL_REVENUE',
    numeratorOf: ([p]) => p!,
  },
  OWNER_DEBT_BURDEN: {
    code: 'OWNER_DEBT_BURDEN',
    formula: 'MONTHLY_DEBT_OBLIGATIONS ÷ MONTHLY_GROSS_SALARY',
    // A burden ratio rounds up: never understate what the owner already owes.
    rounding: 'CEILING',
    numerator: ['MONTHLY_DEBT_OBLIGATIONS'],
    denominator: 'MONTHLY_GROSS_SALARY',
    numeratorOf: ([o]) => o!,
  },
};

export const RATIO_CODES = Object.keys(RATIO_DEFINITIONS) as FinancialRatioCode[];

/** Floor division for bigint (bigint `/` truncates towards zero). Denominator must be positive. */
export function floorDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n < 0n ? q - 1n : q;
}

/** Ceiling division for bigint. Denominator must be positive. */
export function ceilDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  return n % d !== 0n && n > 0n ? q + 1n : q;
}

/** One ratio from a verified spread. Division by zero or a negative denominator is refused. */
export function computeRatio(spread: VerifiedSpread, code: FinancialRatioCode): Result<FinancialRatio> {
  const def = RATIO_DEFINITIONS[code];
  const metrics = [...new Set<FinancialMetric>([...def.numerator, def.denominator])];
  const figures: VerifiedFigure[] = [];
  for (const m of metrics) {
    const f = valueOf(spread, m);
    if (!f.ok) return f;
    figures.push(f.value);
  }
  const value = (m: FinancialMetric): bigint => figures.find((f) => f.metric === m)!.verification.value.minorUnits;
  const numerator = def.numeratorOf(def.numerator.map(value));
  const denominator = value(def.denominator);
  if (denominator === 0n) {
    return reject('OP-DETERMINACY', 'RATIO_DENOMINATOR_ZERO', `${def.formula} cannot be taken: the denominator is zero`, { ratio: code, denominator: def.denominator });
  }
  if (denominator < 0n) {
    return reject('OP-DETERMINACY', 'RATIO_DENOMINATOR_NEGATIVE', `${def.formula} cannot be taken: the denominator is negative`, { ratio: code, denominator: def.denominator });
  }
  const scaled = numerator * PER_TEN_THOUSAND;
  const perTenThousand = def.rounding === 'FLOOR' ? floorDiv(scaled, denominator) : ceilDiv(scaled, denominator);
  return ok({
    code,
    perTenThousand,
    formula: def.formula,
    rounding: def.rounding,
    numeratorMinorUnits: numerator,
    denominatorMinorUnits: denominator,
    inputs: figures.map((f) => ({ metric: f.metric, periodLabel: f.periodLabel, sourceRef: f.sourceRef })),
  });
}

/**
 * Every ratio the spread can support, each as its own Result, so one zero
 * denominator does not hide the others.
 */
export function computeRatios(spread: VerifiedSpread): Readonly<Record<FinancialRatioCode, Result<FinancialRatio>>> {
  const out = {} as Record<FinancialRatioCode, Result<FinancialRatio>>;
  for (const code of RATIO_CODES) out[code] = computeRatio(spread, code);
  return out;
}

// ------------------------------------------------------------- business facts

/**
 * How `annualOperatingCashFlow` is derived for the SME product modules. Net
 * profit stands in for operating cash flow — a proxy, not a cash-flow
 * statement; it ignores non-cash charges and working-capital movement. This
 * is a credit-policy choice, labelled ILLUSTRATIVE until a tenant's credit
 * policy states its own derivation; it is not a regulatory threshold.
 */
export const OPERATING_CASH_FLOW_PROXY = {
  derivation: 'NET_PROFIT',
  policyRef: 'ILLUSTRATIVE — tenant credit policy: operating cash flow proxied by verified net profit',
} as const;

export interface BusinessFactsExtras {
  /** A count of people, not an amount. */
  readonly fullTimeEmployees: number;
  readonly sector?: string;
}

/**
 * The BusinessFacts the SME product modules take, from a verified spread:
 *
 *   annualRevenue              ← ANNUAL_REVENUE
 *   annualOperatingCashFlow    ← NET_PROFIT (see OPERATING_CASH_FLOW_PROXY)
 *   existingAnnualDebtService  ← TOTAL_DEBT_SERVICE
 *   financialsSourceRef        ← the source references of those figures
 */
export function toBusinessFacts(spread: VerifiedSpread, extras: BusinessFactsExtras): Result<BusinessFacts> {
  if (!Number.isSafeInteger(extras.fullTimeEmployees) || extras.fullTimeEmployees < 0) {
    return reject('OP-DETERMINACY', 'EMPLOYEES_INVALID', 'Full-time employees is a whole, non-negative count');
  }
  const revenue = valueOf(spread, 'ANNUAL_REVENUE');
  if (!revenue.ok) return revenue;
  const profit = valueOf(spread, 'NET_PROFIT');
  if (!profit.ok) return profit;
  const debtService = valueOf(spread, 'TOTAL_DEBT_SERVICE');
  if (!debtService.ok) return debtService;
  const refs = [...new Set([revenue.value, profit.value, debtService.value].map((f) => f.sourceRef))];
  const facts: BusinessFacts = {
    annualRevenue: revenue.value.verification.value,
    fullTimeEmployees: extras.fullTimeEmployees,
    annualOperatingCashFlow: profit.value.verification.value,
    existingAnnualDebtService: debtService.value.verification.value,
    financialsSourceRef: `spread:${refs.join('|')}`,
  };
  return ok(extras.sector === undefined ? facts : { ...facts, sector: extras.sector });
}
