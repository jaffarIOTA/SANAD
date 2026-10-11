/**
 * Delegation of authority and credit report notes (UAE SME direct lending,
 * stage 6; SME-TRACEABILITY.md T-08-11 and T-08-12).
 *
 * Delegation of authority is a quorum: the tenant's credit policy says how many
 * different committee members must approve, by approved amount and risk band.
 * Each case below attempts an approval the quorum forbids — one member twice,
 * a member changing the terms, the submitting officer, an offer before the
 * quorum — and passes only when it is refused. Credit report notes are the
 * analyst's summary: recorded only while the case is assessed or in committee,
 * never with an identity number in them.
 */
import { describe, expect, it } from 'vitest';

import { loadSmeAssessmentPolicy } from '@sanad/config/loader.ts';
import { committeeApprovalsRequired, parseSmeAssessmentPolicy } from '@sanad/core/decisioning/sme-assessment.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import {
  type ApprovalContext,
  type ApprovalLimits,
  type BusinessApplication,
  type HandoverInput,
  CREDIT_NOTES_MAX_LENGTH,
  decideInCommittee,
  receiveHandover,
  recordAssessment,
  recordCreditNotes,
  recordOfferSent,
  startSpreading,
  submitForAssessment,
} from '@sanad/core/origination/business-application.ts';

import tenantPolicy from '../../config/tenants/sme-fund-ae/credit-policy/sme-assessment.json' with { type: 'json' };

const aed = (fils: bigint) => money(fils, 'AED');
const T = 1_800_000_000n;

const LIMITS: ApprovalLimits = {
  riskLevel: 'VERY_LOW',
  riskBandMaxAmount: aed(300_000_000n),
  riskBandMinContributionPerTenThousand: 1500,
  variantCode: 'EXPANSION',
  minAmount: aed(5_000_000n),
  variantMaxAmount: aed(500_000_000n),
  variantMinMonths: 12,
  variantMaxMonths: 72,
  variantMinContributionPerTenThousand: 1500,
  variantMaxContributionPerTenThousand: 10_000,
};
const quorumOf = (approvalsRequired: number): ApprovalContext => ({
  tenantCurrency: 'AED',
  limits: LIMITS,
  approvalsRequired,
});

const REQUEST: HandoverInput = {
  applicationId: 'FR-00009001',
  upstreamRef: 'cif-doa',
  tenantId: 'sme-fund-ae',
  applicant: {
    businessNameEn: 'Delegation Example Trading LLC',
    registrationRef: 'licence-ref-doa',
    sector: 'TRADING',
    yearsInOperation: 6,
    owners: [{ displayName: 'Owner Example', ref: 'owner-doa' }],
    upstreamVerificationRefs: ['uaepass-doa'],
  },
  productCode: 'sme-term-conventional',
  variantCode: 'EXPANSION',
  purpose: 'CAPEX_OPEX',
  requested: aed(250_000_000n),
  tenorMonths: 60,
  graceMonths: 0,
  contributionPerTenThousand: 2000,
};

function submitted(): BusinessApplication {
  const received = expectOk(receiveHandover(REQUEST, 'AED', 'cif', T)).application;
  const spreading = expectOk(startSpreading(received, 'officer-1', T + 1n)).application;
  const ready = { spreadComplete: true, missingFigures: [], checklistComplete: true, missingDocuments: [] };
  return expectOk(submitForAssessment(spreading, ready, 'officer-1', T + 2n)).application;
}

const inCommittee = (): BusinessApplication =>
  expectOk(
    recordAssessment(
      submitted(),
      { outcome: 'COMMITTEE', riskLevel: 'VERY_LOW', assessmentRef: 'asm-1' },
      'engine',
      T + 3n,
    ),
  ).application;

const vote = (
  app: BusinessApplication,
  decidedBy: string,
  context: ApprovalContext,
  terms: { amount?: bigint; tenorMonths?: number } = {},
  approved = true,
) =>
  decideInCommittee(
    app,
    {
      decidedBy,
      approved,
      reason: approved ? 'Within the band; strong cover' : 'Cash flow does not support the facility',
      terms: {
        ...(terms.amount === undefined ? {} : { amount: aed(terms.amount) }),
        ...(terms.tenorMonths === undefined ? {} : { tenorMonths: terms.tenorMonths }),
      },
    },
    T + 10n,
    context,
  );

function expectRefusal(r: Result<unknown>, control: string, reason: string): void {
  expect(r.ok, reason).toBe(false);
  if (!r.ok) expect({ control: r.error.control, reason: r.error.reason }).toEqual({ control, reason });
}

// =============================================================================
// The quorum, in the domain
// =============================================================================

