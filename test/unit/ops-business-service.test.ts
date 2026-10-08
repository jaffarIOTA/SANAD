/**
 * The workbench's business-application service: the whole stage 5–9 journey
 * through the real state machine, the refusals that keep it honest (currency,
 * identity numbers, four eyes on figures, documents, scoring and money out,
 * the signed letter, offer dates), the idempotent hand-over and send, the
 * illustrative seed — and, against a recording stand-in for the database,
 * the durability rules: the outbox in the business transaction, optimistic
 * concurrency, single-flight hydration, and no seed where production data is
 * permitted.
 */
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadOfferDatePolicy } from '@sanad/config/loader.ts';
import offerPolicyJson from '@sanad/config/tenants/sme-fund-ae/credit-policy/offer-policy.json' with { type: 'json' };
import type { FinancialMetric } from '@sanad/core/applicant/financials.ts';
import { type OfferDatePolicy, parseOfferDatePolicy } from '@sanad/core/origination/business-application.ts';

import * as businessModule from '../../apps/ops/src/server/business.ts';
import {
  SEED_PRINCIPALS,
  type HandoverRequest,
  READ_FIGURE_SOURCES,
  approveStraightThrough,
  businessOutboxStore,
  checkOfferDates,
  checklistStatus,
  decideInCommittee,
  figureReadiness,
  flushBusiness,
  generateOffer,
  getApplication,
  handOver,
  ingestReadFigures,
  listApplications,
  mutateBusiness,
  presentDocument,
  previewNotifications,
  proposeFigures,
  queuedBusinessNotifications,
  recordAssessmentInputs,
  recordDisbursed,
  recordPortfolioStatus,
  recordSigned,
  resetBusinessStore,
  runAssessment,
  sendOffer,
  submitForAssessment,
  validateDocument,
  verifyFigure,
  withdrawApplication,
} from '../../apps/ops/src/server/business.ts';

const TENANT = 'sme-fund-ae' as const;
const ID = 'FR-00009001';
const { officer, checker, committee, finance } = SEED_PRINCIPALS;

const handover = (over: Partial<HandoverRequest> = {}): HandoverRequest => ({
  applicationId: ID,
  upstreamRef: 'upstream-test-9001',
  applicant: {
    businessNameEn: 'Test Harbour Trading LLC',
    businessNameAr: 'ميناء الاختبار للتجارة ذ.م.م',
    registrationRef: 'TL-TEST-9001',
    sector: 'TRADING',
    yearsInOperation: 5,
    owners: [{ displayName: 'Test Owner Example', ref: 'owner-test-9001' }],
    upstreamVerificationRefs: ['uaepass:assert-test', 'aecb:consent-test'],
  },
  productCode: 'sme-term-conventional',
  variantCode: 'SMALL_LOAN',
  purpose: 'WORKING_CAPITAL',
  requestedMinorUnits: 80_000_000n,
  tenorMonths: 36,
  graceMonths: 0,
  contributionPerTenThousand: 2_000,
  contact: { partyRef: 'owner-test-9001', emailMasked: 't***@example.com', mobileMasked: '+971 50 XXX XXXX' },
  ...over,
});

const FIGURES: readonly [FinancialMetric, string, bigint][] = [
  ['ANNUAL_REVENUE', 'FY2025', 520_000_000n],
  ['PRIOR_YEAR_REVENUE', 'FY2024', 480_000_000n],
  ['NET_PROFIT', 'FY2025', 90_000_000n],
  ['TOTAL_DEBT_SERVICE', 'FY2025', 6_000_000n],
  ['CURRENT_ASSETS', 'FY2025', 160_000_000n],
  ['CURRENT_LIABILITIES', 'FY2025', 95_000_000n],
  ['MONTHLY_GROSS_SALARY', '2026-09', 4_200_000n],
];

const INPUTS = {
  bureau: { reportRef: 'aecb:report-test', consentId: 'aecb:consent-test', score: 760n },
  fullTimeEmployees: 25,
  relevantExperienceYears: 6n,
  sectorPriority: 'PRIORITY',
  auditedFinancialsAvailable: true,
  commitmentRatioPerTenThousand: 10_200n,
  riskAnalysisScorePerTenThousand: 7_400n,
  portfolioRepaymentPerTenThousand: 8_600n,
  failedFilesRatePerTenThousand: 800n,
  collateralValueMinorUnits: 100_000_000n,
} as const;

const expectRefused = (r: { ok: boolean; error?: { reason: string } }, reason: string): void => {
  expect(r.ok).toBe(false);
  expect(r.error?.reason).toBe(reason);
};

/** Calendar dates relative to today in Dubai, as the service computes the offer date. Test arithmetic only. */
const DAY_MS = 86_400_000;
const dubaiToday = (): number => Math.floor((Date.now() + 4 * 3_600_000) / DAY_MS) * DAY_MS;
const isoAfter = (days: number): string => new Date(dubaiToday() + days * DAY_MS).toISOString().slice(0, 10);

/** Read figures in through the system path, the one keyed figure by the officer, every figure verified. */
async function spreadAndVerify(): Promise<void> {
  expect(
    (
      await ingestReadFigures(
        TENANT,
        ID,
        FIGURES.map(([metric, periodLabel, minorUnits]) => ({
          metric,
          periodLabel,
          minorUnits,
          sourceKind: 'OCR' as const,
          sourceRef: 'doc-test-statements',
        })),
        READ_FIGURE_SOURCES.ocr,
      )
    ).ok,
  ).toBe(true);
  const keyed = await proposeFigures(
    TENANT,
    ID,
    [
      {
        metric: 'MONTHLY_DEBT_OBLIGATIONS',
        periodLabel: '2026-09',
        minorUnits: 700_000n,
        sourceRef: 'doc-test-bureau',
      },
    ],
    officer,
  );
  expect(keyed.ok).toBe(true);
  if (!keyed.ok) return;
  for (const f of keyed.value.figures) {
    expect(
      (await verifyFigure(TENANT, ID, f.figureId, f.figure.sourceKind === 'OFFICER_ENTRY' ? checker : officer)).ok,
    ).toBe(true);
  }
}

/** Every required document presented by the officer and validated by the checker. */
async function presentAndValidateDocuments(): Promise<void> {
  const checklist = await checklistStatus(TENANT, ID);
  expect(checklist.ok).toBe(true);
  if (!checklist.ok) return;
  for (const item of checklist.value.checklist.items.filter((i) => i.required)) {
    const documentRef = `doc-test-${item.documentType}`;
    expect((await presentDocument(TENANT, ID, { documentType: item.documentType, documentRef }, officer)).ok).toBe(
      true,
    );
    expect((await validateDocument(TENANT, ID, documentRef, 'VALID', checker)).ok).toBe(true);
  }
}

/** Hand-over to a committee approval, through the real functions. */
async function driveToApproved(): Promise<void> {
  expect((await handOver(TENANT, handover(), 'upstream-record-dev-01')).ok).toBe(true);
  await spreadAndVerify();
  await presentAndValidateDocuments();
  expect((await recordAssessmentInputs(TENANT, ID, INPUTS, officer)).ok).toBe(true);
  expect((await submitForAssessment(TENANT, ID, officer)).ok).toBe(true);
  expect((await runAssessment(TENANT, ID, checker)).ok).toBe(true);
  expect(
    (await decideInCommittee(TENANT, ID, { decidedBy: committee, approved: true, reason: 'Within risk-aligned terms' }))
      .ok,
  ).toBe(true);
}

