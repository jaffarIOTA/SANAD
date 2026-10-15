/**
 * K2 — a Saudi SME application through the business service, in memory, on
 * Fintech B: hand-over in SAR, the Saudi document checklist, the spread, the
 * tenant's own (ILLUSTRATIVE) assessment, security and decision-pack
 * policies, and an offer priced from the published SAIBOR benchmark plus the
 * tenant's margin — the rate publisher's reference kept on the offer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import type { FinancialMetric } from '@sanad/core/applicant/financials.ts';
import { developmentAttestation } from '../../apps/ops/src/server/store.ts';
import {
  READ_FIGURE_SOURCES,
  checklistStatus,
  decideInCommittee,
  generateOffer,
  handOver,
  ingestReadFigures,
  presentDocument,
  recordAssessmentInputs,
  resetBusinessStore,
  runAssessment,
  submitForAssessment,
  validateDocument,
  verifyFigure,
  proposeFigures,
} from '../../apps/ops/src/server/business.ts';
import { publishedBenchmark } from '../../apps/ops/src/server/rate-rails.ts';
import { justifyDeviations } from '../support/business-decision-pack.ts';
import { meetSecurityRequirements } from '../support/business-security.ts';

const CASES = [
  { tenant: 'fintech-b', id: 'FB-00009001', marginBp: 550n, officer: 'stf-fb-officer-01', checker: 'stf-fb-checker-01', committee: 'stf-fb-committee-01' },
  { tenant: 'bank-a', id: 'BA-00009001', marginBp: 400n, officer: 'stf-maker-01', checker: 'stf-checker-01', committee: 'stf-committee-01' },
] as const;

const FIGURES: readonly [FinancialMetric, string, bigint][] = [
  ['ANNUAL_REVENUE', 'FY2025', 520_000_000n],
  ['PRIOR_YEAR_REVENUE', 'FY2024', 480_000_000n],
  ['NET_PROFIT', 'FY2025', 90_000_000n],
  ['TOTAL_DEBT_SERVICE', 'FY2025', 6_000_000n],
  ['CURRENT_ASSETS', 'FY2025', 160_000_000n],
  ['CURRENT_LIABILITIES', 'FY2025', 95_000_000n],
  ['MONTHLY_GROSS_SALARY', '2026-09', 4_200_000n],
];

const DAY_MS = 86_400_000;
const isoAfter = (days: number): string => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetBusinessStore({ seed: false });
});

describe('a Saudi SME application', () => {
  it.each(CASES)('$tenant: hands over in SAR, assesses on the tenant’s policy, and offers at SAIBOR + the tenant’s margin', async ({ tenant: TENANT, id: ID, marginBp, officer, checker, committee }) => {
    expectOk(
      await handOver(
        TENANT,
        {
          applicationId: ID,
          upstreamRef: `upstream-${ID}`,
          applicant: {
            businessNameEn: 'Jeddah Example Services Co',
            registrationRef: '4030000202',
            sector: 'TRADING',
            yearsInOperation: 5,
            owners: [{ displayName: 'Owner Example', ref: 'owner-fb-9001' }],
            upstreamVerificationRefs: ['nafath:assert-test', 'simah:consent-test'],
          },
          productCode: 'sme-term-conventional',
          variantCode: 'SME_TERM',
          purpose: 'WORKING_CAPITAL',
          requestedMinorUnits: 80_000_000n,
          tenorMonths: 36,
          graceMonths: 0,
          contributionPerTenThousand: 2_000,
          contact: { partyRef: 'owner-fb-9001', emailMasked: 'o***@example.sa', mobileMasked: '+966 5X XXX XXXX' },
        },
        'upstream-record-fb',
      ),
    );

    // The spread: read figures in, the officer's keyed figure verified by the checker.
    expectOk(
      await ingestReadFigures(
        TENANT,
        ID,
        FIGURES.map(([metric, periodLabel, minorUnits]) => ({ metric, periodLabel, minorUnits, sourceKind: 'OCR' as const, sourceRef: 'doc-statements' })),
        READ_FIGURE_SOURCES.ocr,
      ),
    );
    const keyed = expectOk(
      await proposeFigures(TENANT, ID, [{ metric: 'MONTHLY_DEBT_OBLIGATIONS', periodLabel: '2026-09', minorUnits: 700_000n, sourceRef: 'doc-simah' }], officer),
    );
    for (const f of keyed.figures) expectOk(await verifyFigure(TENANT, ID, f.figureId, f.figure.sourceKind === 'OFFICER_ENTRY' ? checker : officer));

    // The Saudi checklist: CR, articles, national ids, SIMAH, zakat, GOSI…
    const checklist = expectOk(await checklistStatus(TENANT, ID));
    expect(checklist.checklist.programmeId).toBe('sme-sa-term');
    expect(checklist.checklist.items.map((i) => i.documentType)).toEqual(
      expect.arrayContaining(['COMMERCIAL_REGISTRATION', 'OWNER_NATIONAL_ID', 'SIMAH_COMMERCIAL_REPORT', 'ZAKAT_CERTIFICATE', 'GOSI_CERTIFICATE']),
    );
    for (const item of checklist.checklist.items.filter((i) => i.required)) {
      const ref = `doc-fb-${item.documentType}`;
      expectOk(await presentDocument(TENANT, ID, { documentType: item.documentType, documentRef: ref }, officer));
      expectOk(await validateDocument(TENANT, ID, ref, 'VALID', checker));
    }

    expectOk(
      await recordAssessmentInputs(
        TENANT,
        ID,
        {
          bureau: { reportRef: 'simah:report-test', consentId: 'simah:consent-test', score: 760n },
          fullTimeEmployees: 25,
          relevantExperienceYears: 6n,
          sectorPriority: 'PRIORITY',
          auditedFinancialsAvailable: true,
          commitmentRatioPerTenThousand: 10_200n,
          riskAnalysisScorePerTenThousand: 7_400n,
          portfolioRepaymentPerTenThousand: 8_600n,
          failedFilesRatePerTenThousand: 800n,
          collateralValueMinorUnits: 100_000_000n,
        },
        officer,
      ),
    );
    await meetSecurityRequirements(TENANT, ID, officer, checker, 100_000_000n, BigInt(Math.floor(Date.now() / 1000)) - 86_400n);
    expectOk(await submitForAssessment(TENANT, ID, officer));
    const assessed = expectOk(await runAssessment(TENANT, ID, checker));
    expect(assessed.latestAssessment?.assessment.policyId).toBe('sme-direct-lending-assessment-sa');
    if (assessed.application.status === 'IN_COMMITTEE') {
      await justifyDeviations(TENANT, ID, checker);
      expectOk(await decideInCommittee(TENANT, ID, { decidedBy: committee, approved: true, reason: 'Within risk-aligned terms' }));
    }

    const offered = expectOk(await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(2), firstDueDate: isoAfter(32) }));
    const terms = offered.latestOffer?.terms;
    const saibor = await publishedBenchmark(TENANT, 'SAIBOR-3M', developmentAttestation());
    expect(saibor).toBeDefined();
    expect(terms?.facilityAmount.currency).toBe('SAR');
    expect(terms?.rateBp).toBe((saibor?.rate.bp ?? 0n) + marginBp);
    expect(terms?.rateSourceRef).toBe(saibor?.referenceId);
    expect(terms?.aprBp).toBeGreaterThan(terms?.rateBp ?? 0n);
  });
});
