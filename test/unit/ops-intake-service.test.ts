/**
 * The intake service end to end, in memory: an officer opens an intake,
 * captures consents, runs the registry, identity and screening checks through
 * the real UAE adapters over the demonstration transport, declares the
 * beneficial owners, and hands over into a stage-5 application.
 *
 * And the refusals that matter: no check without consent; the rails are
 * unavailable under a deployed profile that has not declared synthetic data;
 * no hand-over while any KYB gap remains.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import { getApplication, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import {
  type OpenIntakeForm,
  applicationIdFor,
  clearReferral,
  declareOwners,
  getIntake,
  handOverIntake,
  openIntakeFor,
  recordIntakeConsent,
  resetIntakeStore,
  runIdentityCheck,
  runRegistryCheck,
  runScreening,
} from '../../apps/ops/src/server/intake.ts';

const TENANT = 'sme-fund-ae';

const FORM: OpenIntakeForm = {
  tradeLicence: 'CN-7654321',
  issuingAuthority: 'ADDED',
  businessNameEn: 'Officer Intake Trading LLC',
  sector: 'TRADING',
  yearsInOperation: 6,
  productCode: 'sme-term-conventional',
  variantCode: 'EXPANSION',
  purpose: 'CAPEX_OPEX',
  requestedMinorUnits: 150_000_000n,
  tenorMonths: 48,
  graceMonths: 0,
  contributionPerTenThousand: 2000,
  parties: [
    { partyRef: 'party-a', displayName: 'Owner A', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 7000 },
    { partyRef: 'party-b', displayName: 'Owner B', role: 'OWNER', ownershipPerTenThousand: 3000 },
  ],
};

async function consentAll(intakeId: string): Promise<void> {
  for (const [type, subject] of [
    ['SCREENING', 'ENTITY'],
    ['CREDIT_BUREAU', 'ENTITY'],
    ['IDENTITY_VERIFICATION', 'party-a'],
    ['SCREENING', 'party-a'],
    ['IDENTITY_VERIFICATION', 'party-b'],
    ['SCREENING', 'party-b'],
  ] as const)
    expectOk(
      await recordIntakeConsent(TENANT, intakeId, { type, subject, evidenceRef: 'consent-form-1' }, 'officer-1'),
    );
}

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetIntakeStore();
  resetBusinessStore({ seed: false });
});
afterEach(() => vi.unstubAllEnvs());

describe('an officer-led intake, end to end', () => {
  it('opens, checks every party, declares owners and hands over into stage 5', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, FORM, 'officer-1'));
    expect(intake.intakeId).toMatch(/^INT-\d{6}$/);
    await consentAll(intake.intakeId);

    expectOk(await runRegistryCheck(TENANT, intake.intakeId, 'officer-1'));
    expectOk(await runScreening(TENANT, intake.intakeId, 'ENTITY', 'officer-1'));
    for (const p of ['party-a', 'party-b']) {
      expectOk(await runIdentityCheck(TENANT, intake.intakeId, p, 'officer-1'));
      expectOk(await runScreening(TENANT, intake.intakeId, p, 'officer-1'));
    }
    expectOk(
      await declareOwners(
        TENANT,
        intake.intakeId,
        { declaredBy: 'party-a', evidenceRef: 'ubo-form-1', uboRefs: ['party-a', 'party-b'] },
        'officer-1',
      ),
    );

    const view = await getIntake(TENANT, intake.intakeId);
    expect(view?.gaps).toEqual([]);
    expect(view?.railsSource).toBe('FIXTURE');
    expect(view?.intake.registry).toMatchObject({ status: 'ACTIVE', source: 'FIXTURE' });

    const handed = expectOk(await handOverIntake(TENANT, intake.intakeId, 'officer-1'));
    expect(handed.applicationId).toBe(applicationIdFor(intake.intakeId));
    expect(handed.intake.status).toBe('HANDED_OVER');

    const app = await getApplication(TENANT, handed.applicationId);
    expect(app?.application.status).toBe('RECEIVED');
    expect(app?.application.upstreamRef).toBe(`intake:${intake.intakeId}`);
    expect(app?.application.applicant.upstreamVerificationRefs).toEqual(
      expect.arrayContaining([`ner-demo-${FORM.tradeLicence}`, 'icp-demo-party-a', 'scr-demo-ENTITY']),
    );
  });

  it('records an expired licence and an identity mismatch, and will not hand over', async () => {
    const intake = expectOk(
      await openIntakeFor(
        TENANT,
        {
          ...FORM,
          tradeLicence: 'EXP-1111111',
          parties: [
            { partyRef: 'party-mismatch', displayName: 'M', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 10_000 },
          ],
        },
        'officer-1',
      ),
    );
    expectOk(
      await recordIntakeConsent(
        TENANT,
        intake.intakeId,
        { type: 'IDENTITY_VERIFICATION', subject: 'party-mismatch', evidenceRef: 'f' },
        'officer-1',
      ),
    );
    expectOk(await runRegistryCheck(TENANT, intake.intakeId, 'officer-1'));
    expectOk(await runIdentityCheck(TENANT, intake.intakeId, 'party-mismatch', 'officer-1'));
    const view = await getIntake(TENANT, intake.intakeId);
    expect(view?.intake.registry?.status).toBe('EXPIRED');
    expect(view?.gaps.map((g) => g.code)).toEqual(
      expect.arrayContaining(['REGISTRY_NOT_ACTIVE', 'IDENTITY_NOT_VERIFIED']),
    );
    const r = await handOverIntake(TENANT, intake.intakeId, 'officer-1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('KYB_INCOMPLETE');
  });

  it('refers a party on PEP, refuses the opener’s clearance, and accepts a second person’s', async () => {
    const intake = expectOk(
      await openIntakeFor(
        TENANT,
        {
          ...FORM,
          parties: [
            { partyRef: 'party-refer', displayName: 'R', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 10_000 },
          ],
        },
        'officer-1',
      ),
    );
    expectOk(
      await recordIntakeConsent(
        TENANT,
        intake.intakeId,
        { type: 'SCREENING', subject: 'party-refer', evidenceRef: 'f' },
        'officer-1',
      ),
    );
    expectOk(await runScreening(TENANT, intake.intakeId, 'party-refer', 'officer-1'));
    const self = await clearReferral(
      TENANT,
      intake.intakeId,
      'party-refer',
      'Different person, same name',
      'officer-1',
    );
    expect(!self.ok && self.error.reason).toBe('FOUR_EYES_SELF_CLEARANCE');
    const cleared = expectOk(
      await clearReferral(TENANT, intake.intakeId, 'party-refer', 'Different person, same name', 'compliance-1'),
    );
    expect(cleared.parties[0]?.screening?.clearance?.clearedBy).toBe('compliance-1');
  });
});

describe('the rails are not demonstrations everywhere', () => {
  it('refuses a check without consent before calling anything', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, FORM, 'officer-1'));
    const r = await runIdentityCheck(TENANT, intake.intakeId, 'party-a', 'officer-1');
    expect(!r.ok && r.error.reason).toBe('CONSENT_MISSING');
  });

  it('is unavailable under a deployed profile that has not declared synthetic data', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, FORM, 'officer-1'));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SANAD_DATA_CLASS', '');
    const r = await runRegistryCheck(TENANT, intake.intakeId, 'officer-1');
    expect(!r.ok && r.error.reason).toBe('RAIL_UNAVAILABLE');
    expect((await getIntake(TENANT, intake.intakeId))?.railsAvailable).toBe(false);
  });
});
