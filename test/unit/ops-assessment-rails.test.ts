/**
 * UAE M2a: the credit-assessment rails through Sanad's own intake, in memory,
 * on the real adapters over the demonstration transport.
 *
 * The bureau report is fetched under the business's intake consent and
 * becomes the assessment's bureau result — nothing typed overrides it. The
 * bank statements are fetched under the account-information consent and
 * confirmed by a second person. The VAT registration is checked by TRN. And
 * the refusals: a partner hand-over has no Sanad consent to fetch under; the
 * rails are unavailable outside a permitted demonstration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';

import {
  confirmBankStatementFacts,
  getApplication,
  handOver,
  recordAssessmentInputs,
  resetBusinessStore,
} from '../../apps/ops/src/server/business.ts';
import { fetchBankStatements, fetchBureauReport } from '../../apps/ops/src/server/business-rails.ts';
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

const TENANT = 'sme-fund-ae';

const form = (tradeLicence: string, extra: Partial<OpenIntakeForm> = {}): OpenIntakeForm => ({
  tradeLicence,
  issuingAuthority: 'DET',
  businessNameEn: 'Assessment Rails Trading LLC',
  sector: 'TRADING',
  yearsInOperation: 5,
  productCode: 'sme-term-conventional',
  variantCode: 'EXPANSION',
  purpose: 'CAPEX_OPEX',
  requestedMinorUnits: 150_000_000n,
  tenorMonths: 48,
  graceMonths: 0,
  contributionPerTenThousand: 2000,
  parties: [
    { partyRef: 'party-solo', displayName: 'Owner Solo', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 10_000 },
  ],
  ...extra,
});

/** A full intake through KYB, handed over; returns the stage-5 application id. */
async function handedOver(tradeLicence: string, extra: Partial<OpenIntakeForm> = {}): Promise<string> {
  const intake = expectOk(await openIntakeFor(TENANT, form(tradeLicence, extra), 'officer-1'));
  for (const [type, subject] of [
    ['SCREENING', 'ENTITY'],
    ['CREDIT_BUREAU', 'ENTITY'],
    ['ACCOUNT_INFORMATION', 'ENTITY'],
    ['IDENTITY_VERIFICATION', 'party-solo'],
    ['SCREENING', 'party-solo'],
  ] as const)
    expectOk(
      await recordIntakeConsent(TENANT, intake.intakeId, { type, subject, evidenceRef: 'consent-form-9' }, 'officer-1'),
    );
  expectOk(await runRegistryCheck(TENANT, intake.intakeId, 'officer-1'));
  expectOk(await runScreening(TENANT, intake.intakeId, 'ENTITY', 'officer-1'));
  expectOk(await runIdentityCheck(TENANT, intake.intakeId, 'party-solo', 'officer-1'));
  expectOk(await runScreening(TENANT, intake.intakeId, 'party-solo', 'officer-1'));
  expectOk(
    await declareOwners(
      TENANT,
      intake.intakeId,
      { declaredBy: 'party-solo', evidenceRef: 'ubo-9', uboRefs: ['party-solo'] },
      'officer-1',
    ),
  );
  return expectOk(await handOverIntake(TENANT, intake.intakeId, 'officer-1')).applicationId;
}

const inputs = {
  fullTimeEmployees: 12,
  relevantExperienceYears: 6n,
  sectorPriority: 'PRIORITY',
  auditedFinancialsAvailable: true,
  commitmentRatioPerTenThousand: 10_000n,
  riskAnalysisScorePerTenThousand: 7_000n,
  portfolioRepaymentPerTenThousand: 9_000n,
  failedFilesRatePerTenThousand: 500n,
  collateralValueMinorUnits: 100_000_000n,
};

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetIntakeStore();
  resetBusinessStore({ seed: false });
});
afterEach(() => vi.unstubAllEnvs());

