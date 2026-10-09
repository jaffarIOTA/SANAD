/**
 * Approved terms on the decision (UAE SME direct lending, stage 6 → 7).
 *
 * The core banking partner's prototype (docs/partners/tuum/prototype-2026-10-08,
 * screens 03, 06, 08, 09; SME-TRACEABILITY.md) shows an application requesting
 * AED 5,000,000 over 72 months approved and offered at AED 2,000,000 over 60
 * months: the LOW risk band (up to AED 2,000,000, at least 20% contribution)
 * and the Fixed Assets variant (12–60 months, up to AED 2,000,000) cap what the
 * committee approves.
 *
 * Each refusal case attempts an approval the limits forbid and passes only
 * when it is refused with its reason and control code; the request is never
 * overwritten; the offer, its schedule and the disbursement are on the
 * approved figures; four eyes is unchanged.
 */
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FinancialMetric } from '@sanad/core/applicant/financials.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import {
  type ApprovalContext,
  type ApprovalLimits,
  type BusinessApplication,
  type HandoverInput,
  approveStraightThrough as approveStraightThroughCore,
  approvedTermsOf,
  checkApprovedTerms,
  decideInCommittee as decideInCommitteeCore,
  defaultApprovedTerms,
  receiveHandover,
  recordAssessment,
  recordOfferSent,
  startSpreading,
  submitForAssessment as submitForAssessmentCore,
} from '@sanad/core/origination/business-application.ts';
import { decodeJson, encodeJson } from '@sanad/origination/codec.ts';

import {
  type HandoverRequest,
  READ_FIGURE_SOURCES,
  SEED_PRINCIPALS,
  checklistStatus,
  committeeApprovalDefaults,
  decideInCommittee,
  generateOffer,
  getApplication,
  handOver,
  ingestReadFigures,
  presentDocument,
  proposeFigures,
  queuedBusinessNotifications,
  recordAssessmentInputs,
  recordDisbursed,
  recordSigned,
  resetBusinessStore,
  runAssessment,
  sendOffer,
  submitForAssessment,
  validateDocument,
  verifyFigure,
} from '../../apps/ops/src/server/business.ts';
import { toStatusWire } from '../../apps/ops/src/app/api/origination/v1/business-applications/shared.ts';

const aed = (fils: bigint) => money(fils, 'AED');
const T = 1_800_000_000n;

// =============================================================================
// The domain: pure, clock-free
// =============================================================================

/** The LOW band and the Fixed Assets variant as the fund's (ILLUSTRATIVE) configuration gives them. */
const LIMITS: ApprovalLimits = {
  riskLevel: 'LOW',
  riskBandMaxAmount: aed(200_000_000n),
  riskBandMinContributionPerTenThousand: 2000,
  variantCode: 'FIXED_ASSETS',
  minAmount: aed(5_000_000n),
  variantMaxAmount: aed(200_000_000n),
  variantMinMonths: 12,
  variantMaxMonths: 60,
  variantMinContributionPerTenThousand: 2000,
  variantMaxContributionPerTenThousand: 10_000,
};
const CONTEXT: ApprovalContext = { tenantCurrency: 'AED', limits: LIMITS };

/** The prototype's request: AED 5,000,000 over 72 months, Fixed Assets, 20% contribution. */
const PROTOTYPE: HandoverInput = {
  applicationId: 'FR-00005061',
  upstreamRef: 'cif-prototype',
  tenantId: 'sme-fund-ae',
  applicant: {
    businessNameEn: 'Prototype Example Services LLC',
    registrationRef: 'licence-ref-proto',
    sector: 'SERVICES',
    yearsInOperation: 4,
    owners: [{ displayName: 'Owner Example', ref: 'owner-proto' }],
    upstreamVerificationRefs: ['uaepass-proto'],
  },
  productCode: 'sme-term-conventional',
  variantCode: 'FIXED_ASSETS',
  purpose: 'EQUIPMENT',
  requested: aed(500_000_000n),
  tenorMonths: 72,
  graceMonths: 0,
  contributionPerTenThousand: 2000,
};

