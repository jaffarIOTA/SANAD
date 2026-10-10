/**
 * The UAE rail adapters against recorded fixtures (ADR 0005).
 *
 * The same properties as the Saudi rails — a good answer maps to the port; a
 * rail that is down is `UNAVAILABLE`, never a throw and never an answer; a
 * consent-gated rail refuses before any call; a malformed answer fails
 * closed — plus the one the UAE adds: every amount is AED, in minor units,
 * reached without a float.
 */
import { describe, expect, it } from 'vitest';

import { FixtureTransport, type Fixture } from '../../adapters/kernel/fixture-transport.ts';
import type { RailAdapterConfig } from '../../adapters/kernel/rail-adapter.ts';
import { aed, requireAed } from '../../adapters/uae/kernel/dirham.ts';
import { lookupStatus } from '../../adapters/uae/kernel/vocabulary.ts';
import { AECB_DEVIATIONS, AecbAdapter } from '../../adapters/uae/aecb/adapter.ts';
import { UAE_PASS_DEVIATIONS, UaePassAdapter } from '../../adapters/uae/uae-pass/adapter.ts';
import { ICP_DEVIATIONS, IcpAdapter } from '../../adapters/uae/icp/adapter.ts';
import { NER_DEVIATIONS, NerAdapter } from '../../adapters/uae/ner/adapter.ts';
import { MOHRE_DEVIATIONS, MohreAdapter } from '../../adapters/uae/mohre/adapter.ts';
import { FTA_DEVIATIONS, FtaAdapter } from '../../adapters/uae/fta/adapter.ts';
import { PARTNER_BANK_DEVIATIONS, PartnerBankAdapter } from '../../adapters/uae/partner-bank/adapter.ts';
import { type CredentialProvider, type CredentialRef, SecretValue } from '../../core/ports/credentials.ts';
import type { CreditBureauPort } from '../../core/ports/credit-bureau.ts';
import type { IdentityAuthenticationPort } from '../../core/ports/identity-authentication.ts';
import type { IdentityVerificationPort } from '../../core/ports/identity-verification.ts';
import type { BusinessRegistryPort } from '../../core/ports/business-registry.ts';
import type { EmploymentVerificationPort } from '../../core/ports/employment-verification.ts';
import type { TaxCompliancePort } from '../../core/ports/tax-compliance.ts';
import type { PaymentsPort } from '../../core/ports/payments.ts';
import { money } from '../../core/kernel/money.ts';
import { type Result, expectOk } from '../../core/kernel/result.ts';
import { tsaInstant } from '../../core/time/tsa.ts';
import { grantingLedger } from '../support/consents.ts';
import { inMemoryAssertionReplayGuard } from '../../core/ports/assertion-replay.ts';

class Credentials implements CredentialProvider {
  readonly refs: CredentialRef[] = [];
  async get(ref: CredentialRef): Promise<SecretValue> {
    this.refs.push(ref);
    return new SecretValue('a-provider-credential-value');
  }
}
const config = (provider: RailAdapterConfig['provider']): RailAdapterConfig => ({
  tenantId: 'sme-fund-ae',
  provider,
  environment: 'sandbox',
  freshnessWindowSeconds: 0,
  failurePosture: 'FAIL_CLOSED',
  credentialTtlSeconds: 600,
  breaker: { failureThreshold: 2, resetAfterSeconds: 30, successThreshold: 1 },
  nowEpochSeconds: () => 1_800_000_000,
  baseUrl: 'https://rail.sandbox.example',
  consents: grantingLedger('sme-fund-ae'),
  assertionReplay: inMemoryAssertionReplayGuard(),
});
const at = tsaInstant({ verified: true, genTimeEpochSeconds: 1_800_000_000n, tokenDigest: 't', authorityId: 'test' });
const attest = () => Promise.resolve(at);
const down = (operation: string): Fixture => ({ operation, match: {}, response: {}, failsWith: 'ECONNRESET' });
const answer = (
  operation: string,
  response: Readonly<Record<string, unknown>>,
  match: Readonly<Record<string, unknown>> = {},
): Fixture => ({ operation, match, response });
const transport = (...f: Fixture[]) => new FixtureTransport(f);
/** A row of a table that runs one rail call; every port's outcome has a kind. */
type Call = readonly [string, () => Promise<Result<{ readonly kind: string }>>];
const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

