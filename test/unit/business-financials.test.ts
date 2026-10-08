import { describe, expect, it } from 'vitest';

import { money, type Money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  BUSINESS_SPREAD_METRICS,
  FULL_SPREAD_METRICS,
  OPERATING_CASH_FLOW_PROXY,
  ceilDiv,
  completeSpread,
  computeRatio,
  computeRatios,
  floorDiv,
  proposeFigure,
  toBusinessFacts,
  usableValue,
  verifyFigure,
  type FigureProposal,
  type FinancialFigure,
  type FinancialMetric,
} from '@sanad/core/applicant/financials.ts';

const aed = (minorUnits: bigint): Money => money(minorUnits, 'AED');

const proposal = (metric: FinancialMetric, value: Money, over: Partial<FigureProposal> = {}): FigureProposal => ({
  metric,
  periodLabel: metric === 'PRIOR_YEAR_REVENUE' ? 'FY2024' : metric.startsWith('MONTHLY') ? '2026-09' : 'FY2025',
  value,
  sourceKind: 'OCR',
  sourceRef: `doc:stmt-${metric.toLowerCase()}`,
  proposedAtEpochSeconds: 1_000n,
  ...over,
});

const verified = (metric: FinancialMetric, value: Money, correctedValue?: Money): FinancialFigure =>
  expectOk(verifyFigure(expectOk(proposeFigure(proposal(metric, value), 'AED')), correctedValue === undefined ? { verifiedBy: 'officer-1', verifiedAtEpochSeconds: 2_000n } : { verifiedBy: 'officer-1', verifiedAtEpochSeconds: 2_000n, correctedValue }, 'AED'));

/** The figures on the core banking partner's SME prototype screen, AED. */
const SCREEN: Readonly<Record<FinancialMetric, Money>> = {
  ANNUAL_REVENUE: aed(234_000_000n),
  PRIOR_YEAR_REVENUE: aed(218_000_000n),
  NET_PROFIT: aed(31_000_000n),
  TOTAL_DEBT_SERVICE: aed(18_000_000n),
  CURRENT_ASSETS: aed(92_000_000n),
  CURRENT_LIABILITIES: aed(44_000_000n),
  MONTHLY_GROSS_SALARY: aed(6_445_645n),
  MONTHLY_DEBT_OBLIGATIONS: aed(250_000n),
};

const screenSpread = () =>
  expectOk(completeSpread(FULL_SPREAD_METRICS.map((m) => verified(m, SCREEN[m])), FULL_SPREAD_METRICS, 'AED'));

describe('financial figures — proposal and verification', () => {
  it('is not usable until an officer verifies it, and verification records who and when', () => {
    const f = expectOk(proposeFigure(proposal('NET_PROFIT', aed(31_000_000n)), 'AED'));
    expect(f.status).toBe('PROPOSED');
    const r = usableValue(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('FIGURE_NOT_VERIFIED');
    const v = expectOk(verifyFigure(f, { verifiedBy: 'officer-7', verifiedAtEpochSeconds: 1_500n }, 'AED'));
    expect(v.verification).toEqual({ value: aed(31_000_000n), verifiedBy: 'officer-7', verifiedAtEpochSeconds: 1_500n, correctedFromProposal: false });
    expect(expectOk(usableValue(v))).toEqual(aed(31_000_000n));
  });

  it('keeps the OCR value when the officer corrects it, and flags the correction', () => {
    const v = verified('ANNUAL_REVENUE', aed(234_000_000n), aed(243_000_000n));
    expect(v.proposedValue).toEqual(aed(234_000_000n));
    expect(v.verification?.value).toEqual(aed(243_000_000n));
    expect(v.verification?.correctedFromProposal).toBe(true);
    // A "correction" equal to the proposal is a confirmation.
    expect(verified('ANNUAL_REVENUE', aed(1n), aed(1n)).verification?.correctedFromProposal).toBe(false);
  });

  it('refuses a figure in another currency, at proposal and at correction', () => {
    const p = proposeFigure(proposal('CURRENT_ASSETS', money(1n, 'SAR')), 'AED');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.reason).toBe('FIGURE_CURRENCY_MISMATCH');
    const f = expectOk(proposeFigure(proposal('CURRENT_ASSETS', aed(1n)), 'AED'));
    const c = verifyFigure(f, { verifiedBy: 'officer-1', verifiedAtEpochSeconds: 2_000n, correctedValue: money(1n, 'SAR') }, 'AED');
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.reason).toBe('FIGURE_CURRENCY_MISMATCH');
  });

  it('refuses content as a source reference, and a negative amount except for a loss', () => {
    expect(proposeFigure(proposal('NET_PROFIT', aed(1n), { sourceRef: 'Revenue for the year was 2,340,000' }), 'AED').ok).toBe(false);
    expect(proposeFigure(proposal('CURRENT_LIABILITIES', aed(-1n)), 'AED').ok).toBe(false);
    expect(proposeFigure(proposal('NET_PROFIT', aed(-1n)), 'AED').ok).toBe(true);
  });

  it('never puts the amount in a rejection (an owner’s salary is personal data)', () => {
    const r = proposeFigure(proposal('MONTHLY_GROSS_SALARY', aed(-6_445_645n)), 'AED');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('6445645');
  });

  it('requires four eyes on an officer-keyed figure, and an entering officer', () => {
    expect(proposeFigure(proposal('NET_PROFIT', aed(1n), { sourceKind: 'OFFICER_ENTRY' }), 'AED').ok).toBe(false);
    const f = expectOk(proposeFigure(proposal('NET_PROFIT', aed(1n), { sourceKind: 'OFFICER_ENTRY', enteredBy: 'officer-1' }), 'AED'));
    const same = verifyFigure(f, { verifiedBy: 'officer-1', verifiedAtEpochSeconds: 2_000n }, 'AED');
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error.reason).toBe('FOUR_EYES_REQUIRED');
    expect(verifyFigure(f, { verifiedBy: 'officer-2', verifiedAtEpochSeconds: 2_000n }, 'AED').ok).toBe(true);
  });

  it('refuses re-verification and a verification before the proposal', () => {
    const v = verified('NET_PROFIT', aed(1n));
    expect(verifyFigure(v, { verifiedBy: 'officer-2', verifiedAtEpochSeconds: 3_000n }, 'AED').ok).toBe(false);
    const f = expectOk(proposeFigure(proposal('NET_PROFIT', aed(1n)), 'AED'));
    const early = verifyFigure(f, { verifiedBy: 'officer-2', verifiedAtEpochSeconds: 999n }, 'AED');
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.control).toBe('OP-CHAIN');
  });
});