function inCommittee(over: Partial<HandoverInput> = {}): BusinessApplication {
  const received = expectOk(receiveHandover({ ...PROTOTYPE, ...over }, 'AED', 'cif', T)).application;
  const spreading = expectOk(startSpreading(received, 'officer-1', T + 1n)).application;
  const ready = { spreadComplete: true, missingFigures: [], checklistComplete: true, missingDocuments: [] };
  const submitted = expectOk(submitForAssessmentCore(spreading, ready, 'officer-1', T + 2n)).application;
  return expectOk(
    recordAssessment(submitted, { outcome: 'COMMITTEE', riskLevel: 'LOW', assessmentRef: 'asm-1' }, 'engine', T + 3n),
  ).application;
}

const approve = (
  app: BusinessApplication,
  terms: { amount?: bigint; tenorMonths?: number } = {},
  context: ApprovalContext | undefined = CONTEXT,
  decidedBy = 'mcc-1',
) =>
  decideInCommitteeCore(
    app,
    {
      decidedBy,
      approved: true,
      reason: 'Within the LOW band at the variant maximum',
      terms: {
        ...(terms.amount === undefined ? {} : { amount: aed(terms.amount) }),
        ...(terms.tenorMonths === undefined ? {} : { tenorMonths: terms.tenorMonths }),
      },
    },
    T + 4n,
    context,
  );

function expectRefusal(r: Result<unknown>, control: string, reason: string): void {
  expect(r.ok, reason).toBe(false);
  if (!r.ok) expect({ control: r.error.control, reason: r.error.reason }).toEqual({ control, reason });
}

describe('the committee approves less than was requested, and records it', () => {
  it('approves AED 2,000,000 / 60 months against a 5,000,000 / 72 request; the request is unchanged', () => {
    const app = inCommittee();
    const t = expectOk(approve(app, { amount: 200_000_000n, tenorMonths: 60 }));
    expect(t.application.status).toBe('APPROVED');
    expect(t.application.approvedTerms).toEqual({
      amount: aed(200_000_000n),
      tenorMonths: 60,
      basis: 'COMMITTEE',
      limits: LIMITS,
    });
    expect(t.application.requested).toEqual(aed(500_000_000n));
    expect(t.application.tenorMonths).toBe(72);
    expect(t.event).toMatchObject({
      eventType: 'COMMITTEE_APPROVED',
      detail: {
        requestedMinorUnits: '500000000',
        requestedTenorMonths: '72',
        approvedMinorUnits: '200000000',
        approvedTenorMonths: '60',
        currency: 'AED',
      },
    });
  });

  it('defaults to the lower of the request and the band maximum, and of the requested tenor and the variant maximum', () => {
    const app = inCommittee();
    expect(defaultApprovedTerms(app, LIMITS)).toEqual({ amount: aed(200_000_000n), tenorMonths: 60 });
    const t = expectOk(approve(app));
    expect(t.application.approvedTerms?.amount).toEqual(aed(200_000_000n));
    expect(t.application.approvedTerms?.tenorMonths).toBe(60);
    // A request already inside every limit defaults to itself.
    const small = inCommittee({ requested: aed(80_000_000n), tenorMonths: 36 });
    expect(defaultApprovedTerms(small, LIMITS)).toEqual({ amount: aed(80_000_000n), tenorMonths: 36 });
  });

  it('a decline records no approved terms and needs no limits', () => {
    const declined = expectOk(
      decideInCommitteeCore(inCommittee(), { decidedBy: 'mcc-1', approved: false, reason: 'Outside appetite' }, T + 4n),
    ).application;
    expect(declined.status).toBe('DECLINED');
    expect(declined.approvedTerms).toBeUndefined();
    expect(approvedTermsOf(declined)).toBeUndefined();
  });
});

