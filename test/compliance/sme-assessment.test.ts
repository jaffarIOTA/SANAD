/**
 * Adversarial cases for the SME credit assessment (CLAUDE.md §11): knock-outs,
 * the two-part weighted scorecard, the risk level and its terms, and the
 * approval route. Run against the UAE SME fund's illustrative policy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { type SmeAssessmentFacts, assessSme, parseSmeAssessmentPolicy } from '@sanad/core/decisioning/sme-assessment.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const POLICY_PATH = 'config/tenants/sme-fund-ae/credit-policy/sme-assessment.json';
const rawPolicy = (): Record<string, unknown> => JSON.parse(readFileSync(`${ROOT}${POLICY_PATH}`, 'utf8')) as Record<string, unknown>;
const POLICY = expectOk(parseSmeAssessmentPolicy(rawPolicy()));

const aed = (dirhams: bigint) => money(dirhams * 100n, 'AED');

/** The example applicant from the partner's prototype screens. */
const EXAMPLE: SmeAssessmentFacts = {
  bureauScore: 801n,
  dscrPerTenThousand: 18_500n,
  currentRatioPerTenThousand: 15_000n,
  salesGrowthPerTenThousand: 800n,
  ownerDbrPerTenThousand: 2_500n,
  dbrBeforeLoanPerTenThousand: 388n,
  relevantExperienceYears: 4n,
  equityContributionPerTenThousand: 2_000n,
  sectorPriority: 'NON_PRIORITY',
  profitable: true,
  auditedFinancialsAvailable: true,
  yearsInOperation: 4n,
  commitmentRatioPerTenThousand: 10_100n,
  riskAnalysisScorePerTenThousand: 5_770n,
  portfolioRepaymentPerTenThousand: 5_300n,
  failedFilesRatePerTenThousand: 3_000n,
  collateralCoveragePerTenThousand: 13_000n,
};

describe('SME assessment — the prototype example applicant', () => {
  const result = expectOk(assessSme(POLICY, EXAMPLE, aed(2_000_000n)));

  it('passes every knock-out, each reported with threshold, actual and pass', () => {
    expect(result.failedKnockouts).toEqual([]);
    expect(result.knockouts.map((k) => k.code)).toEqual(['KO_BUREAU_SCORE', 'KO_DSCR', 'KO_CURRENT_RATIO', 'KO_SALES_GROWTH', 'KO_OWNER_DBR']);
    const bureau = result.knockouts[0];
    expect(bureau).toMatchObject({ threshold: 650n, actual: 801n, passed: true });
  });

  it('scores applicant 9250, project 7000, cumulative 7900 with a full trace', () => {
    const sc = result.scorecard;
    expect(sc).toBeDefined();
    expect(sc?.sections.map((s) => [s.code, s.weightPerTenThousand, s.scorePerTenThousand])).toEqual([
      ['APPLICANT', 4000n, 9250n],
      ['PROJECT', 6000n, 7000n],
    ]);
    expect(sc?.cumulativeScorePerTenThousand).toBe(7900n);
    const failedFiles = sc?.sections[1]?.criteria.find((c) => c.code === 'FAILED_FILES_RATE');
    expect(failedFiles).toMatchObject({ input: 3000n, bandIndex: 2, scorePerTenThousand: 3000n, risk: 'HIGH' });
    const sector = sc?.sections[1]?.criteria.find((c) => c.code === 'SECTOR_PRIORITY');
    expect(sector).toMatchObject({ input: 'NON_PRIORITY', scorePerTenThousand: 5000n, risk: 'MODERATE' });
  });

  it('is LOW risk with the LOW band terms (AED 2,000,000, 20% contribution)', () => {
    expect(result.riskLevel).toBe('LOW');
    expect(result.terms?.maxFinancing).toEqual(aed(2_000_000n));
    expect(result.terms?.minEquityContributionPerTenThousand).toBe(2000);
  });

  it('routes to COMMITTEE because AED 2,000,000 is above the AED 500,000 straight-through maximum', () => {
    expect(result.outcome).toBe('COMMITTEE');
    expect(result.reasons.map((r) => r.code)).toEqual(['STP_AMOUNT_WITHIN_STP_MAXIMUM_NOT_MET']);
    expect(result.straightThroughChecks.map((c) => [c.check, c.passed])).toEqual([
      ['AMOUNT_WITHIN_STP_MAXIMUM', false],
      ['RISK_LEVEL_ALLOWED', true],
      ['COLLATERAL_COVERAGE_MINIMUM', true],
    ]);
  });
});