const aecb = (t: FixtureTransport) => new AecbAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest);
const uaePass = (t: FixtureTransport): IdentityAuthenticationPort =>
  new UaePassAdapter(config('IDENTITY_AUTHENTICATION'), new Credentials(), t);
const icp = (t: FixtureTransport): IdentityVerificationPort =>
  new IcpAdapter(config('IDENTITY_VERIFICATION'), new Credentials(), t);
const ner = (t: FixtureTransport): BusinessRegistryPort =>
  new NerAdapter(config('BUSINESS_REGISTRY'), new Credentials(), t);
const mohre = (t: FixtureTransport): EmploymentVerificationPort =>
  new MohreAdapter(config('EMPLOYMENT_VERIFICATION'), new Credentials(), t);
const fta = (t: FixtureTransport): TaxCompliancePort => new FtaAdapter(config('TAX_COMPLIANCE'), new Credentials(), t);
const bank = (t: FixtureTransport): PaymentsPort =>
  new PartnerBankAdapter(config('PAYMENTS_HUB'), new Credentials(), t);

const LICENCE = 'CN-1234567';
const bureauReq = (consentId = 'cns-1') => ({
  tenantId: 'sme-fund-ae',
  counterpartyId: 'cp-1',
  commercialRegistration: LICENCE,
  consentId,
  correlationId: 'c',
});