describe('the bureau report, fetched under the intake consent', () => {
  it('records the summary and becomes the assessment’s bureau result; a typed score does not override it', async () => {
    const id = await handedOver('CN-7000001');
    const fetched = expectOk(await fetchBureauReport(TENANT, id, 'officer-1'));
    expect(fetched.bureauFetch).toMatchObject({ source: 'FIXTURE', score: 705n });
    const view = expectOk(
      await recordAssessmentInputs(
        TENANT,
        id,
        { ...inputs, bureau: { reportRef: 'typed-ref', consentId: 'anything', score: 9_999n } },
        'officer-1',
      ),
    );
    expect(view.assessmentInputs?.bureau).toMatchObject({ score: 705n, source: 'AECB_RAIL_FIXTURE' });
    expect(view.assessmentInputs?.bureau.reportRef).not.toBe('typed-ref');
  });

  it('carries a default through for a licence the demonstration marks as defaulted', async () => {
    const id = await handedOver('DEF-7000002');
    const fetched = expectOk(await fetchBureauReport(TENANT, id, 'officer-1'));
    expect(fetched.bureauFetch?.score).toBe(412n);
    expect(fetched.bureauFetch?.defaults).toBeGreaterThan(0);
  });

  it('refuses a partner hand-over: Sanad holds no consent to fetch under', async () => {
    expectOk(
      await handOver(
        TENANT,
        {
          applicationId: 'FR-00099001',
          upstreamRef: 'cif-partner-1',
          applicant: {
            businessNameEn: 'Partner Handed Trading LLC',
            registrationRef: 'CN-7000003',
            sector: 'TRADING',
            yearsInOperation: 5,
            owners: [{ displayName: 'Owner P', ref: 'owner-p' }],
            upstreamVerificationRefs: ['aecb:consent-partner-1'],
          },
          productCode: 'sme-term-conventional',
          variantCode: 'EXPANSION',
          purpose: 'CAPEX_OPEX',
          requestedMinorUnits: 150_000_000n,
          tenorMonths: 48,
          graceMonths: 0,
          contributionPerTenThousand: 2000,
        },
        'cif',
      ),
    );
    const r = await fetchBureauReport(TENANT, 'FR-00099001', 'officer-1');
    expect(!r.ok && r.error.reason).toBe('BUREAU_CONSENT_NOT_IN_SANAD');
  });

  it('still lets a partner hand-over key the result, labelled as keyed', async () => {
    const id = await handedOver('CN-7000004');
    const view = await getApplication(TENANT, id);
    const consent = view?.application.applicant.upstreamVerificationRefs.find((r) => r.endsWith(':credit_bureau'));
    const keyed = expectOk(
      await recordAssessmentInputs(
        TENANT,
        id,
        { ...inputs, bureau: { reportRef: 'aecb-rpt-1', consentId: consent as string, score: 700n } },
        'officer-1',
      ),
    );
    expect(keyed.assessmentInputs?.bureau.source).toBe('KEYED_FROM_UPSTREAM_REPORT');
  });
});

describe('the bank statements, through Open Finance', () => {
  it('records the four facts under the account-information consent, confirmed by a second person', async () => {
    const id = await handedOver('CN-7000005');
    const fetched = expectOk(await fetchBankStatements(TENANT, id, 'officer-1'));
    expect(fetched.bankFacts).toMatchObject({ source: 'FIXTURE', months: 12 });
    expect(typeof fetched.bankFacts?.averageMonthlyInflow.minorUnits).toBe('bigint');
    const self = await confirmBankStatementFacts(TENANT, id, 'officer-1');
    expect(!self.ok && self.error.reason).toBe('FOUR_EYES_SELF_CONFIRMATION');
    const confirmed = expectOk(await confirmBankStatementFacts(TENANT, id, 'checker-1'));
    expect(confirmed.bankFacts?.confirmedBy).toBe('checker-1');
  });
});

describe('the VAT registration, by TRN', () => {
  it('records the tax authority’s answer as information, never a gap', async () => {
    const intake = expectOk(
      await openIntakeFor(TENANT, form('CN-7000006', { taxRegistrationNumber: '100123456700003' }), 'officer-1'),
    );
    expectOk(await runTaxCheck(TENANT, intake.intakeId, 'officer-1'));
    const view = await getIntake(TENANT, intake.intakeId);
    expect(view?.intake.taxCheck).toMatchObject({ status: 'VALID', source: 'FIXTURE' });
    expect(view?.gaps.some((g) => String(g.code).includes('TAX'))).toBe(false);
  });

  it('records a TRN the demonstration does not know as not registered', async () => {
    const intake = expectOk(
      await openIntakeFor(TENANT, form('CN-7000007', { taxRegistrationNumber: '900000000000001' }), 'officer-1'),
    );
    expectOk(await runTaxCheck(TENANT, intake.intakeId, 'officer-1'));
    expect((await getIntake(TENANT, intake.intakeId))?.intake.taxCheck?.status).toBe('NOT_FOUND');
  });
});

describe('outside a permitted demonstration', () => {
  it('fetches nothing: the rails are unavailable', async () => {
    const id = await handedOver('CN-7000008');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SANAD_DATA_CLASS', '');
    const bureau = await fetchBureauReport(TENANT, id, 'officer-1');
    const bank = await fetchBankStatements(TENANT, id, 'officer-1');
    expect(!bureau.ok && bureau.error.reason).toBe('RAIL_UNAVAILABLE');
    expect(!bank.ok && bank.error.reason).toBe('RAIL_UNAVAILABLE');
    expect((await getApplication(TENANT, id))?.bureauFetch).toBeUndefined();
  });
});
