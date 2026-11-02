/**
 * Document intelligence D3 through the real path: a Saudi intake records the
 * business's document-verification consent, hands over, and the documents it
 * then uploads are checked with the issuer's authenticity service (Tahaqoq,
 * the real adapter over the Saudi demonstration transport). Each case
 * attempts something the check must never do, and passes only when it does
 * not:
 *
 *   - call without consent: no consent at intake means the issuer is not
 *     asked, and the check says so — it does not pass;
 *   - pass silently: a document the issuer does not confirm cannot be
 *     accepted without the checker's written resolution, which is kept;
 *   - decide: refusing it needs no resolution, accepting it with one is the
 *     checker's call, and four eyes stand throughout;
 *   - gate on a rail: the service being down leaves the check not made and
 *     the document checked by a person exactly as before.
 *
 * In memory (bank-a), FIXTURE throughout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk, ok } from '@sanad/core/kernel/result.ts';

import { TahaqoqAdapter } from '../../adapters/ksa/tahaqoq/adapter.ts';
import {
  checklistStatus,
  getApplication,
  resetBusinessStore,
  validateDocument,
} from '../../apps/ops/src/server/business.ts';
import { uploadBusinessDocument } from '../../apps/ops/src/server/business-storage.ts';
import {
  type OpenIntakeForm,
  declareOwners,
  handOverIntake,
  openIntakeFor,
  recordIntakeConsent,
  resetIntakeStore,
  runIdentityCheck,
  runRegistryCheck,
  runScreening,
  runTaxCheck,
} from '../../apps/ops/src/server/intake.ts';
import { findingsFor, resetFindings } from '../../services/origination/src/documents/findings.ts';

const T = 'bank-a';
const MAKER = 'stf-maker-01';
const CHECKER = 'stf-checker-01';

const FORM: OpenIntakeForm = {
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
  parties: [{ partyRef: 'party-a', displayName: 'Owner A', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 10_000 }],
};

/** A Saudi intake through KYB, handed over; with or without the document-verification consent. */
async function application(documentConsent: boolean): Promise<string> {
  const intake = expectOk(await openIntakeFor(T, FORM, MAKER));
  const consents = [
    ['SCREENING', 'ENTITY'],
    ['CREDIT_BUREAU', 'ENTITY'],
    ['IDENTITY_VERIFICATION', 'party-a'],
    ['SCREENING', 'party-a'],
    ...(documentConsent ? [['DOCUMENT_VERIFICATION', 'ENTITY'] as const] : []),
  ] as const;
  for (const [type, subject] of consents)
    expectOk(await recordIntakeConsent(T, intake.intakeId, { type, subject, evidenceRef: 'consent-form-1' }, MAKER));
  expectOk(await runRegistryCheck(T, intake.intakeId, MAKER));
  expectOk(await runScreening(T, intake.intakeId, 'ENTITY', MAKER));
  expectOk(await runIdentityCheck(T, intake.intakeId, 'party-a', MAKER));
  expectOk(await runScreening(T, intake.intakeId, 'party-a', MAKER));
  expectOk(await runTaxCheck(T, intake.intakeId, MAKER));
  expectOk(
    await declareOwners(
      T,
      intake.intakeId,
      { declaredBy: 'party-a', evidenceRef: 'ubo-1', uboRefs: ['party-a'] },
      MAKER,
    ),
  );
  return expectOk(await handOverIntake(T, intake.intakeId, MAKER)).applicationId;
}

const CR = new TextEncoder().encode(
  '%PDF-1.7\nMinistry of Commerce\nCommercial Registration\nCR Number 1010000101\n%%EOF',
);

let id = '';
const upload = async () => expectOk(await uploadBusinessDocument(T, id, 'COMMERCIAL_REGISTRATION', CR, MAKER, 'c'));
const authentic = async () =>
  [...(await findingsFor(T, { kind: 'BUSINESS_APPLICATION', ref: id })).values()]
    .at(-1)
    ?.checks.find((c) => c.check === 'AUTHENTIC');