describe('dirhams at the boundary, without a float', () => {
  it.each([
    ['1234.56', 123_456n],
    ['0.5', 50n],
    ['7', 700n],
    [7, 700n],
    ['-3.05', -305n],
  ])('%s → %s fils, in AED', (v, n) => {
    expect(aed(v)).toEqual({ minorUnits: n, currency: 'AED' });
  });
  it('refuses a fractional JSON number, a third decimal, and a stated foreign currency', () => {
    expect(aed(1234.5)).toBeUndefined();
    expect(aed('1.234')).toBeUndefined();
    expect(aed('100.00', 'SAR')).toBeUndefined();
    expect(aed('100.00', 'AED')?.minorUnits).toBe(10_000n);
  });
  it('refuses to instruct a UAE rail in another currency', () => {
    expect(requireAed(money(1n, 'AED')).ok).toBe(true);
    const r = requireAed(money(1n, 'SAR'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('CURRENCY_MISMATCH');
  });
  it('maps status vocabulary by own keys only', () => {
    expect(lookupStatus({ ACTIVE: 'VALID' }, 'ACTIVE')).toBe('VALID');
    expect(lookupStatus({ ACTIVE: 'VALID' }, 'constructor')).toBeUndefined();
    expect(lookupStatus({ ACTIVE: 'VALID' }, 1)).toBeUndefined();
  });
});

describe('every UAE rail: an unreachable rail is UNAVAILABLE, not an answer', () => {
  it.each([
    ['AECB', () => (aecb(transport(down('bureau.commercial'))) as CreditBureauPort).request(bureauReq())],
    [
      'UAE Pass',
      () =>
        uaePass(transport(down('identity.start'))).startAuthentication({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          purpose: 'LOGIN',
          correlationId: 'c',
        }),
    ],
    [
      'ICP',
      () =>
        icp(transport(down('identity.verify'))).verify({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          consentId: 'cns',
          correlationId: 'c',
        }),
    ],
    [
      'NER',
      () =>
        ner(transport(down('registry.lookup'))).lookup({
          tenantId: 'sme-fund-ae',
          commercialRegistration: LICENCE,
          correlationId: 'c',
        }),
    ],
    [
      'MOHRE',
      () =>
        mohre(transport(down('employment.wps'))).employment({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          consentId: 'cns',
          correlationId: 'c',
        }),
    ],
    [
      'FTA',
      () =>
        fta(transport(down('tax.registration'))).certificateStatus({
          tenantId: 'sme-fund-ae',
          crNumber: '100123456700003',
          correlationId: 'c',
        }),
    ],
    [
      'Partner bank',
      () =>
        bank(transport(down('payments.disburse'))).disburse({
          tenantId: 'sme-fund-ae',
          beneficiaryRef: 'b',
          amount: money(100n, 'AED'),
          purposeCode: 'LOA',
          reference: 'r',
          idempotencyKey: 'k',
          correlationId: 'c',
        }),
    ],
  ] as readonly Call[])('%s', async (_name, call) => {
    const r = expectOk(await call());
    expect(r.kind).toBe('UNAVAILABLE');
  });
  it('a refusing bureau routes to the unavailable exception, never a decline', async () => {
    const t = transport({ operation: 'bureau.commercial', match: {}, response: {}, failsWith: 'x' });
    expect(expectOk(await aecb(t).request(bureauReq())).kind).toBe('UNAVAILABLE');
  });
  it('the circuit opens after repeated failures and reports UNAVAILABLE without calling', async () => {
    const t = transport(down('employment.wps'));
    const a = mohre(t);
    const call = () =>
      a.employment({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: 'cns', correlationId: 'c' });
    await call();
    await call();
    const third = expectOk(await call());
    expect(third.kind).toBe('UNAVAILABLE');
    if (third.kind === 'UNAVAILABLE') expect(third.reason).toBe('circuit open');
    expect(t.calls).toHaveLength(2);
  });
});

describe('consent-gated UAE rails refuse before any call', () => {
  it.each([
    ['AECB commercial', (t: FixtureTransport) => aecb(t).request(bureauReq(''))],
    [
      'AECB individual',
      (t: FixtureTransport) =>
        aecb(t).requestIndividual({
          tenantId: 'sme-fund-ae',
          applicantRef: 'owner-1',
          consentId: '  ',
          correlationId: 'c',
        }),
    ],
    [
      'ICP',
      (t: FixtureTransport) =>
        icp(t).verify({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: '', correlationId: 'c' }),
    ],
    [
      'MOHRE',
      (t: FixtureTransport) =>
        mohre(t).employment({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: ' ', correlationId: 'c' }),
    ],
  ] as const)('%s', async (_name, call) => {
    const t = transport();
    const r = await call(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('CONSENT_MISSING');
    expect(t.calls).toHaveLength(0);
  });
});

describe('a malformed answer fails closed', () => {
  it.each([
    [
      'AECB without a report id',
      () =>
        aecb(transport(answer('bureau.commercial', { subjectFound: true, totalOutstanding: '1.00' }))).request(
          bureauReq(),
        ),
    ],
    [
      'AECB with a float amount',
      () =>
        aecb(
          transport(
            answer('bureau.commercial', {
              reportId: 'r',
              subjectFound: true,
              totalOutstanding: 1200.5,
              totalOverdue: '0',
              maxDaysPastDue: 0,
              activeContracts: 1,
            }),
          ),
        ).request(bureauReq()),
    ],
    [
      'AECB in another currency',
      () =>
        aecb(
          transport(
            answer('bureau.commercial', {
              reportId: 'r',
              subjectFound: true,
              currency: 'SAR',
              totalOutstanding: '1.00',
              totalOverdue: '0',
              maxDaysPastDue: 0,
              activeContracts: 1,
            }),
          ),
        ).request(bureauReq()),
    ],
    [
      'AECB with one unreadable default',
      () =>
        aecb(
          transport(
            answer('bureau.commercial', {
              reportId: 'r',
              subjectFound: true,
              totalOutstanding: '1.00',
              totalOverdue: '0',
              maxDaysPastDue: 0,
              activeContracts: 1,
              defaults: [{ amount: '1.005' }],
            }),
          ),
        ).request(bureauReq()),
    ],
    [
      'UAE Pass with an unknown assurance level',
      () =>
        uaePass(
          transport(
            answer('identity.confirm', {
              status: 'COMPLETED',
              assuranceLevel: 'SOP9',
              flow: 'AUTHENTICATE',
              assertionId: 'a',
              subjectRef: 's',
              completedAt: 1,
            }),
          ),
        ).confirmAuthentication({ tenantId: 'sme-fund-ae', transactionRef: 'tx', correlationId: 'c' }),
    ],
    [
      'ICP with an unknown card status',
      () =>
        icp(
          transport(
            answer('identity.verify', { matched: true, cardStatus: 'toString', verificationId: 'v', verifiedAt: 1 }),
          ),
        ).verify({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: 'cns', correlationId: 'c' }),
    ],
    [
      'NER with an unknown licence status',
      () =>
        ner(
          transport(
            answer('registry.lookup', {
              tradeNameAr: 'شركة',
              tradeNameEn: 'Co',
              legalForm: 'LLC',
              licenceStatus: 'UNDER_REVIEW',
              asOf: 1,
            }),
          ),
        ).lookup({ tenantId: 'sme-fund-ae', commercialRegistration: LICENCE, correlationId: 'c' }),
    ],
    [
      'MOHRE with an unreadable month',
      () =>
        mohre(
          transport(
            answer('employment.wps', {
              employed: true,
              asOf: 1,
              reportId: 'w',
              salaryMonths: [
                { month: '2026-09', paidAmount: '15000.00' },
                { month: '2026-13', paidAmount: '1.00' },
              ],
            }),
          ),
        ).employment({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: 'cns', correlationId: 'c' }),
    ],
    [
      'FTA with an unknown status',
      () =>
        fta(transport(answer('tax.registration', { registrationStatus: 'SOMETHING_NEW', asOf: 1 }))).certificateStatus({
          tenantId: 'sme-fund-ae',
          crNumber: '100123456700003',
          correlationId: 'c',
        }),
    ],
    [
      'Partner bank with an unknown status',
      () =>
        bank(
          transport(answer('payments.disburse', { paymentId: 'p', status: 'PROBABLY_PAID', acceptedAt: 1 })),
        ).disburse({
          tenantId: 'sme-fund-ae',
          beneficiaryRef: 'b',
          amount: money(100n, 'AED'),
          purposeCode: 'LOA',
          reference: 'r',
          idempotencyKey: 'k',
          correlationId: 'c',
        }),
    ],
  ] as readonly Call[])('%s', async (_name, call) => {
    const r = expectOk(await call());
    expect(r).toEqual({ kind: 'UNAVAILABLE', reason: 'response malformed' });
  });
});

describe('answers map to the port in AED, and identifiers do not cross', () => {
  it('AECB maps a commercial report to AED minor units, keyed by the trade licence, and attests the retrieval', async () => {
    const t = transport(
      answer(
        'bureau.commercial',
        {
          reportId: 'aecb-r-1',
          subjectFound: true,
          currency: 'AED',
          totalOutstanding: '250000.00',
          totalOverdue: '1250.75',
          maxDaysPastDue: 30,
          activeContracts: 3,
          score: 688,
          defaults: [{ amount: '4000.10', settled: false }],
          emiratesId: 'SHOULD NOT CROSS',
        },
        { tradeLicenceNumber: LICENCE, consentRef: 'cns-1' },
      ),
    );
    const r = expectOk(await (aecb(t) as CreditBureauPort).request(bureauReq()));
    expect(r.kind).toBe('REPORT');
    if (r.kind === 'REPORT') {
      expect(r.summary.totalExposure).toEqual({ minorUnits: 25_000_000n, currency: 'AED' });
      expect(r.summary.overdueAmount).toEqual({ minorUnits: 125_075n, currency: 'AED' });
      expect(r.summary.defaults).toEqual([{ amount: { minorUnits: 400_010n, currency: 'AED' }, settled: false }]);
      expect(r.summary.bureauScore).toBe(688);
      expect(r.summary.worstDelinquencyDays).toBe(30);
      expect(r.summary.retrievedAt).toBe(at);
    }
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    expect(t.calls[0]?.headers['authorization']).toMatch(/^Bearer /);
  });
  it('AECB: no hit is NO_RECORD with the bureau reference; an individual report is keyed by reference', async () => {
    expect(
      expectOk(
        await aecb(transport(answer('bureau.commercial', { reportId: 'r-0', subjectFound: false }))).request(
          bureauReq(),
        ),
      ),
    ).toEqual({ kind: 'NO_RECORD', bureauReference: 'r-0' });
    const t = transport(
      answer(
        'bureau.individual',
        {
          reportId: 'r-i',
          subjectFound: true,
          totalOutstanding: '0',
          totalOverdue: '0',
          maxDaysPastDue: 0,
          activeContracts: 0,
        },
        { applicantRef: 'owner-1' },
      ),
    );
    const r = expectOk(
      await aecb(t).requestIndividual({
        tenantId: 'sme-fund-ae',
        applicantRef: 'owner-1',
        consentId: 'cns',
        correlationId: 'c',
      }),
    );
    expect(r.kind).toBe('REPORT');
    if (r.kind === 'REPORT') expect(r.summary.totalExposure.currency).toBe('AED');
  });
  it('AECB reporting carries the idempotency key and refuses a facility event not in AED', async () => {
    const t = transport(
      answer(
        'bureau.report',
        { submissionId: 'ack-1' },
        { facilityRef: 'f-1', idempotencyKey: 'k-1', currency: 'AED', amount: '500000' },
      ),
    );
    const rep = {
      tenantId: 'sme-fund-ae',
      facilityRef: 'f-1',
      counterpartyId: 'cp',
      event: 'OPENED' as const,
      amount: money(500_000n, 'AED'),
      asOfEpochSeconds: 1n,
      idempotencyKey: 'k-1',
      correlationId: 'c',
    };
    expect(expectOk(await aecb(t).report(rep))).toEqual({ kind: 'ACKNOWLEDGED', acknowledgementRef: 'ack-1' });
    const sar = await aecb(transport()).report({ ...rep, amount: money(500_000n, 'SAR') });
    expect(sar.ok).toBe(false);
    if (!sar.ok) expect(sar.error.reason).toBe('CURRENCY_MISMATCH');
  });
  it('UAE Pass: a verified login maps to an assertion; the Emirates ID and profile never cross', async () => {
    const start = transport(
      answer(
        'identity.start',
        { transactionId: 'tx-1', expiresAt: 1_800_000_300 },
        { applicantRef: 'app-1', flow: 'SIGN' },
      ),
    );
    expect(
      expectOk(
        await uaePass(start).startAuthentication({
          tenantId: 'sme-fund-ae',
          applicantRef: 'app-1',
          purpose: 'SIGNATURE_INTENT',
          correlationId: 'c',
        }),
      ),
    ).toEqual({ kind: 'ANSWERED', value: { transactionRef: 'tx-1', expiresAtEpochSeconds: 1_800_000_300n } });
    const t = transport(
      answer('identity.confirm', {
        status: 'COMPLETED',
        assuranceLevel: 'SOP3',
        flow: 'SIGN',
        assertionId: 'as-1',
        subjectRef: 'sub-1',
        completedAt: 1_800_000_100,
        idn: 'SHOULD NOT CROSS',
        mobile: 'SHOULD NOT CROSS',
      }),
    );
    const r = expectOk(
      await uaePass(t).confirmAuthentication({ tenantId: 'sme-fund-ae', transactionRef: 'tx-1', correlationId: 'c' }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { assertionId: 'as-1', identityRef: 'sub-1', authenticatedAtEpochSeconds: 1_800_000_100n },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
  });
  it('UAE Pass: a basic account may log in but not step up or sign', async () => {
    const confirm = (flow: string) =>
      uaePass(
        transport(
          answer('identity.confirm', {
            status: 'COMPLETED',
            assuranceLevel: 'SOP1',
            flow,
            assertionId: 'a',
            subjectRef: 's',
            // Within the step-up window of the adapter's clock; a 1970 completion is refused as stale (SR-007).
            completedAt: 1_800_000_000,
          }),
        ),
      ).confirmAuthentication({ tenantId: 'sme-fund-ae', transactionRef: 'tx', correlationId: 'c' });
    expect(expectOk(await confirm('AUTHENTICATE')).kind).toBe('ANSWERED');
    expect(expectOk(await confirm('SIGN'))).toEqual({ kind: 'REFUSED', code: 'ASSURANCE_INSUFFICIENT' });
    expect(expectOk(await confirm('AUTHENTICATE_STEP_UP'))).toEqual({
      kind: 'REFUSED',
      code: 'ASSURANCE_INSUFFICIENT',
    });
    const pending = uaePass(transport(answer('identity.confirm', { status: 'PENDING' })));
    expect(
      expectOk(
        await pending.confirmAuthentication({ tenantId: 'sme-fund-ae', transactionRef: 'tx', correlationId: 'c' }),
      ),
    ).toEqual({ kind: 'REFUSED', code: 'STATUS_PENDING' });
  });
  it('ICP: a matching but expired card is not verified, and attributes never cross', async () => {
    const t = transport(
      answer(
        'identity.verify',
        {
          matched: true,
          cardStatus: 'EXPIRED',
          verificationId: 'v-1',
          verifiedAt: 1_800_000_100,
          mismatchedFields: [],
          fullNameEn: 'SHOULD NOT CROSS',
          dateOfBirth: '1990-01-01',
        },
        { applicantRef: 'app-1', consentRef: 'cns-1' },
      ),
    );
    const r = expectOk(
      await icp(t).verify({ tenantId: 'sme-fund-ae', applicantRef: 'app-1', consentId: 'cns-1', correlationId: 'c' }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: {
        verified: false,
        verificationRef: 'v-1',
        verifiedAtEpochSeconds: 1_800_000_100n,
        mismatches: ['card_status'],
      },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    const valid = transport(
      answer('identity.verify', { matched: true, cardStatus: 'VALID', verificationId: 'v-2', verifiedAt: 1 }),
    );
    const ok2 = expectOk(
      await icp(valid).verify({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: 'cns', correlationId: 'c' }),
    );
    expect(ok2.kind === 'ANSWERED' && ok2.value.verified).toBe(true);
  });
  it('NER: owners become references, capital becomes AED fils, an unknown licence is NOT_FOUND, a malformed licence never calls', async () => {
    const t = transport(
      answer(
        'registry.lookup',
        {
          tradeNameAr: 'مؤسسة الاختبار',
          tradeNameEn: 'Test Trading LLC',
          legalForm: 'LLC',
          licenceStatus: 'ACTIVE',
          asOf: 1_800_000_000,
          lookupId: 'ner-lk-1',
          shareCapital: '300000.00',
          capitalCurrency: 'AED',
          issuedAt: '2019-04-01',
          activities: [{ code: '4690.01' }],
          owners: [{ ref: 'own-1', emiratesId: 'SHOULD NOT CROSS' }],
          managers: [{ ref: 'own-1' }, { ref: 'mgr-2', passportNumber: 'SHOULD NOT CROSS' }],
        },
        { url: `https://rail.sandbox.example/v1/trade-licences/${LICENCE}` },
      ),
    );
    const r = expectOk(
      await ner(t).lookup({ tenantId: 'sme-fund-ae', commercialRegistration: LICENCE, correlationId: 'c' }),
    );
    expect(r.kind).toBe('ANSWERED');
    if (r.kind === 'ANSWERED') {
      expect(r.value.signatoryRefs).toEqual(['own-1', 'mgr-2']);
      expect(r.value.activityCodes).toEqual(['4690.01']);
      expect(r.value.paidCapitalMinorUnits).toBe(30_000_000n);
      expect(r.value.commercialRegistration).toBe(LICENCE);
      expect(r.value.status).toBe('ACTIVE');
    }
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    const missing = ner(transport({ operation: 'registry.lookup', match: {}, response: {}, failsWith: 'x' }));
    expect(
      expectOk(await missing.lookup({ tenantId: 'sme-fund-ae', commercialRegistration: LICENCE, correlationId: 'c' }))
        .kind,
    ).toBe('UNAVAILABLE');
    const none = transport();
    const bad = await ner(none).lookup({ tenantId: 'sme-fund-ae', commercialRegistration: '../x', correlationId: 'c' });
    expect(bad.ok).toBe(false);
    expect(none.calls).toHaveLength(0);
  });
  it('NER: a capital stated in another currency is left out, not relabelled', async () => {
    const t = transport(
      answer('registry.lookup', {
        tradeNameAr: 'ش',
        tradeNameEn: 'Co',
        legalForm: 'LLC',
        licenceStatus: 'FROZEN',
        asOf: 1,
        shareCapital: '1000.00',
        capitalCurrency: 'USD',
      }),
    );
    const r = expectOk(
      await ner(t).lookup({ tenantId: 'sme-fund-ae', commercialRegistration: LICENCE, correlationId: 'c' }),
    );
    expect(r.kind).toBe('ANSWERED');
    if (r.kind === 'ANSWERED') {
      expect(r.value).not.toHaveProperty('paidCapitalMinorUnits');
      expect(r.value.status).toBe('SUSPENDED');
    }
  });
  it('MOHRE: the registered salary is the latest WPS month, in AED fils, with the report reference', async () => {
    const t = transport(
      answer(
        'employment.wps',
        {
          employed: true,
          asOf: 1_800_000_000,
          reportId: 'wps-1',
          establishmentRef: 'est-1',
          employedSince: 1_600_000_000,
          labourCardNumber: 'SHOULD NOT CROSS',
          salaryMonths: [
            { month: '2026-07', paidAmount: '14500.00' },
            { month: '2026-09', paidAmount: '15250.50', currency: 'AED' },
            { month: '2026-08', paidAmount: '15000.00' },
          ],
        },
        { applicantRef: 'app-1', consentRef: 'cns-1' },
      ),
    );
    const r = expectOk(
      await mohre(t).employment({
        tenantId: 'sme-fund-ae',
        applicantRef: 'app-1',
        consentId: 'cns-1',
        correlationId: 'c',
      }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: {
        employed: true,
        retrievedAtEpochSeconds: 1_800_000_000n,
        referenceId: 'wps-1',
        employerRef: 'est-1',
        registeredSalary: { minorUnits: 1_525_050n, currency: 'AED' },
        employedSinceEpochSeconds: 1_600_000_000n,
      },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
  });
  it('FTA: a TRN and a trade licence are both accepted keys; a registered taxpayer is VALID; a malformed key never calls', async () => {
    const byTrn = transport(
      answer(
        'tax.registration',
        {
          registrationStatus: 'REGISTERED',
          asOf: 1_800_000_000,
          certificateNumber: 'TRC-1',
          validUntil: 1_830_000_000,
        },
        { url: 'https://rail.sandbox.example/v1/registrations?trn=100123456700003' },
      ),
    );
    expect(
      expectOk(
        await fta(byTrn).certificateStatus({
          tenantId: 'sme-fund-ae',
          crNumber: '100123456700003',
          correlationId: 'c',
        }),
      ),
    ).toEqual({
      kind: 'ANSWERED',
      value: {
        status: 'VALID',
        retrievedAtEpochSeconds: 1_800_000_000n,
        certificateRef: 'TRC-1',
        validUntilEpochSeconds: 1_830_000_000n,
      },
    });
    const byLicence = transport(
      answer(
        'tax.registration',
        { registrationStatus: 'NOT_REGISTERED', asOf: 1 },
        { url: 'https://rail.sandbox.example/v1/registrations?licence=CN-1234567' },
      ),
    );
    const nf = expectOk(
      await fta(byLicence).certificateStatus({ tenantId: 'sme-fund-ae', crNumber: LICENCE, correlationId: 'c' }),
    );
    expect(nf.kind === 'ANSWERED' && nf.value.status).toBe('NOT_FOUND');
    const none = transport();
    expect((await fta(none).certificateStatus({ tenantId: 'sme-fund-ae', crNumber: '!', correlationId: 'c' })).ok).toBe(
      false,
    );
    expect(none.calls).toHaveLength(0);
  });
  it('Partner bank: AED in minor units with the idempotency key; another currency or a non-positive amount never calls', async () => {
    const t = transport(
      answer(
        'payments.disburse',
        { paymentId: 'pay-1', status: 'ACCEPTED', acceptedAt: 1_800_000_000 },
        { amount: '50000000', currency: 'AED', idempotencyKey: 'k-d', purposeCode: 'LOA' },
      ),
    );
    const d = {
      tenantId: 'sme-fund-ae',
      beneficiaryRef: 'ben-1',
      amount: money(50_000_000n, 'AED'),
      purposeCode: 'LOA',
      reference: 'disb-1',
      idempotencyKey: 'k-d',
      correlationId: 'c',
    };
    expect(expectOk(await bank(t).disburse(d))).toEqual({
      kind: 'ANSWERED',
      value: { instructionRef: 'pay-1', status: 'ACCEPTED', acceptedAtEpochSeconds: 1_800_000_000n },
    });
    const c = transport(
      answer(
        'payments.collect',
        { paymentId: 'col-1', status: 'RETURNED', acceptedAt: 1 },
        { idempotencyKey: 'k-c', currency: 'AED' },
      ),
    );
    const col = expectOk(
      await bank(c).collect({
        tenantId: 'sme-fund-ae',
        payerRef: 'p',
        amount: money(1_000_00n, 'AED'),
        reference: 'inst-1',
        idempotencyKey: 'k-c',
        correlationId: 'c',
      }),
    );
    expect(col.kind === 'ANSWERED' && col.value.status).toBe('RETURNED');
    const none = transport();
    const sar = await bank(none).disburse({ ...d, amount: money(1n, 'SAR') });
    expect(sar.ok).toBe(false);
    if (!sar.ok) expect(sar.error.reason).toBe('CURRENCY_MISMATCH');
    const zero = await bank(none).disburse({ ...d, amount: money(0n, 'AED') });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.reason).toBe('AMOUNT_NOT_POSITIVE');
    expect(none.calls).toHaveLength(0);
  });
});

describe('each UAE adapter declares its deviations against a verification item, and its capability', () => {
  it.each([
    ['AECB', AECB_DEVIATIONS, 'UAE-RAIL-AECB-01'],
    ['UAE Pass', UAE_PASS_DEVIATIONS, 'UAE-RAIL-UAEPASS-01'],
    ['ICP', ICP_DEVIATIONS, 'UAE-RAIL-ICP-01'],
    ['NER', NER_DEVIATIONS, 'UAE-RAIL-NER-01'],
    ['MOHRE', MOHRE_DEVIATIONS, 'UAE-RAIL-MOHRE-01'],
    ['FTA', FTA_DEVIATIONS, 'UAE-RAIL-FTA-01'],
    ['Partner bank', PARTNER_BANK_DEVIATIONS, 'UAE-RAIL-PARTNER-BANK-01'],
  ] as const)('%s', (_name, deviations, item) => {
    expect(deviations.length).toBeGreaterThan(0);
    for (const d of deviations) {
      expect(d.containment.length).toBeGreaterThan(0);
      expect(d.verificationRef).toBe(item);
    }
  });
  it('reads its credential under the capability it was configured for', async () => {
    const creds = new Credentials();
    const t = transport(answer('bureau.commercial', { reportId: 'r', subjectFound: false }));
    await new AecbAdapter(config('CREDIT_BUREAU'), creds, t, attest).request(bureauReq());
    expect(creds.refs[0]).toMatchObject({ tenantId: 'sme-fund-ae', provider: 'CREDIT_BUREAU', environment: 'sandbox' });
  });
});