describe('delegation of authority — the committee quorum', () => {
  it('records a first approval short of the quorum without approving', () => {
    const t = expectOk(vote(inCommittee(), 'mcc-1', quorumOf(2), { amount: 250_000_000n }));
    expect(t.application.status).toBe('IN_COMMITTEE');
    expect(t.application.approvedTerms).toBeUndefined();
    expect(t.application.committee).toBeUndefined();
    expect(t.application.committeeApprovals?.map((a) => a.decidedBy)).toEqual(['mcc-1']);
    expect(t.event.eventType).toBe('COMMITTEE_APPROVAL_RECORDED');
    expect(t.event.detail).toMatchObject({ approvalsRecorded: '1', approvalsRequired: '2' });
  });

  it('approves when a second, different member concurs on the same terms', () => {
    const first = expectOk(vote(inCommittee(), 'mcc-1', quorumOf(2), { amount: 250_000_000n })).application;
    const t = expectOk(vote(first, 'mcc-2', quorumOf(2), { amount: 250_000_000n }));
    expect(t.application.status).toBe('APPROVED');
    expect(t.application.approvedTerms?.amount).toEqual(aed(250_000_000n));
    expect(t.application.committee?.decidedBy).toBe('mcc-2');
    expect(t.application.committeeApprovals?.map((a) => a.decidedBy)).toEqual(['mcc-1', 'mcc-2']);
    expect(t.event).toMatchObject({
      eventType: 'COMMITTEE_APPROVED',
      detail: { approvalsRecorded: '2', approvalsRequired: '2' },
    });
  });

  it('refuses the same member approving twice: one person never makes a quorum of two', () => {
    const first = expectOk(vote(inCommittee(), 'mcc-1', quorumOf(2))).application;
    expectRefusal(vote(first, 'mcc-1', quorumOf(2)), 'OP-DETERMINACY', 'COMMITTEE_MEMBER_ALREADY_APPROVED');
  });

  it('refuses a further approval on different terms: members concur on one set of figures', () => {
    const first = expectOk(vote(inCommittee(), 'mcc-1', quorumOf(2), { amount: 250_000_000n })).application;
    expectRefusal(
      vote(first, 'mcc-2', quorumOf(2), { amount: 200_000_000n }),
      'OP-DETERMINACY',
      'COMMITTEE_TERMS_DIFFER',
    );
    expectRefusal(
      vote(first, 'mcc-2', quorumOf(2), { amount: 250_000_000n, tenorMonths: 48 }),
      'OP-DETERMINACY',
      'COMMITTEE_TERMS_DIFFER',
    );
  });

  it('refuses the submitting officer as a committee approver, whatever the quorum', () => {
    expectRefusal(vote(inCommittee(), 'officer-1', quorumOf(2)), 'OP-DETERMINACY', 'FOUR_EYES_SELF_APPROVAL');
  });

  it('refuses to send an offer while the quorum is short', () => {
    const first = expectOk(vote(inCommittee(), 'mcc-1', quorumOf(3))).application;
    const second = expectOk(vote(first, 'mcc-2', quorumOf(3))).application;
    expect(second.status).toBe('IN_COMMITTEE');
    expectRefusal(
      recordOfferSent(second, { letterVersion: 'a'.repeat(64), channels: ['EMAIL'] }, 'officer-1', T + 20n),
      'OP-DETERMINACY',
      'TRANSITION_NOT_ALLOWED',
    );
  });

  it('lets one member decline after an approval: a decline is final and keeps the approvals on record', () => {
    const first = expectOk(vote(inCommittee(), 'mcc-1', quorumOf(2))).application;
    const t = expectOk(vote(first, 'mcc-2', quorumOf(2), {}, false));
    expect(t.application.status).toBe('DECLINED');
    expect(t.application.committeeApprovals?.map((a) => a.decidedBy)).toEqual(['mcc-1']);
  });

  it('approves on one approval when no quorum is given, as before delegation of authority', () => {
    const t = expectOk(vote(inCommittee(), 'mcc-1', { tenantCurrency: 'AED', limits: LIMITS }));
    expect(t.application.status).toBe('APPROVED');
  });

  it('refuses a quorum that is not a whole number of at least one', () => {
    for (const n of [0, -1, 1.5])
      expectRefusal(vote(inCommittee(), 'mcc-1', quorumOf(n)), 'OP-DETERMINACY', 'APPROVALS_REQUIRED_INVALID');
  });
});

// =============================================================================
// The tenant's configuration
// =============================================================================