describe('the committee cannot approve what the limits forbid', () => {
  const app = inCommittee();

  it('refuses an approved amount above the request (OP-LIMIT)', () => {
    // A request inside the band: approving more than it asked is still refused.
    const small = inCommittee({ requested: aed(100_000_000n), tenorMonths: 48 });
    expectRefusal(
      approve(small, { amount: 150_000_000n, tenorMonths: 48 }),
      'OP-LIMIT',
      'APPROVED_AMOUNT_ABOVE_REQUESTED',
    );
  });

  it('refuses an approved tenor above the requested tenor (OP-LIMIT)', () => {
    const short = inCommittee({ requested: aed(100_000_000n), tenorMonths: 36 });
    expectRefusal(
      approve(short, { amount: 100_000_000n, tenorMonths: 48 }),
      'OP-LIMIT',
      'APPROVED_TENOR_ABOVE_REQUESTED',
    );
  });

  it('refuses an approved amount above the risk band’s maximum (OP-LIMIT)', () => {
    expectRefusal(
      approve(app, { amount: 200_000_001n, tenorMonths: 60 }),
      'OP-LIMIT',
      'APPROVED_AMOUNT_ABOVE_RISK_BAND',
    );
  });

  it('refuses an approved amount above the variant maximum, even within a wider band (OP-LIMIT)', () => {
    const wideBand: ApprovalContext = {
      tenantCurrency: 'AED',
      limits: { ...LIMITS, riskLevel: 'VERY_LOW', riskBandMaxAmount: aed(300_000_000n) },
    };
    expectRefusal(
      approve(app, { amount: 250_000_000n, tenorMonths: 60 }, wideBand),
      'OP-LIMIT',
      'APPROVED_AMOUNT_ABOVE_VARIANT',
    );
  });

  it('refuses an approved amount below the product minimum (OP-LIMIT)', () => {
    expectRefusal(approve(app, { amount: 4_999_999n, tenorMonths: 60 }), 'OP-LIMIT', 'APPROVED_AMOUNT_BELOW_MINIMUM');
  });

  it('refuses an approved tenor outside the variant’s band (OP-LIMIT)', () => {
    expectRefusal(approve(app, { amount: 200_000_000n, tenorMonths: 6 }), 'OP-LIMIT', 'APPROVED_TENOR_OUTSIDE_VARIANT');
    // 72 is within the request but above the variant's 60.
    expectRefusal(
      approve(app, { amount: 200_000_000n, tenorMonths: 72 }),
      'OP-LIMIT',
      'APPROVED_TENOR_OUTSIDE_VARIANT',
    );
  });

  it('refuses an approved tenor not longer than the grace period (OP-LIMIT)', () => {
    const grace = inCommittee({ graceMonths: 12 });
    const tight: ApprovalContext = { tenantCurrency: 'AED', limits: { ...LIMITS, variantMinMonths: 6 } };
    expectRefusal(
      approve(grace, { amount: 200_000_000n, tenorMonths: 12 }, tight),
      'OP-LIMIT',
      'APPROVED_TENOR_NOT_ABOVE_GRACE',
    );
  });

  it('refuses a zero or negative amount, a non-whole tenor, and another currency (OP-DETERMINACY)', () => {
    expectRefusal(approve(app, { amount: 0n, tenorMonths: 60 }), 'OP-DETERMINACY', 'APPROVED_AMOUNT_NOT_POSITIVE');
    expectRefusal(approve(app, { amount: -1n, tenorMonths: 60 }), 'OP-DETERMINACY', 'APPROVED_AMOUNT_NOT_POSITIVE');
    expectRefusal(approve(app, { amount: 200_000_000n, tenorMonths: 0 }), 'OP-DETERMINACY', 'APPROVED_TENOR_INVALID');
    expectRefusal(
      approve(app, { amount: 200_000_000n, tenorMonths: 59.5 }),
      'OP-DETERMINACY',
      'APPROVED_TENOR_INVALID',
    );
    expectRefusal(
      checkApprovedTerms(app, { amount: money(200_000_000n, 'SAR'), tenorMonths: 60 }, LIMITS, 'AED'),
      'OP-DETERMINACY',
      'APPROVED_CURRENCY_NOT_TENANTS',
    );
  });

  it('re-checks the contribution against the band’s minimum and the variant’s band (OP-LIMIT)', () => {
    // The contribution is a share of the project cost, not of the financing: approving less does not change it.
    const low = inCommittee({ contributionPerTenThousand: 1500 });
    const lenientVariant: ApprovalContext = {
      tenantCurrency: 'AED',
      limits: { ...LIMITS, variantMinContributionPerTenThousand: 0 },
    };
    expectRefusal(
      approve(low, { amount: 200_000_000n, tenorMonths: 60 }, lenientVariant),
      'OP-LIMIT',
      'CONTRIBUTION_BELOW_RISK_BAND',
    );
    const strictVariant: ApprovalContext = {
      tenantCurrency: 'AED',
      limits: { ...LIMITS, variantMinContributionPerTenThousand: 3000 },
    };
    expectRefusal(
      approve(app, { amount: 200_000_000n, tenorMonths: 60 }, strictVariant),
      'OP-LIMIT',
      'CONTRIBUTION_OUTSIDE_VARIANT',
    );
  });

  it('refuses an approval without a risk band, without the context, or against another variant’s limits', () => {
    expectRefusal(approve(app, {}, { tenantCurrency: 'AED' }), 'OP-DETERMINACY', 'RISK_BAND_REQUIRED');
    expectRefusal(
      decideInCommitteeCore(app, { decidedBy: 'mcc-1', approved: true, reason: 'no context' }, T + 4n),
      'OP-DETERMINACY',
      'APPROVAL_CONTEXT_REQUIRED',
    );
    expectRefusal(
      approve(app, {}, { tenantCurrency: 'AED', limits: { ...LIMITS, variantCode: 'EXPANSION' } }),
      'OP-DETERMINACY',
      'APPROVAL_LIMITS_MISMATCH',
    );
  });

  it('four eyes first: the submitting officer is refused as such, whatever figures they enter', () => {
    expectRefusal(
      approve(app, { amount: 200_000_000n, tenorMonths: 60 }, CONTEXT, 'officer-1'),
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_APPROVAL',
    );
    expectRefusal(
      approve(app, { amount: 900_000_000n, tenorMonths: 99 }, CONTEXT, 'officer-1'),
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_APPROVAL',
    );
    expect(app.status).toBe('IN_COMMITTEE');
  });
});

