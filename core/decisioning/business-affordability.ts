/**
 * Business affordability for SME finance: is the enterprise of a size the
 * product serves, can its cash flow carry the new debt service, and is the
 * amount within a multiple of its revenue the institution accepts.
 *
 * These limits are the institution's own credit policy, not a regulator's
 * figure: no SAMA rule found sets a debt-service cover or a revenue multiple
 * for SME finance (searched 2026-10-08; see the READMEs of the two SME product modules).
 * So each rule carries `source: 'TENANT_CREDIT_POLICY'` and the reference of
 * the policy it comes from, and a screen or an audit pack can say exactly
 * that. Size classification uses the regulator's definition, with its own
 * citation (core/applicant/sme-size.ts).
 *
 * Pure, integer arithmetic. Ratios are per ten thousand (12500 = 1.25×).
 */

import {
  type SizeClassification,
  type SmeDefinition,
  type SmeSizeClass,
  SME_SIZE_CLASSES,
  classifySme,
} from '../applicant/sme-size.ts';
import { type Money, add } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import type { BusinessFacts } from '../products/module.ts';

export interface BusinessCreditRule {
  readonly eligibleSizes: readonly SmeSizeClass[];
  /** Minimum annual operating cash flow ÷ total annual debt service after this facility, per ten thousand. */
  readonly minDebtServiceCoverPerTenThousand: number;
  /** Maximum financing as a share of last year's revenue, per ten thousand. */
  readonly maxFinancingShareOfRevenuePerTenThousand: number;
  /** For an enterprise with no revenue history: the most it may be offered. Absent = such enterprises are not served. */
  readonly maxFinancingWithoutRevenueHistory?: Money;
  readonly source: 'TENANT_CREDIT_POLICY';
  /** The institution's policy document and version this rule comes from. Required. */
  readonly policyRef: string;
}

export interface BusinessAffordabilityResult {
  readonly classification: SizeClassification;
  readonly debtServiceCoverPerTenThousand: bigint | 'NO_DEBT_SERVICE';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRatio = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;

export function parseBusinessCreditRule(raw: unknown, readMoney: (s: string) => Money): Result<BusinessCreditRule> {
  const bad = (reason: string, detail: string): Result<never> => reject('OP-DETERMINACY', reason, detail);
  if (!isRecord(raw)) return bad('CREDIT_RULE_MALFORMED', 'The business credit rule is an object');
  const allowed = new Set([
    'eligibleSizes',
    'minDebtServiceCoverPerTenThousand',
    'maxFinancingShareOfRevenuePerTenThousand',
    'maxFinancingWithoutRevenueHistoryMinorUnits',
    'source',
    'policyRef',
  ]);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0)
    return reject('OP-DETERMINACY', 'CREDIT_RULE_UNKNOWN_KEY', 'Unknown key in the business credit rule', {
      keys: unknown.join(','),
    });
  const sizes = raw['eligibleSizes'];
  if (!Array.isArray(sizes) || sizes.length === 0 || !sizes.every((s) => SME_SIZE_CLASSES.includes(s as SmeSizeClass)))
    return bad('CREDIT_RULE_SIZES', 'eligibleSizes lists one or more of MICRO, SMALL, MEDIUM, LARGE');
  if (!isRatio(raw['minDebtServiceCoverPerTenThousand'], 100_000))
    return bad('CREDIT_RULE_DSCR', 'minDebtServiceCoverPerTenThousand is a whole number in (0, 100000]');
  if (!isRatio(raw['maxFinancingShareOfRevenuePerTenThousand'], 100_000))
    return bad(
      'CREDIT_RULE_REVENUE_SHARE',
      'maxFinancingShareOfRevenuePerTenThousand is a whole number in (0, 100000]',
    );
  const noHistory = raw['maxFinancingWithoutRevenueHistoryMinorUnits'];
  if (noHistory !== undefined && (typeof noHistory !== 'string' || !/^\d+$/.test(noHistory)))
    return bad('CREDIT_RULE_NO_HISTORY', 'maxFinancingWithoutRevenueHistoryMinorUnits is an integer string');
  if (raw['source'] !== 'TENANT_CREDIT_POLICY')
    return bad(
      'CREDIT_RULE_SOURCE',
      "source is 'TENANT_CREDIT_POLICY': these limits are the institution's, and say so",
    );
  if (typeof raw['policyRef'] !== 'string' || raw['policyRef'].trim().length < 3)
    return bad('CREDIT_RULE_POLICY_REF', 'policyRef names the credit policy and version the limits come from');
  return ok({
    eligibleSizes: sizes as SmeSizeClass[],
    minDebtServiceCoverPerTenThousand: raw['minDebtServiceCoverPerTenThousand'],
    maxFinancingShareOfRevenuePerTenThousand: raw['maxFinancingShareOfRevenuePerTenThousand'],
    ...(noHistory === undefined ? {} : { maxFinancingWithoutRevenueHistory: readMoney(noHistory) }),
    source: 'TENANT_CREDIT_POLICY',
    policyRef: raw['policyRef'],
  });
}

