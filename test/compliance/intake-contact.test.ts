/**
 * Journey gap B1: an application opened through Sanad's own intake reaches its
 * signatory. The officer keys an email or mobile; the intake, its events and
 * the application carry the masked forms only; the delivery adapter alone reads
 * the details back, under a reference no other intake can share.
 *
 * Each refusal case attempts the outcome the platform must not allow: a
 * hand-over nobody can be told about, a raw address in the record, one
 * applicant's notice reaching another, a keyed value echoed in a refusal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { expectOk } from '@sanad/core/kernel/result.ts';
import { contactFrom, maskEmail, maskMobile, normaliseMobile } from '@sanad/core/notifications/contact.ts';
import { isMaskedEmail, isMaskedMobile } from '@sanad/core/notifications/offer-notification.ts';
import { contactRefOf } from '@sanad/core/origination/business-intake.ts';

import { getApplication, resetBusinessStore } from '../../apps/ops/src/server/business.ts';
import {
  type OpenIntakeForm,
  declareOwners,
  getIntake,
  handOverIntake,
  openIntakeFor,
  partyContactDirectory,
  recordIntakeConsent,
  recordIntakeContact,
  resetIntakeStore,
  runIdentityCheck,
  runRegistryCheck,
  runScreening,
} from '../../apps/ops/src/server/intake.ts';

const TENANT = 'sme-fund-ae';
const EMAIL = 'Signatory.One@Example.COM';
const MOBILE = '+971 (50) 123-4567';

const FORM: OpenIntakeForm = {
  tradeLicence: 'CN-7654321',
  issuingAuthority: 'ADDED',
  businessNameEn: 'Contact Trading LLC',
  sector: 'TRADING',
  yearsInOperation: 6,
  productCode: 'sme-term-conventional',
  variantCode: 'EXPANSION',
  purpose: 'CAPEX_OPEX',
  requestedMinorUnits: 150_000_000n,
  tenorMonths: 48,
  graceMonths: 0,
  contributionPerTenThousand: 2000,
  parties: [{ partyRef: 'party-a', displayName: 'Owner A', role: 'OWNER_SIGNATORY', ownershipPerTenThousand: 10_000 }],
};

const withContact = (contact: { email?: string; mobile?: string }): OpenIntakeForm => ({
  ...FORM,
  parties: FORM.parties.map((p) => ({ ...p, contact })),
});

async function completeKyb(intakeId: string): Promise<void> {
  for (const [type, subject] of [
    ['SCREENING', 'ENTITY'],
    ['CREDIT_BUREAU', 'ENTITY'],
    ['IDENTITY_VERIFICATION', 'party-a'],
    ['SCREENING', 'party-a'],
  ] as const)
    expectOk(await recordIntakeConsent(TENANT, intakeId, { type, subject, evidenceRef: 'consent-1' }, 'officer-1'));
  expectOk(await runRegistryCheck(TENANT, intakeId, 'officer-1'));
  expectOk(await runScreening(TENANT, intakeId, 'ENTITY', 'officer-1'));
  expectOk(await runIdentityCheck(TENANT, intakeId, 'party-a', 'officer-1'));
  expectOk(await runScreening(TENANT, intakeId, 'party-a', 'officer-1'));
  expectOk(
    await declareOwners(
      TENANT,
      intakeId,
      { declaredBy: 'party-a', evidenceRef: 'ubo-1', uboRefs: ['party-a'] },
      'officer-1',
    ),
  );
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

beforeEach(() => {
  vi.stubEnv('SANAD_DATABASE_URL', '');
  resetIntakeStore();
  resetBusinessStore({ seed: false });
});
afterEach(() => vi.unstubAllEnvs());

describe('a contact is normalised and masked once (B1)', () => {
  it('keeps the address and number in one form, and masks them as the platform expects', () => {
    const c = expectOk(contactFrom({ email: EMAIL, mobile: MOBILE }));
    expect(c.details).toEqual({ email: 'Signatory.One@example.com', mobile: '+971501234567' });
    expect(isMaskedEmail(c.masked.emailMasked ?? '')).toBe(true);
    expect(isMaskedMobile(c.masked.mobileMasked ?? '')).toBe(true);
    expect(c.masked).toEqual({ emailMasked: 'S***@example.com', mobileMasked: '+971 50 XXX XXXX' });
    expect(maskMobile('+966501234567')).toBe('+966 50 XXX XXXX');
    expect(maskEmail('a@b.sa')).toBe('a***@b.sa');
  });

  it('reads 00 as +, and refuses a number without its country code rather than guessing one', () => {
    expect(normaliseMobile('00966 50 123 4567')).toBe('+966501234567');
    expect(normaliseMobile('050 123 4567')).toBeUndefined();
    expect(normaliseMobile('+966 12')).toBeUndefined();
  });

  it('refuses no channel, a malformed address and a local number, naming the field and never the value', () => {
    const none = contactFrom({ email: ' ', mobile: '' });
    expect(!none.ok && none.error.reason).toBe('CONTACT_NO_CHANNEL');
    for (const [raw, reason] of [
      [{ email: 'not-an-address' }, 'CONTACT_EMAIL_INVALID'],
      [{ mobile: '0501234567' }, 'CONTACT_MOBILE_INVALID'],
    ] as const) {
      const r = contactFrom(raw);
      expect(!r.ok && r.error.reason).toBe(reason);
      expect(json(r)).not.toContain('not-an-address');
      expect(json(r)).not.toContain('0501234567');
    }
  });
});

describe('the intake reaches its signatory (B1)', () => {
  it('carries the masked forms only; the directory alone holds the details', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, withContact({ email: EMAIL, mobile: MOBILE }), 'officer-1'));
    expect(intake.parties[0]?.contact).toEqual({ emailMasked: 'S***@example.com', mobileMasked: '+971 50 XXX XXXX' });

    const view = await getIntake(TENANT, intake.intakeId);
    for (const raw of ['Signatory.One', '501234567', '123-4567']) {
      expect(json(view?.intake)).not.toContain(raw);
      expect(json(view?.events)).not.toContain(raw);
    }

    const held = await partyContactDirectory(TENANT).resolve(contactRefOf(intake.intakeId, 'party-a'));
    expect(held).toMatchObject({
      email: 'Signatory.One@example.com',
      mobile: '+971501234567',
      contextRef: intake.intakeId,
      recordedBy: 'officer-1',
    });
  });

  it('will not hand over until someone who signs can be reached', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, FORM, 'officer-1'));
    await completeKyb(intake.intakeId);
    expect((await getIntake(TENANT, intake.intakeId))?.gaps).toEqual([{ code: 'CONTACT_NOT_RECORDED' }]);
    const refused = await handOverIntake(TENANT, intake.intakeId, 'officer-1');
    expect(!refused.ok && refused.error.reason).toBe('KYB_INCOMPLETE');

    expectOk(await recordIntakeContact(TENANT, intake.intakeId, 'party-a', { mobile: MOBILE }, 'officer-1'));
    expect((await getIntake(TENANT, intake.intakeId))?.gaps).toEqual([]);
    expectOk(await handOverIntake(TENANT, intake.intakeId, 'officer-1'));
  });

  it('hands the application a masked contact under the intake-scoped reference, so the offer has a channel', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, withContact({ email: EMAIL }), 'officer-1'));
    await completeKyb(intake.intakeId);
    const handed = expectOk(await handOverIntake(TENANT, intake.intakeId, 'officer-1'));
    const app = await getApplication(TENANT, handed.applicationId);
    expect(app?.contact).toEqual({
      partyRef: contactRefOf(intake.intakeId, 'party-a'),
      emailMasked: 'S***@example.com',
    });
    expect(json(app)).not.toContain('Signatory.One');
  });

  it("one party reference on two intakes is two people: neither's notice reaches the other", async () => {
    const first = expectOk(await openIntakeFor(TENANT, withContact({ email: 'first@example.com' }), 'officer-1'));
    const second = expectOk(await openIntakeFor(TENANT, withContact({ email: 'second@example.com' }), 'officer-1'));
    const directory = partyContactDirectory(TENANT);
    expect((await directory.resolve(contactRefOf(first.intakeId, 'party-a')))?.email).toBe('first@example.com');
    expect((await directory.resolve(contactRefOf(second.intakeId, 'party-a')))?.email).toBe('second@example.com');
    expect(await directory.resolve('party-a')).toBeUndefined();
  });

  it('a correction supersedes; the intake shows the new mask', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, withContact({ email: EMAIL }), 'officer-1'));
    const changed = expectOk(
      await recordIntakeContact(TENANT, intake.intakeId, 'party-a', { email: 'new@example.com' }, 'officer-2'),
    );
    expect(changed.parties[0]?.contact).toEqual({ emailMasked: 'n***@example.com' });
    const held = await partyContactDirectory(TENANT).resolve(contactRefOf(intake.intakeId, 'party-a'));
    expect(held).toMatchObject({ email: 'new@example.com', recordedBy: 'officer-2' });
    expect(held?.mobile).toBeUndefined();
  });

  it('refuses a stranger to the intake, a bad number, and any change once handed over', async () => {
    const intake = expectOk(await openIntakeFor(TENANT, withContact({ email: EMAIL }), 'officer-1'));
    const stranger = await recordIntakeContact(TENANT, intake.intakeId, 'party-z', { email: EMAIL }, 'officer-1');
    expect(!stranger.ok && stranger.error.reason).toBe('PARTY_UNKNOWN');

    const bad = await recordIntakeContact(TENANT, intake.intakeId, 'party-a', { mobile: '0501234567' }, 'officer-1');
    expect(!bad.ok && bad.error.reason).toBe('CONTACT_MOBILE_INVALID');
    expect(json(bad)).not.toContain('0501234567');

    const atOpening = await openIntakeFor(TENANT, withContact({ email: 'nope' }), 'officer-1');
    expect(!atOpening.ok && atOpening.error.reason).toBe('CONTACT_EMAIL_INVALID');

    await completeKyb(intake.intakeId);
    expectOk(await handOverIntake(TENANT, intake.intakeId, 'officer-1'));
    const late = await recordIntakeContact(TENANT, intake.intakeId, 'party-a', { email: EMAIL }, 'officer-1');
    expect(!late.ok && late.error.reason).toBe('INTAKE_NOT_OPEN');
  });
});
