/**
 * K1 — the Saudi intake, end to end, in memory: an officer at a Saudi bank
 * opens an intake under the business's commercial registration (CR), records
 * consents, runs Wathq, Yakeen, screening and the zakat check through the real
 * Saudi adapters over the Saudi demonstration transport, declares the
 * beneficial owners against the Saudi threshold, and hands over into stage 5.
 *
 * And the refusals that matter: a CR has a national id's shape, so it is
 * accepted only in the registration field — a national id anywhere else is
 * still refused; a struck-off CR is a KYB gap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import { getApplication, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import {
  type OpenIntakeForm,
  declareOwners,
  getIntake,
  handOverIntake,
  openIntakeFor,
  recordIntakeConsent,
  resetIntakeStore,
  runIdentityCheck,
  runRegistryCheck,
  runScreening,
  runTaxCheck,
} from '../../apps/ops/src/server/intake.ts';

const TENANT = 'bank-a';

const FORM: OpenIntakeForm = {
  // A Saudi CR from the demonstration cast: ten digits, the shape of a national id.
  tradeLicence: '1010000101',
  issuingAuthority: 'MOC',
  businessNameEn: 'Riyadh Example Trading Co',
  sector: 'TRADING',
  yearsInOperation: 6,
  productCode: 'sme-term-conventional',
  variantCode: 'SME_TERM',
  purpose: 'WORKING_CAPITAL',
  requestedMinorUnits: 150_000_000n,
  tenorMonths: 36,
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
    expectOk(await recordIntakeConsent(TENANT, intakeId, { type, subject, evidenceRef: 'consent-form-1' }, 'stf-maker-01'));
}

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetIntakeStore();
  resetBusinessStore({ seed: false });
});
afterEach(() => vi.unstubAllEnvs());

describe('a Saudi intake, end to end', () => {
  it('opens under a CR, runs the Saudi checks, declares owners and hands over into stage 5 in SAR', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, FORM, 'stf-maker-01'));
    await consentAll(intake.intakeId);

    expectOk(await runRegistryCheck(TENANT, intake.intakeId, 'stf-maker-01'));
    expectOk(await runScreening(TENANT, intake.intakeId, 'ENTITY', 'stf-maker-01'));
    for (const p of ['party-a', 'party-b']) {
      expectOk(await runIdentityCheck(TENANT, intake.intakeId, p, 'stf-maker-01'));
      expectOk(await runScreening(TENANT, intake.intakeId, p, 'stf-maker-01'));
    }
    // The zakat certificate, by CR — no tax number keyed.
    const taxed = expectOk(await runTaxCheck(TENANT, intake.intakeId, 'stf-maker-01'));
    expect(taxed.taxCheck).toMatchObject({ status: 'VALID', source: 'FIXTURE' });
    expectOk(
      await declareOwners(
        TENANT,
        intake.intakeId,
        { declaredBy: 'party-a', evidenceRef: 'ubo-form-1', uboRefs: ['party-a', 'party-b'] },
        'stf-maker-01',
      ),
    );

    const view = await getIntake(TENANT, intake.intakeId);
    expect(view?.gaps).toEqual([]);
    expect(view?.intake.registry).toMatchObject({ status: 'ACTIVE', source: 'FIXTURE' });

    const handed = expectOk(await handOverIntake(TENANT, intake.intakeId, 'stf-maker-01'));
    const app = await getApplication(TENANT, handed.applicationId);
    expect(app?.application.status).toBe('RECEIVED');
    expect(app?.application.requested.currency).toBe('SAR');
    expect(app?.application.applicant.registrationRef).toBe(FORM.tradeLicence);
  });

  it('a national id anywhere but the registration field is still refused', async () => {
    const r = await openIntakeFor(TENANT, { ...FORM, businessNameEn: 'Owner 1012345678 Trading' }, 'stf-maker-01');
    expect(r.ok ? 'opened' : r.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
  });

  it('a struck-off CR is a KYB gap, and the intake will not hand over', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, { ...FORM, tradeLicence: '1010009999' }, 'stf-maker-01'));
    expectOk(await runRegistryCheck(TENANT, intake.intakeId, 'stf-maker-01'));
    const view = await getIntake(TENANT, intake.intakeId);
    expect(view?.gaps.map((g) => g.code)).toContain('REGISTRY_NOT_ACTIVE');
    const r = await handOverIntake(TENANT, intake.intakeId, 'stf-maker-01');
    expect(r.ok ? 'handed over' : r.error.reason).toBe('KYB_INCOMPLETE');
  });
});