describe('straight through, and records decided before approved terms', () => {
  it('a straight-through approval records approved = requested, explicitly', () => {
    const received = expectOk(
      receiveHandover({ ...PROTOTYPE, requested: aed(40_000_000n), tenorMonths: 24 }, 'AED', 'cif', T),
    ).application;
    const ready = { spreadComplete: true, missingFigures: [], checklistComplete: true, missingDocuments: [] };
    const submitted = expectOk(
      submitForAssessmentCore(
        expectOk(startSpreading(received, 'officer-1', T + 1n)).application,
        ready,
        'officer-1',
        T + 2n,
      ),
    ).application;
    const assessed = expectOk(
      recordAssessment(
        submitted,
        { outcome: 'STRAIGHT_THROUGH', riskLevel: 'LOW', assessmentRef: 'a' },
        'engine',
        T + 3n,
      ),
    ).application;
    expectRefusal(
      approveStraightThroughCore(assessed, 'officer-1', T + 4n),
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_APPROVAL',
    );
    const t = expectOk(approveStraightThroughCore(assessed, 'checker-1', T + 4n));
    expect(t.application.approvedTerms).toEqual({
      amount: aed(40_000_000n),
      tenorMonths: 24,
      basis: 'STRAIGHT_THROUGH_AS_REQUESTED',
    });
    expect(t.event.detail).toMatchObject({ approvedMinorUnits: '40000000', approvedTenorMonths: '24' });
  });

  it('a record decided before this change reads with approved = requested, through the stored JSON', () => {
    // As 0016's record column held it before approved terms existed: an approval with no approvedTerms key.
    const approvedBefore: BusinessApplication = {
      ...inCommittee(),
      status: 'APPROVED',
      stage: 6,
      committee: { decidedBy: 'mcc-1', approved: true, reason: 'before the change', atEpochSeconds: T + 4n },
    };
    const stored = decodeJson(encodeJson(approvedBefore)) as BusinessApplication;
    expect(stored.approvedTerms).toBeUndefined();
    expect(approvedTermsOf(stored)).toEqual({
      amount: aed(500_000_000n),
      tenorMonths: 72,
      basis: 'RECORDED_BEFORE_APPROVED_TERMS',
    });
    // Sent before the change: still read as the request.
    const sent = expectOk(recordOfferSent(stored, { letterVersion: 'a'.repeat(64), channels: ['EMAIL'] }, 'o', T + 5n));
    expect(approvedTermsOf(sent.application)?.basis).toBe('RECORDED_BEFORE_APPROVED_TERMS');
    // Undecided: none.
    expect(approvedTermsOf(inCommittee())).toBeUndefined();
  });
});

// =============================================================================
// The service: the partner's prototype end to end, in memory
// =============================================================================