export function checkBusinessAffordability(
  rule: BusinessCreditRule,
  definition: SmeDefinition,
  facts: BusinessFacts | undefined,
  requested: Money,
  newAnnualDebtService: Money,
): Result<BusinessAffordabilityResult> {
  if (facts === undefined)
    return reject(
      'OP-DETERMINACY',
      'BUSINESS_FACTS_MISSING',
      'An SME quote needs the enterprise’s revenue, cash flow and existing debt service, from their sources',
    );
  if (facts.financialsSourceRef.trim().length === 0)
    return reject(
      'OP-DETERMINACY',
      'FINANCIALS_UNSOURCED',
      'Business figures carry the reference of the statements or rail they came from',
    );
  const classified = classifySme(definition, facts);
  if (!classified.ok) return classified;
  const at = { policyRef: rule.policyRef, sizeClass: classified.value.sizeClass, basis: classified.value.basis };
  if (!rule.eligibleSizes.includes(classified.value.sizeClass))
    return reject('OP-LIMIT', 'SIZE_NOT_ELIGIBLE', 'The enterprise is of a size this product does not serve', at);

  if (facts.annualRevenue === undefined) {
    if (rule.maxFinancingWithoutRevenueHistory === undefined)
      return reject(
        'OP-LIMIT',
        'NO_REVENUE_HISTORY',
        'This product serves enterprises with a revenue history only',
        at,
      );
    if (requested.minorUnits > rule.maxFinancingWithoutRevenueHistory.minorUnits)
      return reject(
        'OP-LIMIT',
        'ABOVE_NEW_ENTERPRISE_LIMIT',
        'Above what the policy offers an enterprise with no revenue history',
        { ...at, max: String(rule.maxFinancingWithoutRevenueHistory.minorUnits) },
      );
  } else if (
    requested.minorUnits * 10_000n >
    facts.annualRevenue.minorUnits * BigInt(rule.maxFinancingShareOfRevenuePerTenThousand)
  ) {
    return reject(
      'OP-LIMIT',
      'ABOVE_REVENUE_SHARE',
      'The amount is a larger share of the enterprise’s revenue than the policy allows',
      { ...at, capPerTenThousand: String(rule.maxFinancingShareOfRevenuePerTenThousand) },
    );
  }

  const totalService = add(facts.existingAnnualDebtService, newAnnualDebtService);
  if (totalService.minorUnits <= 0n)
    return ok({ classification: classified.value, debtServiceCoverPerTenThousand: 'NO_DEBT_SERVICE' });
  const cover = (facts.annualOperatingCashFlow.minorUnits * 10_000n) / totalService.minorUnits;
  if (cover < BigInt(rule.minDebtServiceCoverPerTenThousand)) {
    return reject(
      'OP-LIMIT',
      'DEBT_SERVICE_COVER_BELOW_POLICY',
      'The enterprise’s cash flow would not cover its debt service by the margin the policy requires',
      { ...at, coverPerTenThousand: String(cover), minimum: String(rule.minDebtServiceCoverPerTenThousand) },
    );
  }
  return ok({ classification: classified.value, debtServiceCoverPerTenThousand: cover });
}