const crDoc = async () => (await getApplication(T, id))?.documents.at(-1);

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetIntakeStore();
  resetBusinessStore({ seed: false });
  resetFindings();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('asking the issuer', () => {
  it('asks under the intake consent, and keeps the answer with the issuer’s reference', async () => {
    id = await application(true);
    await upload();
    expect(await authentic()).toEqual({
      check: 'AUTHENTIC',
      outcome: 'PASS',
      reference: expect.stringMatching(/^THQ-DEMO-/),
      source: 'FIXTURE',
    });
  });

  it('without the consent, does not ask — and the check says why rather than passing', async () => {
    id = await application(false);
    const asked = vi.spyOn(TahaqoqAdapter.prototype, 'verifyDocument');
    await upload();
    expect(asked).not.toHaveBeenCalled();
    expect(await authentic()).toEqual({ check: 'AUTHENTIC', outcome: 'UNREADABLE', reason: 'NO_CONSENT' });
  });

  it('a document type the checklist does not ask about is never sent', async () => {
    id = await application(true);
    const asked = vi.spyOn(TahaqoqAdapter.prototype, 'verifyDocument');
    expectOk(await uploadBusinessDocument(T, id, 'ARTICLES_OF_ASSOCIATION', CR, MAKER, 'c'));
    expect(asked).not.toHaveBeenCalled();
  });
});

describe('a document the issuer does not confirm', () => {
  beforeEach(async () => {
    id = await application(true);
    vi.spyOn(TahaqoqAdapter.prototype, 'verifyDocument').mockResolvedValue(
      ok({ kind: 'ANSWERED', value: { authentic: false, verificationRef: 'THQ-DEMO-REFUTED' } }),
    );
    await upload();
  });

  it('is a failed check the checker sees — and the document stays pending', async () => {
    expect(await authentic()).toMatchObject({ outcome: 'FAIL', reference: 'THQ-DEMO-REFUTED' });
    expect((await crDoc())?.validationStatus).toBe('PENDING');
  });

  it('cannot be accepted silently: accepting takes a written resolution, which is kept', async () => {
    const ref = (await crDoc())?.documentRef ?? '';
    const silent = await validateDocument(T, id, ref, 'VALID', CHECKER);
    expect(silent.ok ? 'accepted' : silent.error.reason).toBe('AUTHENTICITY_UNRESOLVED');
    const token = await validateDocument(T, id, ref, 'VALID', CHECKER, 'ok');
    expect(token.ok ? 'accepted' : token.error.reason).toBe('AUTHENTICITY_UNRESOLVED');

    const resolution = 'Original sighted at branch; issuer record lags a renewal';
    const view = expectOk(await validateDocument(T, id, ref, 'VALID', CHECKER, resolution));
    expect(view.events.at(-1)).toMatchObject({
      eventType: 'DOCUMENT_VALIDATED',
      actor: CHECKER,
      detail: { validationStatus: 'VALID', authenticityResolution: resolution },
    });
    expect(
      expectOk(await checklistStatus(T, id)).report.find((r) => r.item.documentType === 'COMMERCIAL_REGISTRATION')
        ?.status,
    ).toBe('PRESENT');
  });

  it('refusing it needs no resolution, and four eyes stand even with one', async () => {
    const ref = (await crDoc())?.documentRef ?? '';
    const own = await validateDocument(T, id, ref, 'VALID', MAKER, 'Resolved by the presenter themselves');
    expect(own.ok ? 'accepted' : own.error.reason).toBe('FOUR_EYES_REQUIRED');
    expectOk(await validateDocument(T, id, ref, 'INVALID', CHECKER));
  });

  it('a resolution carrying an identity number is refused', async () => {
    const ref = (await crDoc())?.documentRef ?? '';
    const r = await validateDocument(T, id, ref, 'VALID', CHECKER, 'Owner 1012345678 confirmed in person');
    expect(r.ok ? 'accepted' : r.error.reason).toBe('IDENTITY_NUMBER_IN_PAYLOAD');
  });
});

describe('the issuer’s service down', () => {
  it('leaves the check not made, and the document is checked by a person as before', async () => {
    id = await application(true);
    vi.spyOn(TahaqoqAdapter.prototype, 'verifyDocument').mockResolvedValue(
      ok({ kind: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' }),
    );
    await upload();
    expect(await authentic()).toEqual({ check: 'AUTHENTIC', outcome: 'UNREADABLE', reason: 'RAIL_UNAVAILABLE' });
    expectOk(await validateDocument(T, id, (await crDoc())?.documentRef ?? '', 'VALID', CHECKER));
  });
});