const TENANT = 'sme-fund-ae' as const;
const ID = 'FR-00005061';
const { officer, checker, committee, finance } = SEED_PRINCIPALS;

const handover: HandoverRequest = {
  applicationId: ID,
  upstreamRef: 'upstream-prototype-5061',
  applicant: {
    businessNameEn: 'Prototype Example Services LLC',
    businessNameAr: 'شركة النموذج للخدمات ذ.م.م',
    registrationRef: 'TL-PROTO-5061',
    sector: 'SERVICES',
    yearsInOperation: 4,
    owners: [{ displayName: 'Prototype Owner Example', ref: 'owner-proto-5061' }],
    upstreamVerificationRefs: ['uaepass:assert-proto', 'aecb:consent-proto'],
  },
  productCode: 'sme-term-conventional',
  variantCode: 'FIXED_ASSETS',
  purpose: 'EQUIPMENT',
  requestedMinorUnits: 500_000_000n,
  tenorMonths: 72,
  graceMonths: 0,
  contributionPerTenThousand: 2_000,
  contact: { partyRef: 'owner-proto-5061', emailMasked: 'p***@example.com', mobileMasked: '+971 50 XXX XXXX' },
};

const FIGURES: readonly [FinancialMetric, string, bigint][] = [
  ['ANNUAL_REVENUE', 'FY2028', 520_000_000n],
  ['PRIOR_YEAR_REVENUE', 'FY2027', 480_000_000n],
  ['NET_PROFIT', 'FY2028', 90_000_000n],
  ['TOTAL_DEBT_SERVICE', 'FY2028', 6_000_000n],
  ['CURRENT_ASSETS', 'FY2028', 160_000_000n],
  ['CURRENT_LIABILITIES', 'FY2028', 95_000_000n],
  ['MONTHLY_GROSS_SALARY', '2029-06', 4_200_000n],
];

const INPUTS = {
  // Chosen to score in the LOW band (70–85 under the fund's ILLUSTRATIVE scorecard), as the prototype's case does.
  bureau: { reportRef: 'aecb:report-proto', consentId: 'aecb:consent-proto', score: 720n },
  fullTimeEmployees: 20,
  relevantExperienceYears: 6n,
  sectorPriority: 'NON_PRIORITY',
  auditedFinancialsAvailable: true,
  commitmentRatioPerTenThousand: 10_200n,
  riskAnalysisScorePerTenThousand: 7_400n,
  portfolioRepaymentPerTenThousand: 8_600n,
  failedFilesRatePerTenThousand: 800n,
  // 120% of the AED 5,000,000 requested.
  collateralValueMinorUnits: 600_000_000n,
} as const;

/** Hand-over to the committee, through the real functions. */
async function driveToCommittee(): Promise<void> {
  expect((await handOver(TENANT, handover, 'upstream-record-dev-01')).ok).toBe(true);
  const read = await ingestReadFigures(
    TENANT,
    ID,
    FIGURES.map(([metric, periodLabel, minorUnits]) => ({
      metric,
      periodLabel,
      minorUnits,
      sourceKind: 'OCR' as const,
      sourceRef: 'doc-proto-statements',
    })),
    READ_FIGURE_SOURCES.ocr,
  );
  expect(read.ok).toBe(true);
  const keyed = expectOk(
    await proposeFigures(
      TENANT,
      ID,
      [
        {
          metric: 'MONTHLY_DEBT_OBLIGATIONS',
          periodLabel: '2029-06',
          minorUnits: 700_000n,
          sourceRef: 'doc-proto-bureau',
        },
      ],
      officer,
    ),
  );
  for (const f of keyed.figures)
    expectOk(await verifyFigure(TENANT, ID, f.figureId, f.figure.sourceKind === 'OFFICER_ENTRY' ? checker : officer));
  const checklist = expectOk(await checklistStatus(TENANT, ID));
  for (const item of checklist.checklist.items.filter((i) => i.required)) {
    const documentRef = `doc-proto-${item.documentType}`;
    expectOk(await presentDocument(TENANT, ID, { documentType: item.documentType, documentRef }, officer));
    expectOk(await validateDocument(TENANT, ID, documentRef, 'VALID', checker));
  }
  expectOk(await recordAssessmentInputs(TENANT, ID, INPUTS, officer));
  expectOk(await submitForAssessment(TENANT, ID, officer));
  const assessed = expectOk(await runAssessment(TENANT, ID, checker));
  expect(assessed.application.status).toBe('IN_COMMITTEE');
  expect(assessed.latestAssessment?.assessment.riskLevel).toBe('LOW');
}

