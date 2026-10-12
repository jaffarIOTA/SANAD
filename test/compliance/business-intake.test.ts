/**
 * SME business intake and KYB/KYC (stages 1–4), before credit assessment.
 *
 * Each case attempts something KYB forbids — a check without the subject's
 * consent, a hand-over with a check missing or failed, an undeclared
 * beneficial owner, a referral cleared by the officer who opened the intake,
 * an identity number in the record — and passes only when it is refused.
 */
import { describe, expect, it } from 'vitest';

import { money } from '@sanad/core/kernel/money.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import {
  type BusinessIntake,
  type OpenIntakeInput,
  clearScreeningReferral,
  declareBeneficialOwners,
  kybGaps,
  markHandedOver,
  openIntake,
  recordConsent,
  recordIdentityCheck,
  recordRegistryCheck,
  recordScreening,
  verificationRefsOf,
  withdrawIntake,
} from '@sanad/core/origination/business-intake.ts';

import ownership from '../../config/regulatory/ae/beneficial-ownership.json' with { type: 'json' };

const T = 1_800_000_000n;
const THRESHOLD = ownership.ownershipThresholdPerTenThousand;

const INPUT: OpenIntakeInput = {
  intakeId: 'INT-000001',
  tenantId: 'sme-fund-ae',
  entity: {
    tradeLicence: 'CN-1234567',
    issuingAuthority: 'ADDED',
    businessNameEn: 'Intake Example Trading LLC',
    sector: 'TRADING',
    yearsInOperation: 5,
  },
  request: {
    productCode: 'sme-term-conventional',
    variantCode: 'EXPANSION',
    purpose: 'CAPEX_OPEX',
    requested: money(150_000_000n, 'AED'),
    tenorMonths: 48,
    graceMonths: 0,
    contributionPerTenThousand: 2000,
  },
  parties: [
    { partyRef: 'party-owner-a', displayName: 'Owner A', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 6000 },
    { partyRef: 'party-owner-b', displayName: 'Owner B', role: 'OWNER', ownershipPerTenThousand: 3000 },
    { partyRef: 'party-owner-c', displayName: 'Owner C', role: 'OWNER', ownershipPerTenThousand: 1000 },
  ],
};

const opened = (over: Partial<OpenIntakeInput> = {}): BusinessIntake =>
  expectOk(openIntake({ ...INPUT, ...over }, 'AED', 'officer-1', T)).intake;

function expectRefusal(r: Result<unknown>, control: string, reason: string): void {
  expect(r.ok, reason).toBe(false);
  if (!r.ok) expect({ control: r.error.control, reason: r.error.reason }).toEqual({ control, reason });
}

/** Every consent, every check passing, beneficial owners declared: ready to hand over. */
function complete(intake: BusinessIntake = opened()): BusinessIntake {
  let i = intake;
  const step = (r: Result<{ intake: BusinessIntake }>) => {
    i = expectOk(r).intake;
  };
  step(
    recordConsent(
      i,
      { consentId: 'cns-ent-scr', type: 'SCREENING', subject: 'ENTITY', evidenceRef: 'form-1' },
      'officer-1',
      T + 1n,
    ),
  );
  step(
    recordConsent(
      i,
      { consentId: 'cns-ent-bur', type: 'CREDIT_BUREAU', subject: 'ENTITY', evidenceRef: 'form-1' },
      'officer-1',
      T + 1n,
    ),
  );
  for (const p of i.parties) {
    step(
      recordConsent(
        i,
        {
          consentId: `cns-${p.partyRef}-id`,
          type: 'IDENTITY_VERIFICATION',
          subject: p.partyRef,
          evidenceRef: 'form-1',
        },
        'officer-1',
        T + 2n,
      ),
    );
    step(
      recordConsent(
        i,
        { consentId: `cns-${p.partyRef}-scr`, type: 'SCREENING', subject: p.partyRef, evidenceRef: 'form-1' },
        'officer-1',
        T + 2n,
      ),
    );
  }
  step(recordRegistryCheck(i, { status: 'ACTIVE', lookupRef: 'ner-lk-1', source: 'FIXTURE' }, 'officer-1', T + 3n));
  step(
    recordScreening(i, 'ENTITY', { outcome: 'CLEAR', resultRef: 'scr-ent-1', source: 'FIXTURE' }, 'officer-1', T + 3n),
  );
  for (const p of i.parties) {
    step(
      recordIdentityCheck(
        i,
        p.partyRef,
        { verified: true, verificationRef: `icp-${p.partyRef}`, source: 'FIXTURE' },
        'officer-1',
        T + 4n,
      ),
    );
    step(
      recordScreening(
        i,
        p.partyRef,
        { outcome: 'CLEAR', resultRef: `scr-${p.partyRef}`, source: 'FIXTURE' },
        'officer-1',
        T + 4n,
      ),
    );
  }
  step(
    declareBeneficialOwners(
      i,
      { declaredBy: 'party-owner-a', evidenceRef: 'ubo-form-1', uboRefs: ['party-owner-a', 'party-owner-b'] },
      THRESHOLD,
      'officer-1',
      T + 5n,
    ),
  );
  return i;
}