describe('the business-application service — full journey in memory', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('hand-over → four-eyes figures → validated documents → submit → assess → committee → offer → send → sign → disburse', async () => {
    const received = await handOver(TENANT, handover(), 'upstream-record-dev-01');
    expect(received.ok && received.value.created).toBe(true);
    if (!received.ok) return;
    expect(received.value.view.application.requested).toEqual({ minorUnits: 80_000_000n, currency: 'AED' });
    expect(received.value.view.application.stage).toBe(5);

    const read = await ingestReadFigures(
      TENANT,
      ID,
      FIGURES.map(([metric, periodLabel, minorUnits]) => ({
        metric,
        periodLabel,
        minorUnits,
        sourceKind: 'OCR' as const,
        sourceRef: 'doc-test-statements',
      })),
      READ_FIGURE_SOURCES.ocr,
    );
    expect(read.ok && read.value.application.status).toBe('SPREADING');
    const proposed = await proposeFigures(
      TENANT,
      ID,
      [
        {
          metric: 'MONTHLY_DEBT_OBLIGATIONS',
          periodLabel: '2026-09',
          minorUnits: 700_000n,
          sourceRef: 'doc-test-bureau',
        },
      ],
      officer,
    );
    expect(proposed.ok).toBe(true);
    if (!proposed.ok) return;

    // Not submittable yet: figures unverified.
    expectRefused(await submitForAssessment(TENANT, ID, officer), 'FIGURES_NOT_VERIFIED');

    const keyed = proposed.value.figures.find((f) => f.figure.sourceKind === 'OFFICER_ENTRY');
    expect(keyed?.figure.enteredBy).toBe(officer);
    expectRefused(await verifyFigure(TENANT, ID, keyed?.figureId ?? '', officer), 'FOUR_EYES_REQUIRED');
    expect((await verifyFigure(TENANT, ID, keyed?.figureId ?? '', checker)).ok).toBe(true);
    for (const f of proposed.value.figures.filter((x) => x.figure.sourceKind === 'OCR')) {
      expect((await verifyFigure(TENANT, ID, f.figureId, officer)).ok).toBe(true);
    }
    const readiness = await figureReadiness(TENANT, ID);
    expect(readiness.ok && readiness.value.spreadComplete).toBe(true);
    if (readiness.ok) expect(readiness.value.ratios?.DEBT_SERVICE_COVER.ok).toBe(true);

    expectRefused(await submitForAssessment(TENANT, ID, officer), 'DOCUMENTS_MISSING');
    await presentAndValidateDocuments();
    const complete = await checklistStatus(TENANT, ID);
    expect(complete.ok && complete.value.complete).toBe(true);
    if (complete.ok) expect(complete.value.checklist.programmeId).toBe('sme-ae-small-loan');

    expect((await recordAssessmentInputs(TENANT, ID, INPUTS, officer)).ok).toBe(true);
    const submitted = await submitForAssessment(TENANT, ID, officer);
    expect(submitted.ok && submitted.value.application.status).toBe('SUBMITTED');

    const assessed = await runAssessment(TENANT, ID, checker);
    expect(assessed.ok).toBe(true);
    if (!assessed.ok) return;
    // AED 800,000 is above the straight-through maximum: the committee decides.
    expect(assessed.value.application.status).toBe('IN_COMMITTEE');
    const run = assessed.value.latestAssessment;
    expect(run?.assessedBy).toBe(checker);
    expect(run?.assessment.failedKnockouts).toEqual([]);
    expect(typeof run?.facts['dscrPerTenThousand']).toBe('bigint');
    expect(run?.facts['collateralCoveragePerTenThousand']).toBe(12_500n);
    expect(Object.keys(run?.factSources ?? {})).toContain('dbrBeforeLoanPerTenThousand');
    expect(assessed.value.application.assessment?.assessmentRef).toBe(run?.assessmentId);

    expectRefused(
      await decideInCommittee(TENANT, ID, { decidedBy: officer, approved: true, reason: 'own case' }),
      'FOUR_EYES_SELF_APPROVAL',
    );
    expectRefused(await approveStraightThrough(TENANT, ID, checker), 'TRANSITION_NOT_ALLOWED');
    const approved = await decideInCommittee(TENANT, ID, {
      decidedBy: committee,
      approved: true,
      reason: 'Within risk-aligned terms',
    });
    expect(approved.ok && approved.value.application.status).toBe('APPROVED');

    // Disbursed today, as planned: a disbursement before the planned date is refused (see #6 below).
    const disbursementDate = isoAfter(0);
    const offered = await generateOffer(TENANT, ID, officer, { disbursementDate, firstDueDate: isoAfter(30) });
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    const offer = offered.value.latestOffer;
    expect(offer?.letter.version).toMatch(/^[0-9a-f]{64}$/);
    expect(offer?.letter.currency).toBe('AED');
    expect(offer?.terms.rateBp).toBe(150n);
    // #10 the basis and period are the rate snapshot's, stored with the terms — not asserted by a screen.
    expect(offer?.terms.rateBasis).toBe('REDUCING');
    expect(offer?.terms.ratePeriod).toBe('ANNUAL');
    expect(offer?.terms.months).toBe(36);
    expect(offer?.schedule.dayCount).toBe('ACT/365');
    expect(offer?.schedule.rows[0]?.dueDate).toBe(isoAfter(30));
    expect(offer?.terms.totalPayable.minorUnits).toBe(80_000_000n + (offer?.terms.totalInterest.minorUnits ?? 0n));

    const preview = await previewNotifications(TENANT, ID);
    expect(preview.ok && preview.value.letterVersion).toBe(offer?.letter.version);
    if (preview.ok) expect(preview.value.sms?.to).toBe('+971 50 XXX XXXX');

    const sent = await sendOffer(TENANT, ID, officer);
    expect(sent.ok && sent.value.application.status).toBe('OFFER_SENT');
    if (sent.ok) expect(sent.value.application.offer?.channels).toEqual(['EMAIL', 'SMS']);
    const queued = queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'NOTIFICATION');
    expect(queued).toHaveLength(1);
    expect(queued[0]?.payload['event']).toBe('OFFER_ISSUED');
    expect(queued[0]?.payload['letterVersion']).toBe(offer?.letter.version);

    expectRefused(
      await recordSigned(TENANT, ID, { letterVersion: 'f'.repeat(64) }, officer),
      'SIGNED_LETTER_NOT_SENT_LETTER',
    );
    const signed = await recordSigned(TENANT, ID, { letterVersion: offer?.letter.version ?? '' }, officer);
    expect(signed.ok && signed.value.application.status).toBe('SIGNED');
    if (signed.ok) expect(signed.value.application.signature?.signatureRef).toMatch(/^uaepass-fixture:/);

    const disbursed = await recordDisbursed(TENANT, ID, finance);
    expect(disbursed.ok && disbursed.value.application.status).toBe('DISBURSED');
    if (disbursed.ok) {
      expect(disbursed.value.displayStage).toBe(8);
      expect(disbursed.value.application.disbursement?.paymentRef).toMatch(/^partner-bank-fixture:/);
    }

    // The first instalment falls due in 30 days: twelve days past due today is not possible, and is refused.
    expectRefused(
      await recordPortfolioStatus(
        TENANT,
        ID,
        { daysPastDue: 12, arrearsMinorUnits: 2_000_000n },
        'loan-system-fixture',
      ),
      'DAYS_PAST_DUE_IMPOSSIBLE',
    );
    const current = await recordPortfolioStatus(
      TENANT,
      ID,
      { daysPastDue: 0, arrearsMinorUnits: 0n },
      'loan-system-fixture',
    );
    expect(current.ok && current.value.displayStage).toBe(8);

    const final = await getApplication(TENANT, ID);
    expect(final?.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining([
        'HANDED_OVER',
        'SPREADING_STARTED',
        'FIGURE_VERIFIED',
        'DOCUMENT_PRESENTED',
        'DOCUMENT_VALIDATED',
        'SUBMITTED_FOR_ASSESSMENT',
        'ASSESSED',
        'COMMITTEE_APPROVED',
        'OFFER_GENERATED',
        'OFFER_SENT',
        'SIGNED',
        'DISBURSED',
        'PORTFOLIO_STATUS_RECORDED',
      ]),
    );
  });
});