// The prototype's offer is dated: offered late July 2029, disbursed 4 August 2029, first due 10 September 2029.
const PROTOTYPE_TODAY = new Date('2029-07-25T06:00:00Z');

// number, due date, opening balance, principal, interest, instalment, closing balance — in fils, from
// test/unit/tuum-prototype-schedule.test.ts (the partner's screen 09, reproduced to the fil).
const SCREEN_ROWS: readonly (readonly [number, string, bigint, bigint, bigint, bigint, bigint])[] = [
  [1, '2029-09-10', 200_000_000n, 3_158_808n, 304_110n, 3_462_918n, 196_841_192n],
  [2, '2029-10-10', 196_841_192n, 3_220_237n, 242_681n, 3_462_918n, 193_620_955n],
  [59, '2034-07-10', 6_912_893n, 3_454_395n, 8_523n, 3_462_918n, 3_458_498n],
  [60, '2034-08-10', 3_458_498n, 3_458_498n, 4_406n, 3_462_904n, 0n],
];

describe('the partner’s prototype through the service: 5,000,000 / 72 requested, 2,000,000 / 60 approved and offered', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(PROTOTYPE_TODAY);
    resetBusinessStore({ seed: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults, approves, offers, schedules and disburses on the approved figures', async () => {
    await driveToCommittee();

    // The screen's defaults come from the server.
    const defaults = await committeeApprovalDefaults(TENANT, ID);
    expect(defaults?.amount).toEqual(aed(200_000_000n));
    expect(defaults?.tenorMonths).toBe(60);
    expect(defaults?.limits).toMatchObject({ riskLevel: 'LOW', variantCode: 'FIXED_ASSETS', variantMaxMonths: 60 });

    // The officer who submitted still cannot decide (four eyes unchanged).
    expectRefusal(
      await decideInCommittee(TENANT, ID, {
        decidedBy: officer,
        approved: true,
        reason: 'own case',
        approvedAmountMinorUnits: 200_000_000n,
        approvedTenorMonths: 60,
      }),
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_APPROVAL',
    );
    // The refusals travel from the service with their codes, and nothing is recorded.
    const attempt = (approvedAmountMinorUnits: bigint, approvedTenorMonths: number) =>
      decideInCommittee(TENANT, ID, {
        decidedBy: committee,
        approved: true,
        reason: 'MCC',
        approvedAmountMinorUnits,
        approvedTenorMonths,
      });
    expectRefusal(await attempt(500_000_001n, 60), 'OP-LIMIT', 'APPROVED_AMOUNT_ABOVE_REQUESTED');
    expectRefusal(await attempt(300_000_000n, 60), 'OP-LIMIT', 'APPROVED_AMOUNT_ABOVE_RISK_BAND');
    expectRefusal(await attempt(200_000_000n, 72), 'OP-LIMIT', 'APPROVED_TENOR_OUTSIDE_VARIANT');
    expectRefusal(await attempt(200_000_000n, 6), 'OP-LIMIT', 'APPROVED_TENOR_OUTSIDE_VARIANT');
    expect((await getApplication(TENANT, ID))?.application.status).toBe('IN_COMMITTEE');

    const approved = expectOk(await attempt(200_000_000n, 60));
    expect(approved.application.status).toBe('APPROVED');
    expect(approved.approvedTerms).toMatchObject({ amount: aed(200_000_000n), tenorMonths: 60, basis: 'COMMITTEE' });
    expect(approved.application.requested).toEqual(aed(500_000_000n));
    expect(approved.application.tenorMonths).toBe(72);
    const decision = approved.events.find((e) => e.eventType === 'COMMITTEE_APPROVED');
    expect(decision?.detail).toMatchObject({ requestedMinorUnits: '500000000', approvedMinorUnits: '200000000' });

    // The read model carries both.
    expect(toStatusWire(approved)).toMatchObject({
      requestedMinorUnits: '500000000',
      requestedTenorMonths: 72,
      approvedTerms: { amountMinorUnits: '200000000', tenorMonths: 60, basis: 'COMMITTEE' },
    });

    // The offer: quote, schedule, letter and totals on 2,000,000 / 60 — the partner's screen, to the fil.
    const offered = expectOk(
      await generateOffer(TENANT, ID, officer, { disbursementDate: '2029-08-04', firstDueDate: '2029-09-10' }),
    );
    const offer = offered.latestOffer;
    expect(offer?.terms.facilityAmount).toEqual(aed(200_000_000n));
    expect(offer?.terms.months).toBe(60);
    expect(offer?.terms.monthlyInstalment.minorUnits).toBe(3_462_918n);
    expect(offer?.terms.totalInterest.minorUnits).toBe(7_775_066n);
    expect(offer?.terms.totalPayable.minorUnits).toBe(207_775_066n);
    expect(offer?.schedule.rows).toHaveLength(60);
    expect(offer?.schedule.totalPrincipal.minorUnits).toBe(200_000_000n);
    for (const [n, due, opening, principal, interest, instalment, closing] of SCREEN_ROWS) {
      const row = offer?.schedule.rows.find((r) => r.number === n);
      expect(row, `row ${String(n)}`).toMatchObject({
        dueDate: due,
        openingBalance: aed(opening),
        principal: aed(principal),
        interest: aed(interest),
        instalment: aed(instalment),
        closingBalance: aed(closing),
      });
    }
    expect(offer?.letter.currency).toBe('AED');
    expect(
      JSON.stringify(offer?.letter.terms, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).toContain('2,000,000');

    // Sent, signed, disbursed: the payment instruction is for the approved amount, not the request.
    expectOk(await sendOffer(TENANT, ID, officer));
    expectOk(await recordSigned(TENANT, ID, { letterVersion: offer?.letter.version ?? '' }, officer));
    vi.setSystemTime(new Date('2029-08-04T06:00:00Z'));
    expectOk(await recordDisbursed(TENANT, ID, finance));
    const payment = queuedBusinessNotifications().find((e) => e.subjectRef === ID && e.kind === 'PAYMENT_DISBURSE');
    expect(payment?.payload['minorUnits']).toBe('200000000');
  });
});