describe('the spread', () => {
  it('is complete only when every required metric is verified', () => {
    const figures = BUSINESS_SPREAD_METRICS.map((m) => verified(m, SCREEN[m]));
    const pending = expectOk(proposeFigure(proposal('CURRENT_LIABILITIES', SCREEN.CURRENT_LIABILITIES), 'AED'));
    const r = completeSpread([...figures.filter((f) => f.metric !== 'CURRENT_LIABILITIES'), pending], BUSINESS_SPREAD_METRICS, 'AED');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('SPREAD_INCOMPLETE');
      expect(r.error.context?.['missing']).toBe('CURRENT_LIABILITIES');
    }
    expect(completeSpread(figures, BUSINESS_SPREAD_METRICS, 'AED').ok).toBe(true);
  });

  it('refuses two verified figures for one metric, and a spread in the wrong currency', () => {
    const figures = BUSINESS_SPREAD_METRICS.map((m) => verified(m, SCREEN[m]));
    const dup = completeSpread([...figures, verified('NET_PROFIT', aed(1n))], BUSINESS_SPREAD_METRICS, 'AED');
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.reason).toBe('METRIC_AMBIGUOUS');
    expect(completeSpread(figures, BUSINESS_SPREAD_METRICS, 'SAR').ok).toBe(false);
  });

  it('counts the officer’s corrections', () => {
    const figures = BUSINESS_SPREAD_METRICS.map((m) => (m === 'NET_PROFIT' ? verified(m, aed(30_000_000n), SCREEN[m]) : verified(m, SCREEN[m])));
    expect(expectOk(completeSpread(figures, BUSINESS_SPREAD_METRICS, 'AED')).correctedCount).toBe(1);
  });
});