describe('delegation of authority — the tenant policy', () => {
  const policy = expectOk(loadSmeAssessmentPolicy('sme-fund-ae'));
  const doa = policy.delegationOfAuthority;

  it('is configured, and names where it comes from', () => {
    expect(doa).toBeDefined();
    expect(doa?.policyRef).toMatch(/ILLUSTRATIVE/);
  });

  it('needs one approval up to AED 2,000,000 and two above it, one more for HIGH risk', () => {
    expect(committeeApprovalsRequired(doa, aed(200_000_000n), 'LOW')).toBe(1);
    expect(committeeApprovalsRequired(doa, aed(200_000_001n), 'VERY_LOW')).toBe(2);
    expect(committeeApprovalsRequired(doa, aed(50_000_000n), 'HIGH')).toBe(2);
    expect(committeeApprovalsRequired(undefined, aed(900_000_000n), 'HIGH')).toBe(1);
  });

  const withDoa = (doaRaw: unknown) => parseSmeAssessmentPolicy({ ...tenantPolicy, delegationOfAuthority: doaRaw });
  const tier = (upTo: string | undefined, n: unknown) => ({
    ...(upTo === undefined ? {} : { upToMinorUnits: upTo }),
    approvalsRequired: n,
  });
  const ref = { policyRef: 'Test policy reference' };

  it.each([
    ['no tiers', { tiers: [], ...ref }],
    ['a bounded last tier', { tiers: [tier('100', 1)], ...ref }],
    ['an unbounded tier before the last', { tiers: [tier(undefined, 1), tier(undefined, 2)], ...ref }],
    ['tiers out of order', { tiers: [tier('500', 1), tier('100', 2), tier(undefined, 3)], ...ref }],
    ['zero approvals', { tiers: [tier(undefined, 0)], ...ref }],
    ['a fractional count', { tiers: [tier(undefined, 1.5)], ...ref }],
    [
      'a risk level the policy does not have',
      { tiers: [tier(undefined, 1)], additionalApprovalsByRiskLevel: { EXTREME: 1 }, ...ref },
    ],
    ['a negative add-on', { tiers: [tier(undefined, 1)], additionalApprovalsByRiskLevel: { HIGH: -1 }, ...ref }],
    ['no policy reference', { tiers: [tier(undefined, 1)] }],
    ['an unknown key', { tiers: [tier(undefined, 1)], chairOverride: true, ...ref }],
  ])('refuses a delegation of authority with %s, rather than defaulting', (_name, raw) => {
    expect(withDoa(raw).ok).toBe(false);
  });
});

// =============================================================================
// Credit report notes
// =============================================================================

describe('credit report notes', () => {
  const note = (app: BusinessApplication, text: string) =>
    recordCreditNotes(app, { recordedBy: 'analyst-1', text }, T + 5n);

  it('are recorded in committee, trimmed, as an event that does not move the stage', () => {
    const t = expectOk(note(inCommittee(), '  Strong cover; seasonal cash flow; recommend 60 months.  '));
    expect(t.application.status).toBe('IN_COMMITTEE');
    expect(t.application.creditNotes).toEqual({
      text: 'Strong cover; seasonal cash flow; recommend 60 months.',
      recordedBy: 'analyst-1',
      atEpochSeconds: T + 5n,
    });
    expect(t.event).toMatchObject({ eventType: 'CREDIT_NOTES_RECORDED', fromStage: 6, toStage: 6 });
  });

  it('keep the latest version on the record when revised', () => {
    const first = expectOk(note(inCommittee(), 'First draft of the summary.')).application;
    const second = expectOk(note(first, 'Revised summary after the site visit.')).application;
    expect(second.creditNotes?.text).toBe('Revised summary after the site visit.');
  });

  it('refuse an identity number, in either jurisdiction’s shape', () => {
    expectRefusal(
      note(inCommittee(), 'Owner 784-1990-1234567-1 is the guarantor'),
      'OP-DETERMINACY',
      'IDENTITY_NUMBER_IN_PAYLOAD',
    );
    expectRefusal(
      note(inCommittee(), 'Guarantor national id 1012345678'),
      'OP-DETERMINACY',
      'IDENTITY_NUMBER_IN_PAYLOAD',
    );
  });

  it('refuse empty notes and notes beyond a summary’s length', () => {
    expectRefusal(note(inCommittee(), '  '), 'OP-DETERMINACY', 'CREDIT_NOTES_REQUIRED');
    expectRefusal(
      note(inCommittee(), 'x'.repeat(CREDIT_NOTES_MAX_LENGTH + 1)),
      'OP-DETERMINACY',
      'CREDIT_NOTES_TOO_LONG',
    );
  });

  it('are refused before the assessment and after the decision', () => {
    expectRefusal(note(submitted(), 'Too early for notes.'), 'OP-DETERMINACY', 'TRANSITION_NOT_ALLOWED');
    const approved = expectOk(vote(inCommittee(), 'mcc-1', quorumOf(1))).application;
    expectRefusal(note(approved, 'Too late to change the record.'), 'OP-DETERMINACY', 'TRANSITION_NOT_ALLOWED');
  });
});