// =============================================================================
// A record decided before this change, loaded from the database
// =============================================================================

describe.skipIf(process.env['SANAD_DATABASE_URL'] !== undefined)(
  'a pre-change record loaded from the business table',
  () => {
    afterEach(() => resetBusinessStore({ seed: false }));

    it('reads with approved = requested, labelled as such, and the record is not rewritten', async () => {
      const received = expectOk(receiveHandover({ ...PROTOTYPE, applicationId: 'FR-00005999' }, 'AED', 'cif', T));
      const before: BusinessApplication = {
        ...received.application,
        status: 'APPROVED',
        stage: 6,
        committee: { decidedBy: 'mcc-1', approved: true, reason: 'decided before the change', atEpochSeconds: T },
      };
      const statements: string[] = [];
      const answer = (sql: string) => {
        statements.push(sql);
        if (sql.includes('from core.tenant')) return { rows: [{ id: '00000000-0000-4000-8000-0000000000ae' }] };
        if (sql.startsWith('select record'))
          return { rows: [{ record: encodeJson(before), status: 'APPROVED', updated_at: '2026-10-01 10:00:00+00' }] };
        return { rows: [] };
      };
      const pool = {
        query: (sql: string) => Promise.resolve(answer(sql)),
        connect: () =>
          Promise.resolve({ query: (sql: string) => Promise.resolve(answer(sql)), release: () => undefined }),
      } as unknown as Pool;
      resetBusinessStore({ seed: false, pool });
      const view = await getApplication(TENANT, 'FR-00005999');
      expect(view?.application.approvedTerms).toBeUndefined();
      expect(view?.approvedTerms).toEqual({
        amount: aed(500_000_000n),
        tenorMonths: 72,
        basis: 'RECORDED_BEFORE_APPROVED_TERMS',
      });
      expect(view === undefined ? undefined : toStatusWire(view).approvedTerms).toEqual({
        amountMinorUnits: '500000000',
        tenorMonths: 72,
        basis: 'RECORDED_BEFORE_APPROVED_TERMS',
      });
      // Reading wrote nothing.
      expect(statements.some((s) => /^\s*(insert|update|delete)\b/i.test(s))).toBe(false);
    });
  },
);