describe('#1 a keyed figure is OFFICER_ENTRY whatever the caller says', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('records sourceKind=OCR from the workbench as OFFICER_ENTRY by the officer, who then cannot verify it', async () => {
    await handOver(TENANT, handover(), 'upstream');
    // What a tampered form would produce: an entry claiming to be OCR.
    const smuggled = {
      metric: 'NET_PROFIT' as const,
      periodLabel: 'FY2025',
      minorUnits: 90_000_000n,
      sourceRef: 'doc-test',
      sourceKind: 'OCR',
    };
    const r = await proposeFigures(TENANT, ID, [smuggled], officer);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const figure = r.value.figures.find((f) => f.figure.metric === 'NET_PROFIT');
    expect(figure?.figure.sourceKind).toBe('OFFICER_ENTRY');
    expect(figure?.figure.enteredBy).toBe(officer);
    expectRefused(await verifyFigure(TENANT, ID, figure?.figureId ?? '', officer), 'FOUR_EYES_REQUIRED');
  });

  it('accepts only read figures on the system ingestion path', async () => {
    await handOver(TENANT, handover(), 'upstream');
    const keyed = {
      metric: 'NET_PROFIT' as const,
      periodLabel: 'FY2025',
      minorUnits: 1n,
      sourceRef: 'doc',
      sourceKind: 'OFFICER_ENTRY',
    } as unknown as Parameters<typeof ingestReadFigures>[2][number];
    expectRefused(await ingestReadFigures(TENANT, ID, [keyed], READ_FIGURE_SOURCES.ocr), 'FIGURE_SOURCE_NOT_READ');
  });

  it('#4 refuses a read figure recorded by anyone but the system’s ingestion principals', async () => {
    await handOver(TENANT, handover(), 'upstream');
    const read = [
      {
        metric: 'NET_PROFIT' as const,
        periodLabel: 'FY2025',
        minorUnits: 90_000_000n,
        sourceKind: 'OCR' as const,
        sourceRef: 'doc-test',
      },
    ];
    // An officer calling the ingestion path would otherwise record an "OCR" figure they could then verify themselves.
    for (const source of [officer, checker, 'system:anything-else', '']) {
      expectRefused(await ingestReadFigures(TENANT, ID, read, source), 'FIGURE_SOURCE_PRINCIPAL_INVALID');
    }
    expect((await getApplication(TENANT, ID))?.figures).toHaveLength(0);
    expect((await ingestReadFigures(TENANT, ID, read, READ_FIGURE_SOURCES.rail)).ok).toBe(true);
  });
});

describe('#2 a verifier’s correction is a new proposal another principal verifies', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('keeps the reading, records the correction as the verifier’s keyed figure, and refuses self-verification of it', async () => {
    await handOver(TENANT, handover(), 'upstream');
    const read = await ingestReadFigures(
      TENANT,
      ID,
      [
        {
          metric: 'NET_PROFIT',
          periodLabel: 'FY2025',
          minorUnits: 90_000_000n,
          sourceKind: 'OCR',
          sourceRef: 'doc-test',
        },
      ],
      READ_FIGURE_SOURCES.ocr,
    );
    if (!read.ok) throw new Error('ingest');
    const reading = read.value.figures[0];
    const corrected = await verifyFigure(TENANT, ID, reading?.figureId ?? '', officer, 91_000_000n);
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const current = corrected.value.figures.find((f) => f.figure.metric === 'NET_PROFIT');
    expect(current?.figure.status).toBe('PROPOSED');
    expect(current?.figure.sourceKind).toBe('OFFICER_ENTRY');
    expect(current?.figure.enteredBy).toBe(officer);
    expect(current?.figure.proposedValue.minorUnits).toBe(91_000_000n);
    expect(current?.supersedes).toBe(reading?.figureId);
    expect(
      corrected.value.events.some(
        (e) => e.eventType === 'FIGURE_CORRECTED' && e.detail['corrects'] === reading?.figureId,
      ),
    ).toBe(true);

    expectRefused(await verifyFigure(TENANT, ID, current?.figureId ?? '', officer), 'FOUR_EYES_REQUIRED');
    const verified = await verifyFigure(TENANT, ID, current?.figureId ?? '', checker);
    expect(verified.ok && verified.value.figures.find((f) => f.figure.metric === 'NET_PROFIT')?.figure.status).toBe(
      'VERIFIED',
    );
  });
});

describe('#4 double submits are no-ops', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('sending the same letter version twice queues one notification; a new version is needed to resend', async () => {
    await driveToApproved();
    expect(
      (await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(14), firstDueDate: isoAfter(40) })).ok,
    ).toBe(true);
    const first = await sendOffer(TENANT, ID, officer);
    const second = await sendOffer(TENANT, ID, officer);
    expect(first.ok && second.ok).toBe(true);
    expect(queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'NOTIFICATION')).toHaveLength(
      1,
    );
    expect((await getApplication(TENANT, ID))?.events.filter((e) => e.eventType === 'OFFER_SENT')).toHaveLength(1);

    // A new letter version (a different first period, so different figures) may be sent: one more notification, for that version.
    const regenerated = await generateOffer(TENANT, ID, officer, {
      disbursementDate: isoAfter(14),
      firstDueDate: isoAfter(30),
    });
    expect(regenerated.ok && regenerated.value.offers).toHaveLength(2);
    expect((await sendOffer(TENANT, ID, officer)).ok).toBe(true);
    const sends = queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'NOTIFICATION');
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((e) => e.payload['letterVersion'])).size).toBe(2);
  });

  it('an identical pending proposal is not recorded twice', async () => {
    await handOver(TENANT, handover(), 'upstream');
    const entry = {
      metric: 'NET_PROFIT' as const,
      periodLabel: 'FY2025',
      minorUnits: 90_000_000n,
      sourceRef: 'doc-test',
    };
    await proposeFigures(TENANT, ID, [entry], officer);
    const again = await proposeFigures(TENANT, ID, [entry], officer);
    expect(again.ok).toBe(true);
    const v = await getApplication(TENANT, ID);
    expect(v?.figures.filter((f) => f.figure.metric === 'NET_PROFIT')).toHaveLength(1);
    expect(v?.figures.find((f) => f.figure.metric === 'NET_PROFIT')?.supersedes).toBeUndefined();
    expect(v?.events.filter((e) => e.eventType === 'FIGURE_PROPOSED')).toHaveLength(1);
    // A different value is a real change, and supersedes.
    await proposeFigures(TENANT, ID, [{ ...entry, minorUnits: 90_000_001n }], officer);
    expect((await getApplication(TENANT, ID))?.events.filter((e) => e.eventType === 'FIGURE_PROPOSED')).toHaveLength(2);
  });
});