describe('opening an intake', () => {
  it('opens a draft with the parties and the request, and no checks yet', () => {
    const i = opened();
    expect(i.status).toBe('DRAFT');
    expect(kybGaps(i).map((g) => g.code)).toContain('REGISTRY_NOT_CHECKED');
  });

  it('refuses an identity number anywhere in the intake', () => {
    expectRefusal(
      openIntake(
        { ...INPUT, entity: { ...INPUT.entity, businessNameEn: 'Owner 784-1990-1234567-1 Trading' } },
        'AED',
        'officer-1',
        T,
      ),
      'OP-DETERMINACY',
      'IDENTITY_NUMBER_IN_PAYLOAD',
    );
  });

  it('accepts a UAE tax registration number, yet still refuses an Emirates ID in any shape', () => {
    const withTrn = openIntake(
      { ...INPUT, entity: { ...INPUT.entity, taxRegistrationNumber: '100123456700003' } },
      'AED',
      'officer-1',
      T,
    );
    expect(withTrn.ok).toBe(true);
    for (const id of ['784-1990-1234567-1', '784199012345671', '784 1990 1234567 1'])
      expectRefusal(
        openIntake(
          { ...INPUT, entity: { ...INPUT.entity, businessNameEn: `Owner ${id} Trading` } },
          'AED',
          'officer-1',
          T,
        ),
        'OP-DETERMINACY',
        'IDENTITY_NUMBER_IN_PAYLOAD',
      );
  });

  it('refuses a currency other than the tenant’s, and ownership above the whole', () => {
    expectRefusal(
      openIntake({ ...INPUT, request: { ...INPUT.request, requested: money(1n, 'SAR') } }, 'AED', 'officer-1', T),
      'OP-DETERMINACY',
      'CURRENCY_NOT_TENANTS',
    );
    expectRefusal(
      openIntake(
        {
          ...INPUT,
          parties: [
            ...INPUT.parties,
            { partyRef: 'party-x', displayName: 'X', role: 'OWNER', ownershipPerTenThousand: 500 },
          ],
        },
        'AED',
        'officer-1',
        T,
      ),
      'OP-DETERMINACY',
      'OWNERSHIP_ABOVE_WHOLE',
    );
  });

  it('refuses an intake no party may sign for', () => {
    expectRefusal(
      openIntake(
        {
          ...INPUT,
          parties: [{ partyRef: 'party-o', displayName: 'O', role: 'OWNER', ownershipPerTenThousand: 10_000 }],
        },
        'AED',
        'officer-1',
        T,
      ),
      'OP-DETERMINACY',
      'SIGNATORY_REQUIRED',
    );
  });
});

describe('consent comes before the check', () => {
  it('refuses an identity check without the party’s identity-verification consent', () => {
    expectRefusal(
      recordIdentityCheck(
        opened(),
        'party-owner-a',
        { verified: true, verificationRef: 'icp-1', source: 'FIXTURE' },
        'officer-1',
        T,
      ),
      'OP-DETERMINACY',
      'CONSENT_MISSING',
    );
  });

  it('refuses screening without the subject’s screening consent', () => {
    expectRefusal(
      recordScreening(opened(), 'ENTITY', { outcome: 'CLEAR', resultRef: 'scr-1', source: 'FIXTURE' }, 'officer-1', T),
      'OP-DETERMINACY',
      'CONSENT_MISSING',
    );
  });

  it('refuses a consent from someone who is not a party, or the same consent twice', () => {
    expectRefusal(
      recordConsent(
        opened(),
        { consentId: 'c1', type: 'SCREENING', subject: 'stranger', evidenceRef: 'f' },
        'officer-1',
        T,
      ),
      'OP-DETERMINACY',
      'CONSENT_SUBJECT_UNKNOWN',
    );
    const once = expectOk(
      recordConsent(
        opened(),
        { consentId: 'c1', type: 'SCREENING', subject: 'ENTITY', evidenceRef: 'f' },
        'officer-1',
        T,
      ),
    ).intake;
    expectRefusal(
      recordConsent(once, { consentId: 'c2', type: 'SCREENING', subject: 'ENTITY', evidenceRef: 'f' }, 'officer-1', T),
      'OP-DETERMINACY',
      'CONSENT_ALREADY_RECORDED',
    );
  });
});