describe('ratios — reproduced against the prototype screen (AED)', () => {
  it('debt-service cover 17222 (1.72x)', () => {
    const r = expectOk(computeRatio(screenSpread(), 'DEBT_SERVICE_COVER'));
    expect(r.perTenThousand).toBe(17_222n);
    expect(r.formula).toBe('NET_PROFIT ÷ TOTAL_DEBT_SERVICE');
    expect(r.rounding).toBe('FLOOR');
    expect(r.inputs.map((i) => i.metric)).toEqual(['NET_PROFIT', 'TOTAL_DEBT_SERVICE']);
  });

  it('current ratio 20909 (2.09x)', () => {
    expect(expectOk(computeRatio(screenSpread(), 'CURRENT_RATIO')).perTenThousand).toBe(20_909n);
  });

  it('sales growth 733 (7.33%; the screen shows 7.3%)', () => {
    const r = expectOk(computeRatio(screenSpread(), 'SALES_GROWTH'));
    expect(r.perTenThousand).toBe(733n);
    expect(r.numeratorMinorUnits).toBe(16_000_000n);
  });

  it('net margin 1324 (13.2%)', () => {
    expect(expectOk(computeRatio(screenSpread(), 'NET_MARGIN')).perTenThousand).toBe(1_324n);
  });

  it('owner debt burden 388 (3.88%), rounded up as a burden ratio', () => {
    // Exact: 2 500.00 ÷ 64 456.45 = 250 000 ÷ 6 445 645 = 0.0387859…, i.e. 387.859… per ten thousand.
    // Rounding down would give 387 (3.87%); the screen shows 3.88%. A burden ratio rounds up
    // (never understate what the owner owes), which gives 388 — matching the screen here.
    const r = expectOk(computeRatio(screenSpread(), 'OWNER_DEBT_BURDEN'));
    expect(r.perTenThousand).toBe(388n);
    expect(r.rounding).toBe('CEILING');
    expect(floorDiv(r.numeratorMinorUnits * 10_000n, r.denominatorMinorUnits)).toBe(387n);
  });

  it('computes every ratio independently', () => {
    const all = computeRatios(screenSpread());
    expect(Object.values(all).every((r) => r.ok)).toBe(true);
  });

  it('negative growth rounds towards −∞ (never overstates growth)', () => {
    const figures = BUSINESS_SPREAD_METRICS.map((m) => verified(m, m === 'ANNUAL_REVENUE' ? aed(217_999_999n) : SCREEN[m]));
    const r = expectOk(computeRatio(expectOk(completeSpread(figures, BUSINESS_SPREAD_METRICS, 'AED')), 'SALES_GROWTH'));
    expect(r.perTenThousand).toBe(-1n);
  });

  it('division by zero is a typed refusal, never Infinity, and does not hide other ratios', () => {
    const figures = BUSINESS_SPREAD_METRICS.map((m) => verified(m, m === 'TOTAL_DEBT_SERVICE' ? aed(0n) : SCREEN[m]));
    const all = computeRatios(expectOk(completeSpread(figures, BUSINESS_SPREAD_METRICS, 'AED')));
    expect(all.DEBT_SERVICE_COVER.ok).toBe(false);
    if (!all.DEBT_SERVICE_COVER.ok) expect(all.DEBT_SERVICE_COVER.error.reason).toBe('RATIO_DENOMINATOR_ZERO');
    expect(all.CURRENT_RATIO.ok).toBe(true);
    // Owner figures not in a business-only spread: refused, not guessed.
    expect(all.OWNER_DEBT_BURDEN.ok).toBe(false);
  });

  it('bigint division helpers round in the stated direction', () => {
    expect(floorDiv(7n, 2n)).toBe(3n); expect(floorDiv(-7n, 2n)).toBe(-4n); expect(floorDiv(-6n, 2n)).toBe(-3n);
    expect(ceilDiv(7n, 2n)).toBe(4n); expect(ceilDiv(-7n, 2n)).toBe(-3n); expect(ceilDiv(6n, 2n)).toBe(3n);
  });
});

describe('BusinessFacts for the SME product modules', () => {
  it('maps the verified spread, with net profit as the policy-labelled cash-flow proxy', () => {
    const facts = expectOk(toBusinessFacts(screenSpread(), { fullTimeEmployees: 42, sector: 'TRADING' }));
    expect(facts.annualRevenue).toEqual(aed(234_000_000n));
    expect(facts.annualOperatingCashFlow).toEqual(aed(31_000_000n));
    expect(facts.existingAnnualDebtService).toEqual(aed(18_000_000n));
    expect(facts.fullTimeEmployees).toBe(42);
    expect(facts.sector).toBe('TRADING');
    expect(facts.financialsSourceRef).toBe('spread:doc:stmt-annual_revenue|doc:stmt-net_profit|doc:stmt-total_debt_service');
    expect(OPERATING_CASH_FLOW_PROXY.policyRef).toMatch(/^ILLUSTRATIVE/);
  });

  it('uses the corrected value, not the OCR one', () => {
    const figures = BUSINESS_SPREAD_METRICS.map((m) => (m === 'NET_PROFIT' ? verified(m, aed(3_100_000n), SCREEN[m]) : verified(m, SCREEN[m])));
    const facts = expectOk(toBusinessFacts(expectOk(completeSpread(figures, BUSINESS_SPREAD_METRICS, 'AED')), { fullTimeEmployees: 1 }));
    expect(facts.annualOperatingCashFlow).toEqual(aed(31_000_000n));
  });

  it('refuses a fractional employee count', () => {
    expect(toBusinessFacts(screenSpread(), { fullTimeEmployees: 1.5 }).ok).toBe(false);
  });
});