describe('#6 a typed reference does not make a document present', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('stores PENDING, cannot satisfy the submission gate, and is validated only by someone other than the presenter', async () => {
    await handOver(TENANT, handover(), 'upstream');
    await spreadAndVerify();
    const checklist = await checklistStatus(TENANT, ID);
    if (!checklist.ok) throw new Error('checklist');
    const required = checklist.value.checklist.items.filter((i) => i.required);
    for (const item of required)
      await presentDocument(
        TENANT,
        ID,
        { documentType: item.documentType, documentRef: `doc-typed-${item.documentType}` },
        officer,
      );
    const pending = await getApplication(TENANT, ID);
    expect(pending?.documents.every((d) => d.validationStatus === 'PENDING')).toBe(true);
    const status = await checklistStatus(TENANT, ID);
    expect(status.ok && status.value.complete).toBe(false);
    expectRefused(await submitForAssessment(TENANT, ID, officer), 'DOCUMENTS_MISSING');

    const first = required[0]?.documentType ?? '';
    expectRefused(await validateDocument(TENANT, ID, `doc-typed-${first}`, 'VALID', officer), 'FOUR_EYES_REQUIRED');
    expect((await validateDocument(TENANT, ID, `doc-typed-${first}`, 'INVALID', checker)).ok).toBe(true);
    const report = await checklistStatus(TENANT, ID);
    if (report.ok) expect(report.value.report.find((r) => r.item.documentType === first)?.status).toBe('INVALID');
  });
});

describe('#7 assessment inputs: consent-bound, locked at submission, scored by someone else', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('refuses a bureau entry without a consent id, or with one stage 4 did not record', async () => {
    await handOver(TENANT, handover(), 'upstream');
    expectRefused(
      await recordAssessmentInputs(TENANT, ID, { ...INPUTS, bureau: { ...INPUTS.bureau, consentId: '' } }, officer),
      'BUREAU_CONSENT_MISSING',
    );
    expectRefused(
      await recordAssessmentInputs(
        TENANT,
        ID,
        { ...INPUTS, bureau: { ...INPUTS.bureau, consentId: 'aecb:consent-typed-here' } },
        officer,
      ),
      'BUREAU_CONSENT_NOT_ON_RECORD',
    );
    expectRefused(
      await recordAssessmentInputs(TENANT, ID, { ...INPUTS, bureau: { ...INPUTS.bureau, reportRef: '' } }, officer),
      'BUREAU_REF_INVALID',
    );
    const ok = await recordAssessmentInputs(TENANT, ID, INPUTS, officer);
    expect(ok.ok && ok.value.assessmentInputs?.bureau.consentId).toBe('aecb:consent-test');
  });

  it('locks the inputs once submitted, and refuses the submitting officer running the assessment', async () => {
    await handOver(TENANT, handover(), 'upstream');
    await spreadAndVerify();
    await presentAndValidateDocuments();
    await recordAssessmentInputs(TENANT, ID, INPUTS, officer);
    expect((await submitForAssessment(TENANT, ID, officer)).ok).toBe(true);
    expectRefused(
      await recordAssessmentInputs(TENANT, ID, { ...INPUTS, bureau: { ...INPUTS.bureau, score: 900n } }, officer),
      'ASSESSMENT_INPUTS_LOCKED',
    );
  });

  it('refuses submission without the assessment inputs, which lock at submission and scoring needs', async () => {
    await handOver(TENANT, handover(), 'upstream');
    await spreadAndVerify();
    await presentAndValidateDocuments();
    expectRefused(await submitForAssessment(TENANT, ID, officer), 'ASSESSMENT_INPUTS_MISSING');
    expect((await recordAssessmentInputs(TENANT, ID, INPUTS, officer)).ok).toBe(true);
    expect((await submitForAssessment(TENANT, ID, officer)).ok).toBe(true);
    expectRefused(await runAssessment(TENANT, ID, officer), 'FOUR_EYES_SELF_ASSESSMENT');
    expect((await runAssessment(TENANT, ID, checker)).ok).toBe(true);
  });
});

describe('#11 offer dates within the fund’s configured (ILLUSTRATIVE) bounds', () => {
  const policy = (): OfferDatePolicy => {
    const p = loadOfferDatePolicy(TENANT);
    if (!p.ok) throw new Error(p.error.reason);
    return p.value;
  };

  it('#8 the bounds come from the fund’s credit-policy configuration, marked ILLUSTRATIVE, through a parser', () => {
    const p = policy();
    expect(p.policyRef).toMatch(/^ILLUSTRATIVE/);
    expect([
      p.maxDisbursementAfterOfferDays,
      p.minFirstDueAfterDisbursementDays,
      p.maxFirstDueAfterDisbursementDays,
    ]).toEqual([60n, 15n, 45n]);
    // A malformed policy is a refusal, never a default.
    expectRefused(
      parseOfferDatePolicy({ ...offerPolicyJson, maxFirstDueAfterDisbursementDays: 45 }),
      'OFFER_POLICY_MALFORMED',
    );
    expectRefused(
      parseOfferDatePolicy({ ...offerPolicyJson, minFirstDueAfterDisbursementDays: '50' }),
      'OFFER_POLICY_MALFORMED',
    );
    expectRefused(parseOfferDatePolicy({ ...offerPolicyJson, policyRef: '' }), 'OFFER_POLICY_MALFORMED');
    expectRefused(loadOfferDatePolicy('bank-a'), 'OFFER_POLICY_NOT_FOUND');
    // The constants are gone from the service: nothing but the policy carries a bound.
    expect(Object.keys(businessModule)).not.toContain('OFFER_DATE_BOUNDS');
  });

  it('checks each bound with a typed reason', () => {
    const p = policy();
    expect(checkOfferDates(p, '2026-10-08', '2026-10-22', '2026-11-20').ok).toBe(true);
    expectRefused(checkOfferDates(p, '2026-10-08', '2026-10-07', '2026-11-01'), 'DISBURSEMENT_BEFORE_OFFER');
    expectRefused(checkOfferDates(p, '2026-10-08', '2026-12-08', '2026-12-30'), 'DISBURSEMENT_TOO_FAR');
    expectRefused(checkOfferDates(p, '2026-10-08', '2026-10-22', '2026-11-05'), 'FIRST_DUE_TOO_SOON');
    expectRefused(checkOfferDates(p, '2026-10-08', '2026-10-22', '2026-12-07'), 'FIRST_DUE_TOO_LATE');
    expectRefused(checkOfferDates(p, '2026-10-08', '2026-02-30', '2026-03-30'), 'OFFER_DATE_MALFORMED');
    // Exactly on the bounds is allowed.
    expect(checkOfferDates(p, '2026-10-08', '2026-12-07', '2026-12-22').ok).toBe(true);
    expect(checkOfferDates(p, '2026-10-08', '2026-10-08', '2026-11-22').ok).toBe(true);
    // A different policy moves the bounds: the same dates, judged by a tighter one.
    expectRefused(
      checkOfferDates({ ...p, maxDisbursementAfterOfferDays: 10n }, '2026-10-08', '2026-10-22', '2026-11-20'),
      'DISBURSEMENT_TOO_FAR',
    );
  });

  it('refuses an officer-chosen date outside the bounds when generating the offer', async () => {
    resetBusinessStore({ seed: false });
    await driveToApproved();
    expectRefused(
      await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(-1) }),
      'DISBURSEMENT_BEFORE_OFFER',
    );
    expectRefused(await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(90) }), 'DISBURSEMENT_TOO_FAR');
    expectRefused(
      await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(14), firstDueDate: isoAfter(20) }),
      'FIRST_DUE_TOO_SOON',
    );
    expectRefused(
      await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(14), firstDueDate: isoAfter(70) }),
      'FIRST_DUE_TOO_LATE',
    );
    expect((await getApplication(TENANT, ID))?.offers).toHaveLength(0);
    // The defaults sit inside the bounds.
    expect((await generateOffer(TENANT, ID, officer)).ok).toBe(true);
  });
});