describe('SME assessment — routing', () => {
  it('routes an AED 400,000 LOW-risk request with 130% collateral STRAIGHT_THROUGH', () => {
    const r = expectOk(assessSme(POLICY, EXAMPLE, aed(400_000n)));
    expect(r.riskLevel).toBe('LOW');
    expect(r.outcome).toBe('STRAIGHT_THROUGH');
    expect(r.reasons.map((x) => x.code)).toEqual(['ALL_STP_CONDITIONS_MET']);
  });

  it('refuses straight-through when collateral coverage is below 120%', () => {
    const r = expectOk(assessSme(POLICY, { ...EXAMPLE, collateralCoveragePerTenThousand: 11_999n }, aed(400_000n)));
    expect(r.outcome).toBe('COMMITTEE');
    expect(r.reasons.map((x) => x.code)).toEqual(['STP_COLLATERAL_COVERAGE_MINIMUM_NOT_MET']);
  });

  it('refuses straight-through at MEDIUM risk even for a small amount', () => {
    const weaker = { ...EXAMPLE, bureauScore: 660n, relevantExperienceYears: 1n, profitable: false };
    const r = expectOk(assessSme(POLICY, weaker, aed(400_000n)));
    expect(r.riskLevel).toBe('MEDIUM');
    expect(r.outcome).toBe('COMMITTEE');
    expect(r.reasons.map((x) => x.code)).toContain('STP_RISK_LEVEL_ALLOWED_NOT_MET');
  });

  it('cannot reach straight-through with equity below the risk band minimum', () => {
    const r = expectOk(assessSme(POLICY, { ...EXAMPLE, equityContributionPerTenThousand: 1_999n, dbrBeforeLoanPerTenThousand: 100n }, aed(400_000n)));
    expect(r.outcome).not.toBe('STRAIGHT_THROUGH');
    expect(r.reasons.map((x) => x.code)).toContain('EQUITY_BELOW_RISK_ALIGNED_MINIMUM');
  });

  it('flags a request above the risk-aligned maximum', () => {
    const r = expectOk(assessSme(POLICY, EXAMPLE, aed(2_000_001n)));
    expect(r.outcome).toBe('COMMITTEE');
    expect(r.reasons.map((x) => x.code)).toContain('ABOVE_RISK_ALIGNED_MAXIMUM');
  });

  it('declines a score below the lowest band, as configured', () => {
    const poor: SmeAssessmentFacts = { ...EXAMPLE, bureauScore: 650n, dbrBeforeLoanPerTenThousand: 4_500n, relevantExperienceYears: 0n, equityContributionPerTenThousand: 500n, profitable: false, auditedFinancialsAvailable: false, yearsInOperation: 1n, commitmentRatioPerTenThousand: 7_000n, riskAnalysisScorePerTenThousand: 2_000n, portfolioRepaymentPerTenThousand: 4_000n, failedFilesRatePerTenThousand: 4_000n };
    const r = expectOk(assessSme(POLICY, poor, aed(100_000n)));
    expect(r.outcome).toBe('DECLINE');
    expect(r.riskLevel).toBeUndefined();
    expect(r.reasons.map((x) => x.code)).toEqual(['SCORE_BELOW_FLOOR']);
  });

  it('refers instead when the policy says so', () => {
    const policy = expectOk(parseSmeAssessmentPolicy({ ...rawPolicy(), belowFloorOutcome: 'REFER' }));
    const poor: SmeAssessmentFacts = { ...EXAMPLE, bureauScore: 650n, dbrBeforeLoanPerTenThousand: 4_500n, relevantExperienceYears: 0n, equityContributionPerTenThousand: 500n, profitable: false, auditedFinancialsAvailable: false, yearsInOperation: 1n, commitmentRatioPerTenThousand: 7_000n, riskAnalysisScorePerTenThousand: 2_000n, portfolioRepaymentPerTenThousand: 4_000n, failedFilesRatePerTenThousand: 4_000n };
    expect(expectOk(assessSme(policy, poor, aed(100_000n))).outcome).toBe('REFER');
  });
});

describe('SME assessment — each knock-out declines on its own', () => {
  const failing: ReadonlyArray<[string, Partial<Record<string, bigint>>]> = [
    ['KO_BUREAU_SCORE', { bureauScore: 649n }],
    ['KO_DSCR', { dscrPerTenThousand: 13_999n }],
    ['KO_CURRENT_RATIO', { currentRatioPerTenThousand: 12_999n }],
    ['KO_SALES_GROWTH', { salesGrowthPerTenThousand: 199n }],
    ['KO_OWNER_DBR', { ownerDbrPerTenThousand: 5_001n }],
  ];
  it.each(failing)('%s', (code, change) => {
    const r = expectOk(assessSme(POLICY, { ...EXAMPLE, ...change } as SmeAssessmentFacts, aed(400_000n)));
    expect(r.outcome).toBe('DECLINE');
    expect(r.failedKnockouts).toEqual([code]);
    expect(r.scorecard).toBeUndefined();
    expect(r.knockouts.find((k) => k.code === code)?.passed).toBe(false);
    expect(r.knockouts.filter((k) => k.passed)).toHaveLength(4);
  });

  it('passes exactly at each threshold', () => {
    const edge = { ...EXAMPLE, bureauScore: 650n, dscrPerTenThousand: 14_000n, currentRatioPerTenThousand: 13_000n, salesGrowthPerTenThousand: 200n, ownerDbrPerTenThousand: 5_000n };
    expect(expectOk(assessSme(POLICY, edge, aed(400_000n))).failedKnockouts).toEqual([]);
  });
});

