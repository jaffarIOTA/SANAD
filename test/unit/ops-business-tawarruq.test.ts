/**
 * K4 — an SME Tawarruq through the business service on Bank A: offered as a
 * deferred sale (commodity cost, profit, deferred price), signed through
 * Nafath, then the commodity steps in order through the board-approved broker
 * — buy at exactly the quoted cost, sell to the customer on the signed
 * instrument, title, sell on — and only then a single payment of the proceeds,
 * booked in the loan system under ADR 0007.
 *
 * The product is ENABLED IN THIS TEST ONLY, through a mocked catalogue with a
 * reference that is plainly not a ruling. The checked-in catalogue keeps it
 * disabled until the bank's Shariah board ruling is recorded through Admin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sanad/config/loader.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sanad/config/loader.ts')>();
  return {
    ...actual,
    loadProductCatalogue: (tenant: Parameters<typeof actual.loadProductCatalogue>[0]) => {
      const c = actual.loadProductCatalogue(tenant);
      if (!c.ok || tenant !== 'bank-a') return c;
      return {
        ok: true,
        value: {
          ...c.value,
          entries: c.value.entries.map((e) =>
            e.productCode === 'sme-term-islamic'
              ? { ...e, enabled: true, boardRulingRef: 'TEST-ONLY-NOT-A-BOARD-RULING' }
              : e,
          ),
        },
      };
    },
  };
});

import { expectOk } from '@sanad/core/kernel/result.ts';
import { resetShariahApprovals } from '../../services/origination/src/shariah/approvals.ts';
import { recordTestApproval } from '../support/shariah-approvals.ts';
import type { FinancialMetric } from '@sanad/core/applicant/financials.ts';
import {
  READ_FIGURE_SOURCES,
  checklistStatus,
  decideInCommittee,
  generateOffer,
  handOver,
  ingestReadFigures,
  planTranches,
  proposeRestructure,
  presentDocument,
  proposeFigures,
  queuedBusinessNotifications,
  recordAssessmentInputs,
  recordDisbursed,
  resetBusinessStore,
  runAssessment,
  sendOffer,
  submitForAssessment,
  validateDocument,
  verifyFigure,
} from '../../apps/ops/src/server/business.ts';
import { confirmSigning, startSigning } from '../../apps/ops/src/server/business-signing.ts';
import { bookInLoanSystem } from '../../apps/ops/src/server/business-booking.ts';
import {
  buyCommodity,
  sellCommodityOnBehalf,
  sellCommodityToCustomer,
  transferCommodityTitle,
} from '../../apps/ops/src/server/business-tawarruq.ts';
import { EXAMPLE_SA_IBAN, preparePayee } from '../support/business-closing.ts';
import { justifyDeviations } from '../support/business-decision-pack.ts';
import { meetSecurityRequirements } from '../support/business-security.ts';

const TENANT = 'bank-a' as const;
const ID = 'BA-00009101';
const officer = 'stf-maker-01';
const checker = 'stf-checker-01';
const committee = 'stf-committee-01';
const finance = 'stf-finance-01';
const reason = (r: { ok: boolean; error?: { reason: string } }) => (r.ok ? 'accepted' : r.error?.reason);

const FIGURES: readonly [FinancialMetric, string, bigint][] = [
  ['ANNUAL_REVENUE', 'FY2025', 520_000_000n],
  ['PRIOR_YEAR_REVENUE', 'FY2024', 480_000_000n],
  ['NET_PROFIT', 'FY2025', 90_000_000n],
  ['TOTAL_DEBT_SERVICE', 'FY2025', 6_000_000n],
  ['CURRENT_ASSETS', 'FY2025', 160_000_000n],
  ['CURRENT_LIABILITIES', 'FY2025', 95_000_000n],
  ['MONTHLY_GROSS_SALARY', '2026-09', 4_200_000n],
];

let clock = Date.now();
/** Each Tawarruq step is attested strictly after the one before: the test moves the clock two seconds per step. */
const tick = () => {
  clock += 2_000;
  vi.setSystemTime(clock);
};
const isoAfter = (days: number): string =>
  new Date(clock + 3 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);