describe('#12 #13 disbursement: a distinct finance principal, payment and bureau report queued', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('#6 refuses a disbursement earlier than the signed offer’s planned disbursement date, queuing nothing', async () => {
    await driveToApproved();
    await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(14), firstDueDate: isoAfter(44) });
    const sent = await sendOffer(TENANT, ID, officer);
    await recordSigned(
      TENANT,
      ID,
      { letterVersion: sent.ok ? (sent.value.application.offer?.letterVersion ?? '') : '' },
      officer,
    );
    const early = await recordDisbursed(TENANT, ID, finance);
    expectRefused(early, 'DISBURSEMENT_BEFORE_PLANNED_DATE');
    if (!early.ok) expect(early.error.context).toMatchObject({ plannedDate: isoAfter(14), actualDate: isoAfter(0) });
    expect((await getApplication(TENANT, ID))?.application.status).toBe('SIGNED');
    expect(
      queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'PAYMENT_DISBURSE'),
    ).toHaveLength(0);
  });

  it('refuses the approver and the submitting officer; queues PAYMENT_DISBURSE and BUREAU_REPORT with DISBURSED', async () => {
    await driveToApproved();
    await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(0), firstDueDate: isoAfter(30) });
    const sent = await sendOffer(TENANT, ID, officer);
    await recordSigned(
      TENANT,
      ID,
      { letterVersion: sent.ok ? (sent.value.application.offer?.letterVersion ?? '') : '' },
      officer,
    );

    expectRefused(await recordDisbursed(TENANT, ID, committee), 'FOUR_EYES_DISBURSEMENT');
    expectRefused(await recordDisbursed(TENANT, ID, officer), 'FOUR_EYES_DISBURSEMENT');
    expect(queuedBusinessNotifications().filter((e) => e.kind === 'PAYMENT_DISBURSE')).toHaveLength(0);

    const paid = await recordDisbursed(TENANT, ID, finance);
    expect(paid.ok && paid.value.application.status).toBe('DISBURSED');
    const payment = queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'PAYMENT_DISBURSE');
    const bureau = queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'BUREAU_REPORT');
    expect(payment).toHaveLength(1);
    expect(payment[0]?.idempotencyKey).toBe(`business:${ID}:disburse`);
    expect(payment[0]?.payload).toMatchObject({
      rail: 'PARTNER_BANK',
      beneficiaryRef: ID,
      minorUnits: '80000000',
      currency: 'AED',
    });
    expect(bureau).toHaveLength(1);
    expect(bureau[0]?.payload).toMatchObject({ facilityRef: ID, event: 'OPENED' });

    // In memory the flush hands them to the outbox store with the change, all together.
    expect((await flushBusiness()).ok).toBe(true);
    const stored = await businessOutboxStore().rows();
    expect(stored.map((r) => r.event.kind).sort()).toEqual(['BUREAU_REPORT', 'NOTIFICATION', 'PAYMENT_DISBURSE']);
  });
});

describe('the hand-over refuses and repeats safely', () => {
  beforeEach(() => resetBusinessStore({ seed: false }));

  it('refuses an amount in a currency that is not the tenant’s', async () => {
    expectRefused(await handOver(TENANT, handover({ currency: 'SAR' }), 'upstream'), 'CURRENCY_NOT_TENANTS');
    expect(await getApplication(TENANT, ID)).toBeUndefined();
  });

  it('refuses an identity number anywhere in the applicant', async () => {
    const h = handover();
    const r = await handOver(
      TENANT,
      {
        ...h,
        applicant: { ...h.applicant, owners: [{ displayName: 'Test Owner Example', ref: '784-1990-1234567-1' }] },
      },
      'upstream',
    );
    expectRefused(r, 'IDENTITY_NUMBER_IN_PAYLOAD');
  });

  it('#14 refuses an identity number in the contact party reference or the upstream reference', async () => {
    expectRefused(
      await handOver(TENANT, handover({ contact: { partyRef: '784199012345671' } }), 'upstream'),
      'IDENTITY_NUMBER_IN_PAYLOAD',
    );
    expectRefused(
      await handOver(TENANT, handover({ upstreamRef: 'cif-784-1990-1234567-1' }), 'upstream'),
      'IDENTITY_NUMBER_IN_PAYLOAD',
    );
    expect(await getApplication(TENANT, ID)).toBeUndefined();
  });

  it('#7 refuses an identity number — Emirates ID or Saudi id / iqama — in every reference input after the hand-over', async () => {
    await handOver(TENANT, handover(), 'upstream');
    for (const id of ['784-1985-1234567-1', '1012345678', '2087654321']) {
      expectRefused(
        await presentDocument(TENANT, ID, { documentType: 'TRADE_LICENCE', documentRef: `doc-${id}` }, officer),
        'IDENTITY_NUMBER_IN_PAYLOAD',
      );
      expectRefused(await validateDocument(TENANT, ID, `doc-${id}`, 'VALID', checker), 'IDENTITY_NUMBER_IN_PAYLOAD');
      expectRefused(
        await proposeFigures(
          TENANT,
          ID,
          [{ metric: 'NET_PROFIT', periodLabel: 'FY2025', minorUnits: 1n, sourceRef: `stmt-${id}` }],
          officer,
        ),
        'IDENTITY_NUMBER_IN_PAYLOAD',
      );
      expectRefused(
        await ingestReadFigures(
          TENANT,
          ID,
          [{ metric: 'NET_PROFIT', periodLabel: 'FY2025', minorUnits: 1n, sourceKind: 'OCR', sourceRef: `stmt-${id}` }],
          READ_FIGURE_SOURCES.ocr,
        ),
        'IDENTITY_NUMBER_IN_PAYLOAD',
      );
      expectRefused(
        await recordAssessmentInputs(
          TENANT,
          ID,
          { ...INPUTS, bureau: { ...INPUTS.bureau, reportRef: `aecb:report-${id}` } },
          officer,
        ),
        'IDENTITY_NUMBER_IN_PAYLOAD',
      );
      expectRefused(
        await withdrawApplication(TENANT, ID, `Applicant ${id} withdrew`, officer),
        'IDENTITY_NUMBER_IN_PAYLOAD',
      );
    }
    // The refusal names the field, never the value.
    const refused = await presentDocument(
      TENANT,
      ID,
      { documentType: 'TRADE_LICENCE', documentRef: 'doc-1012345678' },
      officer,
    );
    if (!refused.ok) expect(JSON.stringify(refused.error)).not.toContain('1012345678');
    const v = await getApplication(TENANT, ID);
    expect(v?.documents).toHaveLength(0);
    expect(v?.figures).toHaveLength(0);
    expect(v?.application.status).toBe('RECEIVED');
    // An amount shaped like an identity number is an amount: bigint, not text, and not scanned.
    expect(
      (
        await proposeFigures(
          TENANT,
          ID,
          [
            {
              metric: 'ANNUAL_REVENUE',
              periodLabel: 'FY2025',
              minorUnits: 1_012_345_678n,
              sourceRef: 'doc-test-statements',
            },
          ],
          officer,
        )
      ).ok,
    ).toBe(true);
  });

  it('refuses a contact that is not masked, and a purpose the variant does not finance', async () => {
    expectRefused(
      await handOver(
        TENANT,
        handover({ contact: { partyRef: 'owner-test-9001', emailMasked: 'someone@example.com' } }),
        'upstream',
      ),
      'CONTACT_EMAIL_NOT_MASKED',
    );
    expectRefused(await handOver(TENANT, handover({ purpose: 'BUSINESS_LAUNCH' }), 'upstream'), 'PURPOSE_NOT_ALLOWED');
  });

  it('is idempotent on the upstream reference', async () => {
    const first = await handOver(TENANT, handover(), 'upstream');
    const again = await handOver(TENANT, handover(), 'upstream');
    expect(first.ok && first.value.created).toBe(true);
    expect(again.ok && again.value.created).toBe(false);
    if (again.ok) expect(again.value.view.application.applicationId).toBe(ID);
    expect(
      (await listApplications(TENANT)).filter((a) => a.application.upstreamRef === 'upstream-test-9001'),
    ).toHaveLength(1);
    expectRefused(
      await handOver(TENANT, handover({ applicationId: 'FR-00009002' }), 'upstream'),
      'UPSTREAM_REF_REUSED',
    );
  });

  it('refuses a straight-through approval by the officer who submitted it', async () => {
    // Not reachable without a straight-through case; the seed carries one.
    resetBusinessStore();
    const stp = (await listApplications(TENANT)).find((a) => a.application.status === 'ASSESSED');
    expect(stp?.application.assessment?.outcome).toBe('STRAIGHT_THROUGH');
    expectRefused(
      await approveStraightThrough(TENANT, stp?.application.applicationId ?? '', officer),
      'FOUR_EYES_SELF_APPROVAL',
    );
  });
});

