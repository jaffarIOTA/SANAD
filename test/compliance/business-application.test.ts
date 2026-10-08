/**
 * A business application through stages 5–9. Each case attempts something the
 * journey forbids and passes only when it is refused.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import {
  type BusinessApplication, type HandoverInput,
  approveStraightThrough, containsIdentityNumber, decideInCommittee, receiveHandover, recordAssessment, recordDisbursed, recordOfferSent, recordSigned, startSpreading, submitForAssessment, withdraw,
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
  it('scans the whole hand-over for an identity number, not only the applicant', () => {
    for (const tampered of [
      { ...input, upstreamRef: 'cif-784-1971-1234567-1' },
      { ...input, purpose: '784197112345671' },
      { ...input, applicant: { ...input.applicant, upstreamVerificationRefs: ['uaepass:784-1971-1234567-1'] } },
    ]) {
      const r = receiveHandover(tampered, 'AED', 'cif', T);
      expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
    }
    // An amount is a number, not text: a fifteen-digit amount in minor units is not mistaken for an identity number.
    expect(receiveHandover({ ...input, requested: money(100_000_000_000_000n, 'AED') }, 'AED', 'cif', T).ok).toBe(true);
  });
  it('containsIdentityNumber walks nested values and honours skipped keys', () => {
    expect(containsIdentityNumber({ contact: { partyRef: '784-1971-1234567-1' } })).toBe(true);
    expect(containsIdentityNumber([{ a: ['x', '784197112345671'] }])).toBe(true);
    expect(containsIdentityNumber({ requestedMinorUnits: '784197112345671' }, new Set(['requestedMinorUnits']))).toBe(false);
    expect(containsIdentityNumber({ n: 784197112345671n, m: 1 })).toBe(false);
  });
  it('#7 recognises both jurisdictions’ identity numbers: the Emirates ID and the Saudi national id / iqama', () => {
    // UAE: 784-YYYY-NNNNNNN-N, with dashes, spaces or none.
    for (const s of ['784-1971-1234567-1', '784 1971 1234567 1', 'ref:784197112345671']) expect(containsIdentityNumber(s), s).toBe(true);
    // KSA: ten digits starting 1 (citizen) or 2 (resident), alone or inside a reference.
    for (const s of ['1012345678', '2087654321', 'nid-1012345678', 'iqama:2087654321', 'see 1012345678 above']) expect(containsIdentityNumber(s), s).toBe(true);
    // Not an identity number: a ten-digit run starting otherwise, a longer or shorter run, an application id, a reference.
    for (const s of ['3012345678', '0512345678', '10123456789', '101234567', 'FR-00005101', 'doc-ILLUS-5101-TRADE_LICENCE', 'aecb:consent-test', '2026-10-08']) {
      expect(containsIdentityNumber(s), s).toBe(false);
    }
    // Amounts are numbers, never text: an amount shaped like either identity number is not scanned.
    expect(containsIdentityNumber({ minorUnits: 1_012_345_678n, count: 2_087_654_321, total: 784_197_112_345_671n })).toBe(false);
  });
  it('#7 refuses an identity number in a committee reason, a withdrawal reason, a signature or payment reference', () => {
    const inCommittee = expectOk(recordAssessment(submitted(), { outcome: 'COMMITTEE', assessmentRef: 'asm-9' }, 'engine', T + 3n)).application;
    for (const reason of ['Guarantor 784-1971-1234567-1 is strong', 'Owner 1012345678 has history']) {
      const d = decideInCommittee(inCommittee, { decidedBy: 'mcc-1', approved: true, reason }, T + 4n);
      expect(d.ok).toBe(false); if (!d.ok) expect(d.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
      const w = withdraw(inCommittee, reason, 'officer-1', T + 4n);
      expect(w.ok).toBe(false); if (!w.ok) expect(w.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
    }
    const approved = expectOk(decideInCommittee(inCommittee, { decidedBy: 'mcc-1', approved: true, reason: 'strong revenue growth' }, T + 4n)).application;
    const sent = expectOk(recordOfferSent(approved, { letterVersion: LETTER, channels: ['EMAIL'] }, 'officer-1', T + 5n)).application;
    const sig = recordSigned(sent, { signatureRef: 'sig-2087654321', letterVersion: LETTER }, 'uaepass', T + 6n);
    expect(sig.ok).toBe(false); if (!sig.ok) expect(sig.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
    const signed = expectOk(recordSigned(sent, { signatureRef: 'sig-1', letterVersion: LETTER }, 'uaepass', T + 6n)).application;
    const pay = recordDisbursed(signed, 'pay-784197112345671', 'finance', T + 7n);
    expect(pay.ok).toBe(false); if (!pay.ok) expect(pay.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
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