beforeEach(async () => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  clock = Date.now();
  vi.setSystemTime(clock);
  resetBusinessStore({ seed: false });
  // The test-only reference, recorded as an approval in force: no approval, no Tawarruq (SH-17).
  resetShariahApprovals();
  await recordTestApproval('bank-a', 'TEST-ONLY-NOT-A-BOARD-RULING', ['sme-term-islamic']);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('an SME Tawarruq on Bank A', () => {
  it('is offered as a deferred sale, executed through the broker in order, paid once, and booked', async () => {
    expectOk(
      await handOver(
        TENANT,
        {
          applicationId: ID,
          upstreamRef: 'upstream-ba-9101',
          applicant: {
            businessNameEn: 'Dammam Example Industries Co',
            registrationRef: '2050000303',
            sector: 'TRADING',
            yearsInOperation: 7,
            owners: [{ displayName: 'Owner Example', ref: 'owner-ba-9101' }],
            upstreamVerificationRefs: ['wathq:7000000303:t1', 'simah:consent-ba'],
          },
          productCode: 'sme-term-islamic',
          variantCode: 'SME_TERM',
          purpose: 'WORKING_CAPITAL',
          requestedMinorUnits: 80_000_000n,
          tenorMonths: 36,
          graceMonths: 0,
          contributionPerTenThousand: 2_000,
          contact: { partyRef: 'owner-ba-9101', mobileMasked: '+966 5X XXX XXXX' },
        },
        'upstream-record-ba',
      ),
    );
    expectOk(
      await ingestReadFigures(
        TENANT,
        ID,
        FIGURES.map(([metric, periodLabel, minorUnits]) => ({
          metric,
          periodLabel,
          minorUnits,
          sourceKind: 'OCR' as const,
          sourceRef: 'doc-statements',
        })),
        READ_FIGURE_SOURCES.ocr,
      ),
    );
    const keyed = expectOk(
      await proposeFigures(
        TENANT,
        ID,
        [{ metric: 'MONTHLY_DEBT_OBLIGATIONS', periodLabel: '2026-09', minorUnits: 700_000n, sourceRef: 'doc-simah' }],
        officer,
      ),
    );
    for (const f of keyed.figures)
      expectOk(await verifyFigure(TENANT, ID, f.figureId, f.figure.sourceKind === 'OFFICER_ENTRY' ? checker : officer));
    const checklist = expectOk(await checklistStatus(TENANT, ID));
    for (const item of checklist.checklist.items.filter((i) => i.required)) {
      const ref = `doc-ba-${item.documentType}`;
      expectOk(await presentDocument(TENANT, ID, { documentType: item.documentType, documentRef: ref }, officer));
      expectOk(await validateDocument(TENANT, ID, ref, 'VALID', checker));
    }
    // The signed deferred-sale instrument, on file for the sale step.
    expectOk(
      await presentDocument(
        TENANT,
        ID,
        { documentType: 'DEFERRED_SALE_CONTRACT', documentRef: 'doc-ba-deferred-sale' },
        officer,
      ),
    );
    expectOk(
      await recordAssessmentInputs(
        TENANT,
        ID,
        {
          bureau: { reportRef: 'simah:report-ba', consentId: 'simah:consent-ba', score: 760n },
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
    await meetSecurityRequirements(
      TENANT,
      ID,
      officer,
      checker,
      100_000_000n,
      BigInt(Math.floor(clock / 1000)) - 86_400n,
    );
    expectOk(await submitForAssessment(TENANT, ID, officer));
    const assessed = expectOk(await runAssessment(TENANT, ID, checker));
    if (assessed.application.status === 'IN_COMMITTEE') {
      await justifyDeviations(TENANT, ID, checker);
      expectOk(
        await decideInCommittee(TENANT, ID, {
          decidedBy: committee,
          approved: true,
          reason: 'Within risk-aligned terms',
        }),
      );
    }

    // The offer is a deferred sale: commodity cost + profit = deferred price; the letter speaks of profit, not interest.
    const offered = expectOk(
      await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(0), firstDueDate: isoAfter(30) }),
    );
    const terms = offered.latestOffer?.terms;
    expect(terms?.productCode).toBe('sme-term-islamic');
    expect((terms?.facilityAmount.minorUnits ?? 0n) + (terms?.totalInterest.minorUnits ?? 0n)).toBe(
      terms?.totalPayable.minorUnits,
    );
    expect(JSON.stringify(offered.latestOffer?.letter.terms)).toMatch(/[Pp]rofit/);
    // Not drawn in tranches.
    expect(
      reason(await planTranches(TENANT, ID, [{ amountMinorUnits: terms?.facilityAmount.minorUnits ?? 0n }], officer)),
    ).toBe('TRANCHES_NOT_PERMITTED');

    expectOk(await sendOffer(TENANT, ID, officer));
    expectOk(await startSigning(TENANT, ID, officer));
    expectOk(await confirmSigning(TENANT, ID, officer));
    await preparePayee(TENANT, ID, officer, checker, EXAMPLE_SA_IBAN);

    // No payment before the commodity steps; no step out of order.
    expect(reason(await recordDisbursed(TENANT, ID, finance))).toBe('TAWARRUQ_INCOMPLETE');
    expect(reason(await transferCommodityTitle(TENANT, ID, finance))).toBe('TAWARRUQ_STEP_OUT_OF_ORDER');

    tick();
    const bought = expectOk(await buyCommodity(TENANT, ID, finance));
    expect(bought.closing.tawarruq?.lot.price.minorUnits).toBe(terms?.facilityAmount.minorUnits);
    expect(bought.closing.tawarruq?.source).toBe('FIXTURE');
    tick();
    expect(reason(await sellCommodityToCustomer(TENANT, ID, 'doc-not-on-file', finance))).toBe(
      'SECURITY_EVIDENCE_NOT_ON_FILE',
    );
    expectOk(await sellCommodityToCustomer(TENANT, ID, 'doc-ba-deferred-sale', finance));
    tick();
    expectOk(await transferCommodityTitle(TENANT, ID, finance));
    tick();
    const sold = expectOk(await sellCommodityOnBehalf(TENANT, ID, 'agency-appointment-ba-9101', finance));
    expect(sold.closing.tawarruq?.state).toBe('PROCEEDS_REALISED');
    const proceeds = sold.closing.tawarruq?.proceeds;

    tick();
    const paid = expectOk(await recordDisbursed(TENANT, ID, finance));
    expect(paid.application.status).toBe('DISBURSED');
    const payment = queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'PAYMENT_DISBURSE');
    expect(payment).toHaveLength(1);
    expect(payment[0]?.payload['minorUnits']).toBe(proceeds?.minorUnits.toString());
    expect(reason(await recordDisbursed(TENANT, ID, finance))).toBe('NO_TRANCHE_TO_RELEASE');

    const booked = expectOk(await bookInLoanSystem(TENANT, ID, finance));
    expect(booked.booking).toMatchObject({ productCode: 'TAWRROUQ', source: 'FIXTURE' });

    // Servicing S3: a Tawarruq is restructured without changing what is owed.
    const proposed = expectOk(
      await proposeRestructure(
        TENANT,
        ID,
        { firstDueDate: isoAfter(45), numberOfPayments: 48, reason: 'Longer term at the customer’s request' },
        officer,
      ),
    );
    const rs = proposed.servicing?.restructures.at(-1);
    expect(rs?.totalAfter.minorUnits).toBe(rs?.outstandingBefore.minorUnits);
  });
});