describe('the illustrative seed (sme-fund-ae)', () => {
  beforeEach(() => resetBusinessStore());

  it('spreads eight applications across stages 5 to 9', async () => {
    const all = await listApplications(TENANT);
    expect(all).toHaveLength(8);
    const by = (id: string) => all.find((a) => a.application.applicationId === id);
    expect(by('FR-00005101')?.application.status).toBe('SPREADING');
    expect(by('FR-00005102')?.application.status).toBe('SPREADING');
    expect(by('FR-00005103')?.application.status).toBe('SUBMITTED');
    expect(by('FR-00005104')?.application.status).toBe('IN_COMMITTEE');
    expect(by('FR-00005104')?.application.assessment?.riskLevel).toBe('LOW');
    expect(by('FR-00005105')?.application.assessment?.outcome).toBe('STRAIGHT_THROUGH');
    expect(by('FR-00005106')?.application.status).toBe('OFFER_SENT');
    expect(by('FR-00005107')?.application.status).toBe('DISBURSED');
    expect(by('FR-00005108')?.displayStage).toBe(9);
    expect(by('FR-00005108')?.portfolio?.daysPastDue).toBe(34);
    expect(new Set(all.map((a) => a.currency))).toEqual(new Set(['AED']));
    expect(new Set(all.map((a) => a.displayStage))).toEqual(new Set([5, 6, 7, 8, 9]));
  });

  it('#6 keeps possible timelines: nothing disbursed before its planned date; days past due accrued from a past first due date', async () => {
    const all = await listApplications(TENANT);
    const dubaiDate = (epoch: bigint): string =>
      new Date(Number((epoch + 4n * 3_600n) * 1_000n)).toISOString().slice(0, 10);
    const daysBetween = (from: string, to: string): number =>
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
    const nowEpoch = BigInt(Math.floor(Date.now() / 1_000));
    for (const id of ['FR-00005107', 'FR-00005108']) {
      const v = all.find((a) => a.application.applicationId === id);
      const terms = v?.latestOffer?.terms;
      const paidAt = v?.application.disbursement?.atEpochSeconds;
      expect(terms, id).toBeDefined();
      expect(paidAt, id).toBeDefined();
      if (terms === undefined || paidAt === undefined) continue;
      expect(
        dubaiDate(paidAt) >= terms.disbursementDate,
        `${id} paid ${dubaiDate(paidAt)} planned ${terms.disbursementDate}`,
      ).toBe(true);
      expect(daysBetween(terms.offerDate, terms.disbursementDate)).toBeGreaterThanOrEqual(0);
      expect(daysBetween(terms.disbursementDate, terms.firstDueDate)).toBeGreaterThanOrEqual(15);
      expect(paidAt <= nowEpoch).toBe(true);
    }
    const arrears = all.find((a) => a.application.applicationId === 'FR-00005108');
    const portfolio = arrears?.portfolio;
    const firstDue = arrears?.latestOffer?.terms.firstDueDate ?? '';
    expect(portfolio?.daysPastDue).toBeGreaterThan(0);
    expect(portfolio === undefined ? false : portfolio.asOfEpochSeconds <= nowEpoch).toBe(true);
    expect(
      portfolio === undefined ? -1 : daysBetween(firstDue, dubaiDate(portfolio.asOfEpochSeconds)),
    ).toBeGreaterThanOrEqual(portfolio?.daysPastDue ?? Number.MAX_SAFE_INTEGER);
  });

  it('has figures awaiting verification at stage 5', async () => {
    const first = await getApplication(TENANT, 'FR-00005101');
    expect(first?.figures.length).toBeGreaterThan(0);
    expect(first?.figures.every((f) => f.figure.status === 'PROPOSED')).toBe(true);
  });

  it('carries no identity-number-shaped value anywhere', async () => {
    const json = JSON.stringify(await listApplications(TENANT), (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(json).not.toMatch(/784[- ]?\d{4}[- ]?\d{7}[- ]?\d/);
  });

  it('#9 two concurrent first reads share one hydration: the whole book, once', async () => {
    const [a, b] = await Promise.all([listApplications(TENANT), listApplications(TENANT)]);
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(8);
    const all = await listApplications(TENANT);
    for (const v of all) {
      expect(new Set(v.events.map((e) => e.eventId)).size).toBe(v.events.length);
      expect(new Set(v.figures.map((f) => f.figure.metric)).size).toBe(v.figures.length);
      expect(v.events.filter((e) => e.eventType === 'HANDED_OVER')).toHaveLength(1);
    }
  });
});

// =============================================================================
// Against a recording stand-in for the database
// =============================================================================

const TENANT_UUID = '00000000-0000-4000-8000-0000000000ae';

interface Logged {
  readonly via: 'pool' | 'client';
  readonly client: number;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A pool that answers the queries business-persistence.ts makes, with an
 * empty book, and records every statement. `profile` is what
 * config.deployment_profile says; `stale` makes the application upsert find
 * a changed row; `failOn` throws on a statement containing that text.
 */
function recordingPool(
  options: {
    profile?: boolean | 'missing' | 'error';
    stale?: (params: readonly unknown[]) => boolean;
    failOn?: () => string | undefined;
  } = {},
) {
  const log: Logged[] = [];
  let clients = 0;
  let loads = 0;
  const answer = (sql: string, params: readonly unknown[]): { rows: unknown[]; rowCount: number } => {
    const fail = options.failOn?.();
    if (fail !== undefined && sql.includes(fail)) throw new Error(`simulated failure on ${fail}`);
    if (sql.includes('from core.tenant')) return { rows: [{ id: TENANT_UUID }], rowCount: 1 };
    if (sql.includes('config.deployment_profile')) {
      if (options.profile === 'error') throw new Error('permission denied for table deployment_profile');
      if (options.profile === 'missing') return { rows: [], rowCount: 0 };
      return { rows: [{ production_data_permitted: options.profile ?? false }], rowCount: 1 };
    }
    if (sql.startsWith('select record')) {
      loads += 1;
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('insert into core.business_application') && !sql.includes('business_application_event')) {
      if (options.stale?.(params) === true) return { rows: [], rowCount: 0 };
      return {
        rows: [{ status: params[4], updated_at: `2026-10-08 10:00:00.${String(log.length).padStart(6, '0')}+00` }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query: (sql: string, params: readonly unknown[] = []) => {
      log.push({ via: 'pool', client: 0, sql, params });
      return Promise.resolve(answer(sql, params));
    },
    connect: () => {
      clients += 1;
      const id = clients;
      return Promise.resolve({
        query: (sql: string, params: readonly unknown[] = []) => {
          log.push({ via: 'client', client: id, sql, params });
          return Promise.resolve(answer(sql, params));
        },
        release: () => undefined,
      });
    },
  };
  return { pool: pool as unknown as Pool, log, loads: () => loads };
}

const transactions = (log: readonly Logged[]): Logged[][] => {
  const out: Logged[][] = [];
  let current: Logged[] | undefined;
  for (const l of log.filter((x) => x.via === 'client')) {
    if (l.sql === 'begin') current = [];
    current?.push(l);
    if ((l.sql === 'commit' || l.sql === 'rollback') && current !== undefined) {
      out.push(current);
      current = undefined;
    }
  }
  return out;
};

const DB_CONFIGURED = process.env['SANAD_DATABASE_URL'] !== undefined;

describe.skipIf(DB_CONFIGURED)('#3 the outbox row is written in the business transaction', () => {
  it('writes OFFER_SENT and its OFFER_ISSUED outbox row between one begin and its commit, on one client', async () => {
    const db = recordingPool();
    resetBusinessStore({ seed: false, pool: db.pool });
    await driveToApproved();
    await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(14), firstDueDate: isoAfter(40) });
    expect((await flushBusiness()).ok).toBe(true);
    const before = db.log.length;
    expect((await sendOffer(TENANT, ID, officer)).ok).toBe(true);
    expect((await flushBusiness()).ok).toBe(true);

    const tx = transactions(db.log.slice(before));
    expect(tx).toHaveLength(1);
    const statements = tx[0] ?? [];
    expect(new Set(statements.map((s) => s.client)).size).toBe(1);
    expect(statements.at(-1)?.sql).toBe('commit');
    const upsert = statements.find((s) => s.sql.includes('insert into core.business_application\n'));
    expect(upsert?.params[4]).toBe('OFFER_SENT');
    const outbox = statements.filter((s) => s.sql.includes('insert into core.outbox_event'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.params[0]).toBe(TENANT_UUID);
    expect(outbox[0]?.params[2]).toBe('NOTIFICATION');
    // Nothing outside the transaction appends to the outbox.
    expect(db.log.slice(before).filter((s) => s.via === 'pool' && s.sql.includes('outbox_event'))).toHaveLength(0);
  });

  it('rolls the send back with its outbox row: neither is written, the notification is not queued, and the answer is PERSISTENCE_FAILED', async () => {
    let failing: string | undefined;
    const db = recordingPool({ failOn: () => failing });
    resetBusinessStore({ seed: false, pool: db.pool });
    await driveToApproved();
    await generateOffer(TENANT, ID, officer, { disbursementDate: isoAfter(14), firstDueDate: isoAfter(40) });
    expect((await flushBusiness()).ok).toBe(true);
    failing = 'insert into core.outbox_event';
    const before = db.log.length;
    const sent = await mutateBusiness(TENANT, () => sendOffer(TENANT, ID, officer));
    expectRefused(sent, 'PERSISTENCE_FAILED');
    const tx = transactions(db.log.slice(before));
    expect(tx.at(-1)?.at(-1)?.sql).toBe('rollback');
    expect(tx.some((t) => t.at(-1)?.sql === 'commit')).toBe(false);
    // The side effect of a change that was not written is never dispatched.
    expect(queuedBusinessNotifications().filter((e) => e.subjectRef === ID && e.kind === 'NOTIFICATION')).toHaveLength(
      0,
    );
  });
});

describe.skipIf(DB_CONFIGURED)('#2 a failed save is not a poison batch', () => {
  it('rolls back, drops the working set, answers PERSISTENCE_FAILED without throwing, and later actions are unaffected', async () => {
    let failing: string | undefined;
    const db = recordingPool({ failOn: () => failing });
    resetBusinessStore({ seed: false, pool: db.pool });
    expect((await mutateBusiness(TENANT, () => handOver(TENANT, handover(), 'upstream'))).ok).toBe(true);

    failing = 'insert into core.business_financial_figure';
    const before = db.log.length;
    const proposed = await mutateBusiness(TENANT, () =>
      proposeFigures(
        TENANT,
        ID,
        [{ metric: 'NET_PROFIT', periodLabel: 'FY2025', minorUnits: 1n, sourceRef: 'doc' }],
        officer,
      ),
    );
    expectRefused(proposed, 'PERSISTENCE_FAILED');
    // The database's message is not carried into the refusal.
    if (!proposed.ok) expect(JSON.stringify(proposed.error)).not.toMatch(/simulated/);
    expect(transactions(db.log.slice(before)).at(-1)?.at(-1)?.sql).toBe('rollback');

    // The database is back. Before the fix the unsaved figure stayed marked and every later save retried it — and failed —
    // whatever the later action was. Now the working set was dropped: the next read reloads (the stand-in's book is empty).
    failing = undefined;
    expect(await getApplication(TENANT, ID)).toBeUndefined();
    const retryFrom = db.log.length;
    expect((await flushBusiness()).ok).toBe(true);
    expect(db.log.slice(retryFrom).some((s) => s.sql.includes('business_financial_figure'))).toBe(false);
    const again = await mutateBusiness(TENANT, () =>
      handOver(TENANT, handover({ applicationId: 'FR-00009002', upstreamRef: 'upstream-test-9002' }), 'upstream'),
    );
    expect(again.ok).toBe(true);
  });

  it('flushBusiness answers PERSISTENCE_FAILED instead of throwing when the connection itself fails', async () => {
    let failing: string | undefined;
    const db = recordingPool({ failOn: () => failing });
    resetBusinessStore({ seed: false, pool: db.pool });
    await handOver(TENANT, handover(), 'upstream');
    failing = 'begin';
    const settled = await flushBusiness();
    expectRefused(settled, 'PERSISTENCE_FAILED');
    failing = undefined;
    expect((await flushBusiness()).ok).toBe(true);
  });
});

describe.skipIf(DB_CONFIGURED)('#1 two interleaved requests on one tenant', () => {
  it('never reports a change as saved when a stale save dropped the book it was made on', async () => {
    const staleFor = new Set<string>();
    const db = recordingPool({ stale: (params) => staleFor.has(String(params[1])) });
    resetBusinessStore({ seed: false, pool: db.pool });
    const B = 'FR-00009002';
    expect((await mutateBusiness(TENANT, () => handOver(TENANT, handover(), 'upstream'))).ok).toBe(true);
    expect(
      (
        await mutateBusiness(TENANT, () =>
          handOver(TENANT, handover({ applicationId: B, upstreamRef: 'upstream-test-9002' }), 'upstream'),
        )
      ).ok,
    ).toBe(true);

    // Another process has since changed application A: A's save will be refused as stale.
    staleFor.add(ID);
    const figure = (app: string, n: bigint) => () =>
      proposeFigures(
        TENANT,
        app,
        [{ metric: 'NET_PROFIT', periodLabel: 'FY2025', minorUnits: n, sourceRef: 'doc' }],
        officer,
      );
    // Started together: each yields at every await, so without the lock B's change would land on the book that A's
    // stale save then drops — and B's own save would find nothing to write and report success.
    const [a, b] = await Promise.all([mutateBusiness(TENANT, figure(ID, 1n)), mutateBusiness(TENANT, figure(B, 2n))]);
    expectRefused(a, 'STALE_APPLICATION');
    const committedFigures = transactions(db.log)
      .filter((t) => t.at(-1)?.sql === 'commit')
      .flatMap((t) =>
        t.filter((s) => s.sql.includes('insert into core.business_financial_figure')).map((s) => String(s.params[2])),
      );
    // Whatever B answered, it is true: a success means B's figure was committed; otherwise B was refused.
    if (b.ok) expect(committedFigures).toContain(B);
    else expect(['STALE_APPLICATION', 'BUSINESS_APPLICATION_NOT_FOUND']).toContain(b.error.reason);
    expect(committedFigures).not.toContain(ID);
  });

  it('serialises the two: the second change starts only after the first is saved', async () => {
    const db = recordingPool();
    resetBusinessStore({ seed: false, pool: db.pool });
    const order: string[] = [];
    const op = (name: string) => async () => {
      order.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 5));
      const r = await handOver(TENANT, handover({ applicationId: name, upstreamRef: `upstream-${name}` }), 'upstream');
      order.push(`${name}:end`);
      return r;
    };
    const commitsBefore = (): number => transactions(db.log).filter((t) => t.at(-1)?.sql === 'commit').length;
    const [x, y] = await Promise.all([
      mutateBusiness(TENANT, op('FR-00009011')),
      mutateBusiness(TENANT, op('FR-00009012')),
    ]);
    expect(x.ok && y.ok).toBe(true);
    expect(order).toEqual(['FR-00009011:start', 'FR-00009011:end', 'FR-00009012:start', 'FR-00009012:end']);
    expect(commitsBefore()).toBe(2);
  });
});

describe.skipIf(DB_CONFIGURED)(
  '#8 the illustrative seed is written only where production data is not permitted',
  () => {
    it('seeds when the deployment profile says production data is not permitted', async () => {
      const db = recordingPool({ profile: false });
      resetBusinessStore({ pool: db.pool });
      expect(await listApplications(TENANT)).toHaveLength(8);
    });

    it('never seeds a deployment cleared for production data', async () => {
      const db = recordingPool({ profile: true });
      resetBusinessStore({ pool: db.pool });
      expect(await listApplications(TENANT)).toHaveLength(0);
    });

    it('does not seed when the profile is missing or unreadable', async () => {
      for (const profile of ['missing', 'error'] as const) {
        const db = recordingPool({ profile });
        resetBusinessStore({ pool: db.pool });
        expect(await listApplications(TENANT)).toHaveLength(0);
      }
    });
  },
);

describe.skipIf(DB_CONFIGURED)('#9 hydration from the database is single-flight', () => {
  it('two concurrent first reads load the book once and seed once', async () => {
    const db = recordingPool({ profile: false });
    resetBusinessStore({ pool: db.pool });
    const [a, b] = await Promise.all([listApplications(TENANT), listApplications(TENANT)]);
    expect(db.loads()).toBe(1);
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(8);
    for (const v of await listApplications(TENANT)) {
      expect(v.events.filter((e) => e.eventType === 'HANDED_OVER')).toHaveLength(1);
      expect(new Set(v.figures.map((f) => f.figure.metric)).size).toBe(v.figures.length);
    }
  });
});

describe.skipIf(DB_CONFIGURED)('#10 a stale process does not overwrite newer state', () => {
  it('updates only the version it loaded; on conflict writes nothing, reloads, and answers STALE_APPLICATION', async () => {
    let stale = false;
    const db = recordingPool({ stale: () => stale });
    resetBusinessStore({ seed: false, pool: db.pool });
    await handOver(TENANT, handover(), 'upstream');
    const firstWrite = db.log.length;
    expect((await flushBusiness()).ok).toBe(true);
    const insert = db.log.slice(firstWrite).find((s) => s.sql.includes('insert into core.business_application\n'));
    // A new application carries no expected version: it is inserted only if nobody else did first.
    expect(insert?.params[14]).toBeNull();
    expect(insert?.sql).toMatch(
      /where core\.business_application\.status = \$15::text\s+and core\.business_application\.updated_at = \$16::timestamptz/,
    );

    await proposeFigures(
      TENANT,
      ID,
      [{ metric: 'NET_PROFIT', periodLabel: 'FY2025', minorUnits: 1n, sourceRef: 'doc' }],
      officer,
    );
    stale = true;
    const second = db.log.length;
    const settled = await flushBusiness();
    expectRefused(settled, 'STALE_APPLICATION');
    const upsert = db.log.slice(second).find((s) => s.sql.includes('insert into core.business_application\n'));
    // The update names the version this process last saw: the status and updated_at the first save returned.
    expect(upsert?.params[14]).toBe('RECEIVED');
    expect(String(upsert?.params[15])).toMatch(/^2026-10-08 10:00:00\./);
    const tx = transactions(db.log.slice(second));
    expect(tx.at(-1)?.at(-1)?.sql).toBe('rollback');
    expect(tx.at(-1)?.some((s) => s.sql.includes('business_financial_figure'))).toBe(false);

    // The working set was discarded: the next read reloads (the stand-in's book is empty).
    expect(await getApplication(TENANT, ID)).toBeUndefined();
  });
});