describe('SME assessment — the policy parses strictly', () => {
  const sections = () => rawPolicy()['sections'] as Array<Record<string, unknown>>;

  it('refuses section weights that do not sum to 10000', () => {
    const s = sections();
    (s[0] as Record<string, unknown>)['weightPerTenThousand'] = 3999;
    const r = parseSmeAssessmentPolicy({ ...rawPolicy(), sections: s });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('SME_ASSESSMENT_WEIGHTS_NOT_WHOLE');
  });

  it('refuses criterion weights within a section that do not sum to 10000', () => {
    const s = sections();
    const criteria = (s[1] as Record<string, unknown>)['criteria'] as Array<Record<string, unknown>>;
    (criteria[0] as Record<string, unknown>)['weightPerTenThousand'] = 1001;
    const r = parseSmeAssessmentPolicy({ ...rawPolicy(), sections: s });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('SME_ASSESSMENT_WEIGHTS_NOT_WHOLE');
  });

  it('refuses a fractional threshold, weight or score', () => {
    const k = rawPolicy()['knockouts'] as Array<Record<string, unknown>>;
    (k[1] as Record<string, unknown>)['threshold'] = 1.4;
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), knockouts: k }).ok).toBe(false);
    const s = sections();
    (s[0] as Record<string, unknown>)['weightPerTenThousand'] = 4000.5;
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), sections: s }).ok).toBe(false);
  });

  it('refuses a criterion whose last band is not ANY', () => {
    const s = sections();
    const criteria = (s[0] as Record<string, unknown>)['criteria'] as Array<Record<string, unknown>>;
    const bands = (criteria[0] as Record<string, unknown>)['bands'] as unknown[];
    bands.pop();
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), sections: s }).ok).toBe(false);
  });

  it('refuses a knock-out without a policyRef, an unknown key, and an undeclared fact', () => {
    const noRef = rawPolicy()['knockouts'] as Array<Record<string, unknown>>;
    delete (noRef[0] as Record<string, unknown>)['policyRef'];
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), knockouts: noRef }).ok).toBe(false);
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), override: true }).ok).toBe(false);
    const undeclared = rawPolicy()['knockouts'] as Array<Record<string, unknown>>;
    (undeclared[0] as Record<string, unknown>)['fact'] = 'notDeclared';
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), knockouts: undeclared }).ok).toBe(false);
  });

  it('refuses risk bands that are not strictly descending, and an STP level that does not exist', () => {
    const bands = rawPolicy()['riskBands'] as Array<Record<string, unknown>>;
    (bands[1] as Record<string, unknown>)['minScorePerTenThousand'] = 9000;
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), riskBands: bands }).ok).toBe(false);
    const stp = { ...(rawPolicy()['straightThrough'] as Record<string, unknown>), allowedRiskLevels: ['NEGLIGIBLE'] };
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), straightThrough: stp }).ok).toBe(false);
  });

  it('requires the source to say these are the institution’s figures, and every threshold in the fund’s policy is tagged illustrative', () => {
    expect(parseSmeAssessmentPolicy({ ...rawPolicy(), source: 'REGULATOR' }).ok).toBe(false);
    const refs = [POLICY.policyRef, POLICY.straightThrough.policyRef, ...POLICY.knockouts.map((k) => k.policyRef), ...POLICY.riskBands.map((r) => r.policyRef), ...POLICY.sections.flatMap((s) => s.criteria.map((c) => c.policyRef))];
    expect(refs.every((r) => r.startsWith('ILLUSTRATIVE'))).toBe(true);
  });
});

describe('SME assessment — determinacy and integers', () => {
  it('refuses a missing fact without echoing any value', () => {
    const { bureauScore: _drop, ...rest } = EXAMPLE;
    const r = assessSme(POLICY, rest, aed(400_000n));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('SME_FACT_MISSING');
      expect(r.error.context).toEqual({ fact: 'bureauScore' });
    }
  });

  it('refuses a fact given as a JavaScript number (a possible float) rather than a bigint', () => {
    const r = assessSme(POLICY, { ...EXAMPLE, dscrPerTenThousand: 1.85 as unknown as bigint }, aed(400_000n));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('SME_FACT_TYPE');
  });

  it('refuses an amount in another currency', () => {
    const r = assessSme(POLICY, EXAMPLE, money(40_000_000n, 'SAR'));
    expect(r.ok).toBe(false);
  });

  it('produces only integers: every computed score is a bigint', () => {
    const r = expectOk(assessSme(POLICY, EXAMPLE, aed(2_000_000n)));
    expect(typeof r.scorecard?.cumulativeScorePerTenThousand).toBe('bigint');
    for (const s of r.scorecard?.sections ?? []) {
      expect(typeof s.scorePerTenThousand).toBe('bigint');
      for (const c of s.criteria) expect(typeof c.scorePerTenThousand).toBe('bigint');
    }
  });

  it('the engine source holds no float helpers or decimal literals', () => {
    const source = readFileSync(`${ROOT}core/decisioning/sme-assessment.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/parseFloat|toFixed|Math\.(round|floor|ceil|pow)/);
    expect(source).not.toMatch(/[^\w.]\d+\.\d+/);
  });
});