describe('screening', () => {
  const consented = () =>
    expectOk(
      recordConsent(
        opened(),
        { consentId: 'c-ent', type: 'SCREENING', subject: 'ENTITY', evidenceRef: 'f' },
        'officer-1',
        T,
      ),
    ).intake;

  it('declines the intake on a REJECT, and nothing more can be done with it', () => {
    const declined = expectOk(
      recordScreening(
        consented(),
        'ENTITY',
        { outcome: 'REJECT', resultRef: 'scr-r', source: 'FIXTURE' },
        'officer-1',
        T,
      ),
    ).intake;
    expect(declined.status).toBe('DECLINED');
    expectRefusal(
      recordRegistryCheck(declined, { status: 'ACTIVE', lookupRef: 'ner-1', source: 'FIXTURE' }, 'officer-1', T),
      'OP-DETERMINACY',
      'INTAKE_NOT_OPEN',
    );
  });

  it('refuses a referral cleared by the officer who opened the intake, and clears it for a second person', () => {
    const referred = expectOk(
      recordScreening(
        consented(),
        'ENTITY',
        { outcome: 'REFER', resultRef: 'scr-ref', source: 'FIXTURE' },
        'officer-1',
        T,
      ),
    ).intake;
    expectRefusal(
      clearScreeningReferral(
        referred,
        'ENTITY',
        { clearedBy: 'officer-1', reason: 'Name match is a different company' },
        T,
      ),
      'OP-DETERMINACY',
      'FOUR_EYES_SELF_CLEARANCE',
    );
    const cleared = expectOk(
      clearScreeningReferral(
        referred,
        'ENTITY',
        { clearedBy: 'compliance-1', reason: 'Name match is a different company' },
        T,
      ),
    ).intake;
    expect(cleared.entityScreening?.clearance?.clearedBy).toBe('compliance-1');
    expect(kybGaps(cleared).some((g) => g.code === 'SCREENING_NOT_CLEAR' && g.subject === 'ENTITY')).toBe(false);
  });
});

describe('beneficial owners', () => {
  it('refuses a declaration that leaves out an owner at or above the threshold', () => {
    expectRefusal(
      declareBeneficialOwners(
        opened(),
        { declaredBy: 'party-owner-a', evidenceRef: 'ubo-1', uboRefs: ['party-owner-a'] },
        THRESHOLD,
        'officer-1',
        T,
      ),
      'OP-LIMIT',
      'UBO_OWNER_UNDECLARED',
    );
  });

  it('refuses a declaration made by someone who may not sign', () => {
    expectRefusal(
      declareBeneficialOwners(
        opened(),
        { declaredBy: 'party-owner-b', evidenceRef: 'ubo-1', uboRefs: ['party-owner-a', 'party-owner-b'] },
        THRESHOLD,
        'officer-1',
        T,
      ),
      'OP-DETERMINACY',
      'UBO_DECLARANT_NOT_SIGNATORY',
    );
  });

  it('uses the cited regulatory threshold of 25%', () => {
    expect(THRESHOLD).toBe(2500);
    expect(ownership.citation).toMatch(/Cabinet Decision No\. \(58\) of 2020/);
  });
});

describe('hand-over to credit assessment', () => {
  it('is refused while any check is missing, naming what is missing', () => {
    const r = markHandedOver(opened(), 'SN-00000001', 'officer-1', T + 9n);
    expectRefusal(r, 'OP-DETERMINACY', 'KYB_INCOMPLETE');
    if (!r.ok) expect(r.error.context?.['gaps']).toContain('REGISTRY_NOT_CHECKED');
  });

  it('is refused when the licence is not ACTIVE', () => {
    const i = complete();
    const expired = expectOk(
      recordRegistryCheck(i, { status: 'EXPIRED', lookupRef: 'ner-lk-2', source: 'FIXTURE' }, 'officer-1', T + 8n),
    ).intake;
    expectRefusal(markHandedOver(expired, 'SN-00000001', 'officer-1', T + 9n), 'OP-DETERMINACY', 'KYB_INCOMPLETE');
  });

  it('is refused when a party’s identity was not verified', () => {
    const i = complete();
    const unverified = expectOk(
      recordIdentityCheck(
        i,
        'party-owner-c',
        { verified: false, verificationRef: 'icp-mismatch', source: 'FIXTURE' },
        'officer-1',
        T + 8n,
      ),
    ).intake;
    expect(kybGaps(unverified)).toEqual([{ code: 'IDENTITY_NOT_VERIFIED', subject: 'party-owner-c' }]);
  });

  it('hands over when every check passes, carrying every check and consent reference', () => {
    const i = complete();
    expect(kybGaps(i)).toEqual([]);
    const t = expectOk(markHandedOver(i, 'SN-00000001', 'officer-1', T + 9n));
    expect(t.intake.status).toBe('HANDED_OVER');
    expect(t.event.eventType).toBe('HANDED_TO_ASSESSMENT');
    expect(verificationRefsOf(i)).toEqual(
      expect.arrayContaining(['ner-lk-1', 'scr-ent-1', 'icp-party-owner-a', 'cns-ent-bur']),
    );
  });

  it('cannot be withdrawn or changed after hand-over', () => {
    const handed = expectOk(markHandedOver(complete(), 'SN-00000001', 'officer-1', T + 9n)).intake;
    expectRefusal(
      withdrawIntake(handed, 'Applicant changed their mind', 'officer-1', T + 10n),
      'OP-DETERMINACY',
      'INTAKE_NOT_OPEN',
    );
  });
});
