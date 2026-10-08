/**
 * A business application through stages 5–9. Each case attempts something the
 * journey forbids and passes only when it is refused.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  type BusinessApplication, type HandoverInput,
  approveStraightThrough, decideInCommittee, receiveHandover, recordAssessment, recordDisbursed, recordOfferSent, recordSigned, startSpreading, submitForAssessment, withdraw,
} from '@sanad/core/origination/business-application.ts';

const T = 1_800_000_000n;
const LETTER = 'a'.repeat(64);
const input: HandoverInput = {
  applicationId: 'FR-00009001', upstreamRef: 'cif-777', tenantId: 'sme-fund-ae',
  applicant: { businessNameEn: 'Example Landscaping LLC', registrationRef: 'licence-ref-1', sector: 'SERVICES', yearsInOperation: 4, owners: [{ displayName: 'Owner One', ref: 'owner-1' }], upstreamVerificationRefs: ['uaepass-1', 'ner-1'] },
  productCode: 'sme-term-conventional', variantCode: 'EXPANSION', purpose: 'CAPEX_OPEX', requested: money(200_000_000n, 'AED'), tenorMonths: 60, graceMonths: 0, contributionPerTenThousand: 2000,
};
const ready = { spreadComplete: true, missingFigures: [], checklistComplete: true, missingDocuments: [] };
const submitted = (): BusinessApplication => expectOk(submitForAssessment(expectOk(startSpreading(expectOk(receiveHandover(input, 'AED', 'cif', T)).application, 'officer-1', T + 1n)).application, ready, 'officer-1', T + 2n)).application;

describe('stage 5: hand-over', () => {
  it('arrives at stage 5 in the tenant’s currency, and only then', () => {
    const r = expectOk(receiveHandover(input, 'AED', 'cif', T));
    expect(r.application).toMatchObject({ status: 'RECEIVED', stage: 5 });
    const wrong = receiveHandover(input, 'SAR', 'cif', T);
    expect(wrong.ok).toBe(false); if (!wrong.ok) expect(wrong.error.reason).toBe('CURRENCY_NOT_TENANTS');
  });
  it('refuses an application without upstream verification, or carrying an identity number', () => {
    expect(receiveHandover({ ...input, applicant: { ...input.applicant, upstreamVerificationRefs: [] } }, 'AED', 'cif', T).ok).toBe(false);
    const withId = receiveHandover({ ...input, applicant: { ...input.applicant, owners: [{ displayName: 'Owner', ref: '784-1971-1234567-1' }] } }, 'AED', 'cif', T);
    expect(withId.ok).toBe(false); if (!withId.ok) expect(withId.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
  });
});

describe('stage 5: submission', () => {
  it('needs every figure verified and every mandatory document', () => {
    const spreading = expectOk(startSpreading(expectOk(receiveHandover(input, 'AED', 'cif', T)).application, 'officer-1', T + 1n)).application;
    const figures = submitForAssessment(spreading, { ...ready, spreadComplete: false, missingFigures: ['NET_PROFIT'] }, 'officer-1', T + 2n);
    expect(figures.ok).toBe(false); if (!figures.ok) expect(figures.error.reason).toBe('FIGURES_NOT_VERIFIED');
    const docs = submitForAssessment(spreading, { ...ready, checklistComplete: false, missingDocuments: ['WPS_SALARY_REPORT'] }, 'officer-1', T + 2n);
    expect(docs.ok).toBe(false); if (!docs.ok) expect(docs.error.reason).toBe('DOCUMENTS_MISSING');
  });
});

describe('stage 6: decisioning under four eyes', () => {
  it('a committee case cannot be decided by the officer who submitted it', () => {
    const inCommittee = expectOk(recordAssessment(submitted(), { outcome: 'COMMITTEE', riskLevel: 'LOW', cumulativeScore: 8837, assessmentRef: 'asm-1' }, 'engine', T + 3n)).application;
    expect(inCommittee.status).toBe('IN_COMMITTEE');
    const self = decideInCommittee(inCommittee, { decidedBy: 'officer-1', approved: true, reason: 'fine' }, T + 4n);
    expect(self.ok).toBe(false); if (!self.ok) expect(self.error.reason).toBe('FOUR_EYES_SELF_APPROVAL');
    expect(expectOk(decideInCommittee(inCommittee, { decidedBy: 'mcc-1', approved: true, reason: 'strong revenue growth' }, T + 4n)).application.status).toBe('APPROVED');
  });
  it('a straight-through case is approved by someone else, and only a straight-through case', () => {
    const stp = expectOk(recordAssessment(submitted(), { outcome: 'STRAIGHT_THROUGH', riskLevel: 'LOW', assessmentRef: 'asm-2' }, 'engine', T + 3n)).application;
    expect(approveStraightThrough(stp, 'officer-1', T + 4n).ok).toBe(false);
    expect(expectOk(approveStraightThrough(stp, 'checker-1', T + 4n)).application.status).toBe('APPROVED');
  });
  it('a declined application is closed', () => {
    const declined = expectOk(recordAssessment(submitted(), { outcome: 'DECLINE', assessmentRef: 'asm-3' }, 'engine', T + 3n)).application;
    expect(declined.status).toBe('DECLINED');
    expect(recordOfferSent(declined, { letterVersion: LETTER, channels: ['EMAIL'] }, 'officer-1', T + 4n).ok).toBe(false);
    expect(withdraw(declined, 'no longer needed', 'officer-1', T + 4n).ok).toBe(false);
  });
});

describe('stage 7: offer, signature, disbursement', () => {
  const approved = () => expectOk(decideInCommittee(expectOk(recordAssessment(submitted(), { outcome: 'COMMITTEE', assessmentRef: 'asm-1' }, 'engine', T + 3n)).application, { decidedBy: 'mcc-1', approved: true, reason: 'approved' }, T + 4n)).application;
  it('the signature must be on the letter that was sent; disbursement only after signing', () => {
    const sent = expectOk(recordOfferSent(approved(), { letterVersion: LETTER, channels: ['EMAIL', 'SMS'] }, 'officer-1', T + 5n)).application;
    expect(recordDisbursed(sent, 'pay-1', 'finance', T + 6n).ok).toBe(false);
    const other = recordSigned(sent, { signatureRef: 'sig-1', letterVersion: 'b'.repeat(64) }, 'uaepass', T + 6n);
    expect(other.ok).toBe(false); if (!other.ok) expect(other.error.reason).toBe('SIGNED_LETTER_NOT_SENT_LETTER');
    const signed = expectOk(recordSigned(sent, { signatureRef: 'sig-1', letterVersion: LETTER }, 'uaepass', T + 6n)).application;
    const paid = expectOk(recordDisbursed(signed, 'pay-1', 'finance', T + 7n));
    expect(paid.application).toMatchObject({ status: 'DISBURSED', stage: 8 });
    expect(paid.event).toMatchObject({ fromStage: 7, toStage: 8 });
  });
});
