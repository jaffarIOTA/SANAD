/**
 * The KSA rail adapters against recorded fixtures.
 *
 * Three properties per rail: a good answer maps to the port's outcome; the
 * rail being down is `UNAVAILABLE`, never a throw and never an answer; and a
 * consent-gated rail refuses before any call when no consent is supplied.
 */
import { type KeyObject, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { FixtureTransport, type Fixture } from '../../adapters/kernel/fixture-transport.ts';
import { type RailEnvelope, TransportError } from '../../adapters/kernel/http-transport.ts';
import type { RailAdapterConfig } from '../../adapters/ksa/kernel/rail-adapter.ts';
import { decimalToMinor, isoToEpoch, minorToDecimal, own } from '../../adapters/ksa/kernel/rail-adapter.ts';
import { ruleCodes } from '../../adapters/ksa/zatca-einvoicing/adapter.ts';
import { NafathAdapter } from '../../adapters/ksa/nafath/adapter.ts';
import { YakeenAdapter } from '../../adapters/ksa/yakeen/adapter.ts';
import { TahaqoqAdapter } from '../../adapters/ksa/tahaqoq/adapter.ts';
import { SimahAdapter } from '../../adapters/ksa/simah/adapter.ts';
import { BayanAdapter } from '../../adapters/ksa/bayan/adapter.ts';
import { GosiAdapter } from '../../adapters/ksa/gosi/adapter.ts';
import { WathqAdapter } from '../../adapters/ksa/wathq/adapter.ts';
import { ZatcaTaxAdapter } from '../../adapters/ksa/zatca-tax/adapter.ts';
import { OpenBankingAdapter } from '../../adapters/ksa/open-banking/adapter.ts';
import { SadadAdapter } from '../../adapters/ksa/sadad/adapter.ts';
import { PaymentsHubAdapter } from '../../adapters/ksa/payments-hub/adapter.ts';
import { RatePublisherAdapter, percentToBp } from '../../adapters/ksa/rate-publisher/adapter.ts';
import { CommodityBrokerAdapter } from '../../adapters/ksa/commodity-broker/adapter.ts';
import { ZatcaEInvoicingAdapter } from '../../adapters/ksa/zatca-einvoicing/adapter.ts';
import type { EInvoicingProvider } from '../../core/ports/e-invoicing.ts';
import { type CredentialProvider, type CredentialRef, SecretValue } from '../../core/ports/credentials.ts';
import type { IdentityAuthenticationPort } from '../../core/ports/identity-authentication.ts';
import type { IdentityVerificationPort } from '../../core/ports/identity-verification.ts';
import type { DocumentVerificationPort } from '../../core/ports/document-verification.ts';
import type { CreditBureauPort } from '../../core/ports/credit-bureau.ts';
import type { EmploymentVerificationPort } from '../../core/ports/employment-verification.ts';
import type { BusinessRegistryPort } from '../../core/ports/business-registry.ts';
import type { TaxCompliancePort } from '../../core/ports/tax-compliance.ts';
import type { AccountInformationPort } from '../../core/ports/account-information.ts';
import type { PaymentInitiationPort } from '../../core/ports/payment-initiation.ts';
import type { BillCollectionPort } from '../../core/ports/bill-collection.ts';
import type { PaymentsPort } from '../../core/ports/payments.ts';
import type { RatePublisherPort } from '../../core/ports/rate-publisher.ts';
import type { CommodityBrokerPort } from '../../core/ports/commodity-broker.ts';
type OpenBankingPorts = AccountInformationPort & PaymentInitiationPort;
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { tsaInstant } from '../../core/time/tsa.ts';
import { grantingLedger } from '../support/consents.ts';
import { inMemoryAssertionReplayGuard } from '../../core/ports/assertion-replay.ts';

class Credentials implements CredentialProvider {
  async get(_ref: CredentialRef): Promise<SecretValue> {
    return new SecretValue('a-provider-credential-value');
  }
}
const config = (provider: RailAdapterConfig['provider']): RailAdapterConfig => ({
  tenantId: 'bank-a',
  provider,
  environment: 'sandbox',
  freshnessWindowSeconds: 0,
  failurePosture: 'FAIL_CLOSED',
  credentialTtlSeconds: 600,
  breaker: { failureThreshold: 2, resetAfterSeconds: 30, successThreshold: 1 },
  nowEpochSeconds: () => 1_800_000_000,
  baseUrl: 'https://rail.sandbox.example',
  consents: grantingLedger('bank-a'),
  assertionReplay: inMemoryAssertionReplayGuard(),
});
const at = tsaInstant({ verified: true, genTimeEpochSeconds: 1_800_000_000n, tokenDigest: 't', authorityId: 'test' });
const attest = () => Promise.resolve(at);
const down = (operation: string): Fixture => ({ operation, match: {}, response: {}, failsWith: 'ECONNRESET' });
const transport = (...f: Fixture[]) => new FixtureTransport(f);

describe('vendor decimals never become floats', () => {
  it.each([
    ['1234.56', 123_456n],
    ['0.1', 10n],
    ['7', 700n],
    ['-3.05', -305n],
  ])('%s → %s minor', (s, n) => expect(decimalToMinor(s)).toBe(n));
  it('refuses more than two decimals rather than rounding', () => {
    expect(decimalToMinor('1.234')).toBeUndefined();
    expect(percentToBp('7.255')).toBeUndefined();
    expect(percentToBp('7.25')).toBe(725n);
  });
  it.each([
    [123_456n, '1234.56'],
    [5n, '0.05'],
    [-305n, '-3.05'],
    [0n, '0.00'],
  ])('%s minor → "%s" for a rail that speaks decimals', (n, s) => {
    expect(minorToDecimal(n)).toBe(s);
    expect(decimalToMinor(s)).toBe(n);
  });
});

describe('kernel helpers', () => {
  it('own() finds only a table’s own keys', () => {
    const table = { ACTIVE: 'A' };
    for (const k of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'])
      expect(own(table, k)).toBeUndefined();
    expect(own(table, 'ACTIVE')).toBe('A');
    expect(own({ '1': 'one' }, 1)).toBe('one');
    expect(own(table, { toString: () => 'ACTIVE' })).toBeUndefined();
  });
  it('isoToEpoch() reads ISO dates and date-times, with offsets, and refuses anything else', () => {
    expect(isoToEpoch('2027-01-15')).toBe(1_799_971_200n);
    expect(isoToEpoch('2027-01-15T08:00:00Z')).toBe(1_800_000_000n);
    expect(isoToEpoch('2027-01-15T11:00:00+03:00')).toBe(1_800_000_000n);
    expect(isoToEpoch('2027-01-15T08:00:00.123Z')).toBe(1_800_000_000n);
    for (const bad of ['1448-07-15H', '15/01/2027', '2027-02-30', '2027-13-01', 1_800_000_000, ''])
      expect(isoToEpoch(bad)).toBeUndefined();
  });
});

describe('every rail: an unreachable rail is UNAVAILABLE, not an answer', () => {
  it('Nafath', async () => {
    const a = new NafathAdapter(
      config('IDENTITY_AUTHENTICATION'),
      new Credentials(),
      transport(down('identity.start')),
    ) as IdentityAuthenticationPort;
    expect(
      expectOk(
        await a.startAuthentication({ tenantId: 'bank-a', applicantRef: 'app', purpose: 'LOGIN', correlationId: 'c' }),
      ).kind,
    ).toBe('UNAVAILABLE');
  });
  it('SIMAH', async () => {
    const a = new SimahAdapter(
      config('CREDIT_BUREAU'),
      new Credentials(),
      transport(down('bureau.enquiry')),
      attest,
    ) as CreditBureauPort;
    expect(
      expectOk(
        await a.request({
          tenantId: 'bank-a',
          counterpartyId: 'cp',
          commercialRegistration: '1010000002',
          consentId: 'cns',
          correlationId: 'c',
        }),
      ).kind,
    ).toBe('UNAVAILABLE');
  });
  it('Payments hub', async () => {
    const a = new PaymentsHubAdapter(
      config('PAYMENTS_HUB'),
      new Credentials(),
      transport(down('payments.disburse')),
    ) as PaymentsPort;
    expect(
      expectOk(
        await a.disburse({
          tenantId: 'bank-a',
          beneficiaryRef: 'b',
          amount: money(1n),
          purposeCode: 'P',
          reference: 'r',
          idempotencyKey: 'k',
          correlationId: 'c',
        }),
      ).kind,
    ).toBe('UNAVAILABLE');
  });
  it('Rate publisher: an unavailable benchmark is a typed outcome the quotation refuses on', async () => {
    const a = new RatePublisherAdapter(
      config('RATE_PUBLISHER'),
      new Credentials(),
      transport(down('rates.benchmark')),
    ) as RatePublisherPort;
    expect(expectOk(await a.benchmark('SAIBOR-3M', at)).kind).toBe('UNAVAILABLE');
  });
});

describe('consent-gated rails refuse before any call', () => {
  it.each([
    [
      'Yakeen',
      async (t: FixtureTransport) =>
        (new YakeenAdapter(config('IDENTITY_VERIFICATION'), new Credentials(), t) as IdentityVerificationPort).verify({
          tenantId: 'bank-a',
          applicantRef: 'a',
          consentId: '',
          correlationId: 'c',
        }),
    ],
    [
      'Tahaqoq',
      async (t: FixtureTransport) =>
        (
          new TahaqoqAdapter(config('DOCUMENT_VERIFICATION'), new Credentials(), t) as DocumentVerificationPort
        ).verifyDocument({
          tenantId: 'bank-a',
          applicantRef: 'a',
          documentType: 'COMMERCIAL_REGISTRATION',
          documentRef: 'd',
          consentId: ' ',
          correlationId: 'c',
        }),
    ],
    [
      'GOSI',
      async (t: FixtureTransport) =>
        (
          new GosiAdapter(config('EMPLOYMENT_VERIFICATION'), new Credentials(), t) as EmploymentVerificationPort
        ).employment({ tenantId: 'bank-a', applicantRef: 'a', consentId: '', correlationId: 'c' }),
    ],
    [
      'Open Banking AIS',
      async (t: FixtureTransport) =>
        (new OpenBankingAdapter(config('OPEN_BANKING'), new Credentials(), t) as OpenBankingPorts).affordabilityFacts({
          tenantId: 'bank-a',
          applicantRef: 'a',
          consentId: '',
          months: 6,
          correlationId: 'c',
        }),
    ],
    [
      'Bayan',
      async (t: FixtureTransport) =>
        (new BayanAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest) as CreditBureauPort).request({
          tenantId: 'bank-a',
          counterpartyId: 'cp',
          commercialRegistration: '1010000002',
          consentId: '',
          correlationId: 'c',
        }),
    ],
  ])('%s', async (_name, call) => {
    const t = transport();
    const r = await call(t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('CONSENT_MISSING');
    expect(t.calls).toHaveLength(0);
  });
});

describe('answers map to the port, and identifiers do not cross', () => {
  const yakeen = (response: Record<string, unknown>) => {
    const t = transport({ operation: 'identity.verify', match: { applicantRef: 'app-1' }, response });
    return {
      t,
      verify: async () =>
        expectOk(
          await (
            new YakeenAdapter(config('IDENTITY_VERIFICATION'), new Credentials(), t) as IdentityVerificationPort
          ).verify({ tenantId: 'bank-a', applicantRef: 'app-1', consentId: 'cns-1', correlationId: 'c' }),
        ),
    };
  };
  it('Yakeen returns a match and its log id, never the SP014 attributes it was answered with', async () => {
    const { t, verify } = yakeen({
      logId: 4711,
      operation: 'CitizenInfo',
      personInfo: {
        firstName: 'SHOULD NOT CROSS',
        fatherName: 'SHOULD NOT CROSS',
        grandFatherName: 'SHOULD NOT CROSS',
        familyName: 'SHOULD NOT CROSS',
        englishFirstName: 'SHOULD NOT CROSS',
        gender: 'M',
        dateOfBirthH: '1405-03-12',
        dateOfBirthG: '1984-12-05',
        nationalityCode: 'SAU',
        idExpiryDateH: '1452-01-01',
      },
    });
    const r = await verify();
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { verified: true, verificationRef: '4711', verifiedAtEpochSeconds: 1_800_000_000n, mismatches: [] },
    });
    expect(JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
      'SHOULD NOT CROSS',
    );
    expect(t.calls[0]?.headers['authorization']).toMatch(/^Bearer /);
    expect(t.calls[0]?.url).toBe('https://rail.sandbox.example/yakeen/v1/person-info');
  });
  it('Yakeen: a date-of-birth error is a mismatch; an unknown error code, a missing attribute or a 404 is not a match', async () => {
    expect(await yakeen({ logId: 'L-2', error: { code: 'DATE_OF_BIRTH_MISMATCH', message: 'x' } }).verify()).toEqual({
      kind: 'ANSWERED',
      value: {
        verified: false,
        verificationRef: 'L-2',
        verifiedAtEpochSeconds: 1_800_000_000n,
        mismatches: ['dateOfBirth'],
      },
    });
    expect((await yakeen({ logId: 'L-3', error: { code: 'constructor' } }).verify()).kind).toBe('UNAVAILABLE');
    expect((await yakeen({ logId: 'L-4', personInfo: { firstName: 'x' } }).verify()).kind).toBe('UNAVAILABLE');
    expect((await yakeen({ personInfo: {} }).verify()).kind).toBe('UNAVAILABLE');
    const missing = new YakeenAdapter(config('IDENTITY_VERIFICATION'), new Credentials(), {
      call: () => Promise.reject(new TransportError('identity.verify', 404, 'no person')),
    }) as IdentityVerificationPort;
    expect(
      expectOk(await missing.verify({ tenantId: 'bank-a', applicantRef: 'a', consentId: 'cns', correlationId: 'c' })),
    ).toEqual({ kind: 'REFUSED', code: 'NOT_FOUND' });
  });
  it('SIMAH maps a report with decimal amounts to minor units and attests the retrieval', async () => {
    const t = transport({
      operation: 'bureau.enquiry',
      match: { product: 'SIMAT_COMMERCIAL_REPORT', consentReference: 'cns' },
      response: {
        reportId: 'e-1',
        product: 'SIMAT_COMMERCIAL_REPORT',
        subject: { found: true, subjectType: 'COMMERCIAL', crNumber: '1010000002' },
        score: { value: 712, model: 'MOLIM', reasonCodes: ['R1'] },
        facilities: [
          {
            facilityType: 'WORKING_CAPITAL',
            status: 'ACTIVE',
            creditLimit: '200000.00',
            outstandingBalance: '120000.00',
            overdueAmount: '0',
            daysPastDue: 0,
            currency: 'SAR',
            paymentHistory: '000000',
          },
          {
            facilityType: 'TERM_FINANCE',
            status: 'CLOSED',
            creditLimit: '50000.00',
            outstandingBalance: '0.00',
            overdueAmount: '0.00',
            daysPastDue: 0,
          },
        ],
        enquiries: [{ enquiryDate: '2026-05-01', memberType: 'BANK' }],
        defaults: [{ amount: '1500.50', settled: true, currency: 'SAR' }],
        judgments: [],
      },
    });
    const r = expectOk(
      await (new SimahAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest) as CreditBureauPort).request({
        tenantId: 'bank-a',
        counterpartyId: 'cp',
        commercialRegistration: '1010000002',
        consentId: 'cns',
        correlationId: 'c',
      }),
    );
    expect(r.kind).toBe('REPORT');
    if (r.kind === 'REPORT') {
      expect(r.summary.totalExposure.minorUnits).toBe(12_000_000n);
      expect(r.summary.activeFacilities).toBe(1);
      expect(r.summary.defaults[0]?.amount.minorUnits).toBe(150_050n);
      expect(r.summary.bureauScore).toBe(712);
      expect(r.summary.retrievedAt).toBe(at);
    }
    expect(t.calls[0]?.request['subject']).toEqual({ crNumber: '1010000002', memberReference: 'cp' });
  });
  it('SIMAH reporting returns the acknowledgement reference', async () => {
    const t = transport({
      operation: 'bureau.report',
      match: { facilityRef: 'f-1', idempotencyKey: 'k-1' },
      response: { acknowledgementId: 'ack-1' },
    });
    const r = expectOk(
      await (new SimahAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest) as CreditBureauPort).report({
        tenantId: 'bank-a',
        facilityRef: 'f-1',
        counterpartyId: 'cp',
        event: 'OPENED',
        amount: money(100n),
        asOfEpochSeconds: 1n,
        idempotencyKey: 'k-1',
        correlationId: 'c',
      }),
    );
    expect(r).toEqual({ kind: 'ACKNOWLEDGED', acknowledgementRef: 'ack-1' });
  });
  const wathqFullInfo = (extra: Record<string, unknown> = {}) => ({
    crNationalNumber: '7000000002',
    crNumber: '1010000002',
    name: 'شركة',
    entityType: { id: 2, name: 'شركة', formId: 201, formName: 'Limited Liability Company' },
    status: { id: 1, name: 'نشط' },
    issueDateGregorian: '2014-06-01',
    capital: { stockCapital: { paidAmount: '500000.00' } },
    activities: [{ id: '469000', name: 'Wholesale' }],
    parties: [{ name: 'p', identity: { id: 'SHOULD NOT CROSS', type: 'NATIONAL_ID' }, typeName: 'Partner' }],
    management: { managers: [{ name: 'm', identity: { id: 'SHOULD NOT CROSS', type: 'NATIONAL_ID' } }] },
    ...extra,
  });
  const wathq = (response: Record<string, unknown>) =>
    new WathqAdapter(
      config('BUSINESS_REGISTRY'),
      new Credentials(),
      transport({
        operation: 'registry.lookup',
        match: { url: 'https://rail.sandbox.example/v5/commercialregistration/fullinfo/1010000002' },
        response,
      }),
    ) as BusinessRegistryPort;
  const lookup = async (a: BusinessRegistryPort, cr = '1010000002') =>
    expectOk(await a.lookup({ tenantId: 'bank-a', commercialRegistration: cr, correlationId: 'c' }));
  it('Wathq maps fullinfo, drops party and manager identifiers, and keeps activity codes', async () => {
    const r = await lookup(wathq(wathqFullInfo()));
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: {
        commercialRegistration: '1010000002',
        legalNameAr: 'شركة',
        legalNameEn: 'شركة',
        legalForm: 'Limited Liability Company',
        status: 'ACTIVE',
        activityCodes: ['469000'],
        signatoryRefs: ['wathq:7000000002:manager:1'],
        lookupRef: 'wathq:7000000002:1800000000',
        retrievedAtEpochSeconds: 1_800_000_000n,
        paidCapitalMinorUnits: 50_000_000n,
        registeredAtGregorian: '2014-06-01',
      },
    });
    expect(JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
      'SHOULD NOT CROSS',
    );
  });
  it('Wathq refuses a malformed CR before calling, reports 404.2.1 as NOT_FOUND, and an unreachable registry as UNAVAILABLE', async () => {
    const a = wathq(wathqFullInfo());
    expect((await a.lookup({ tenantId: 'bank-a', commercialRegistration: '12', correlationId: 'c' })).ok).toBe(false);
    const missing = new WathqAdapter(config('BUSINESS_REGISTRY'), new Credentials(), {
      call: () => Promise.reject(new TransportError('registry.lookup', 404, '404.2.1')),
    }) as BusinessRegistryPort;
    expect(await lookup(missing)).toEqual({ kind: 'REFUSED', code: 'NOT_FOUND' });
    const down = new WathqAdapter(
      config('BUSINESS_REGISTRY'),
      new Credentials(),
      transport({ operation: 'registry.lookup', match: {}, response: {}, failsWith: 'x' }),
    ) as BusinessRegistryPort;
    expect((await lookup(down)).kind).toBe('UNAVAILABLE');
  });
  it.each([['constructor'], ['toString'], ['__proto__'], ['hasOwnProperty'], [9], ['ACTIVE']])(
    'Wathq: a status id of %s is not understood (own-key lookup), never a registration status',
    async (id) => {
      expect((await lookup(wathq(wathqFullInfo({ status: { id, name: 'x' } })))).kind).toBe('UNAVAILABLE');
    },
  );
  it('Wathq: the assumed status ids map, and an answer about another registration is not understood', async () => {
    const statusOf = async (id: number) => {
      const r = await lookup(wathq(wathqFullInfo({ status: { id } })));
      return r.kind === 'ANSWERED' ? r.value.status : r.kind;
    };
    expect(await statusOf(2)).toBe('SUSPENDED');
    expect(await statusOf(3)).toBe('CANCELLED');
    expect(await statusOf(4)).toBe('EXPIRED');
    expect((await lookup(wathq(wathqFullInfo({ crNationalNumber: '7000000009', crNumber: '1010000009' })))).kind).toBe(
      'UNAVAILABLE',
    );
    expect((await lookup(wathq(wathqFullInfo({ activities: [{ name: 'no id' }] })))).kind).toBe('UNAVAILABLE');
  });
  const zatca = (response: Record<string, unknown>) =>
    (
      new ZatcaTaxAdapter(
        config('TAX_COMPLIANCE'),
        new Credentials(),
        transport({ operation: 'tax.certificate', match: {}, response }),
      ) as TaxCompliancePort
    )
      .certificateStatus({ tenantId: 'bank-a', crNumber: '1010000002', correlationId: 'c' })
      .then(expectOk);
  it('ZATCA maps an unknown status to UNAVAILABLE, never VALID', async () => {
    expect((await zatca({ status: 'SOMETHING_NEW', certificateNumber: 'Z-1' })).kind).toBe('UNAVAILABLE');
  });
  it.each([['constructor'], ['toString'], ['__proto__'], ['valueOf']])(
    'ZATCA: a certificate status of %s is not understood (own-key lookup), never VALID',
    async (status) => {
      expect((await zatca({ status, certificateNumber: 'Z-1', expiryDate: '2099-01-01' })).kind).toBe('UNAVAILABLE');
    },
  );
  it('ZATCA maps the zakat certificate fields; a lapsed expiry date is EXPIRED and a 404 is NOT_FOUND', async () => {
    expect(
      await zatca({
        certificateNumber: 'ZC-1',
        certificateType: 'ZAKAT',
        status: 'VALID',
        issueDate: '2026-06-01',
        expiryDate: '2027-05-31',
        taxpayer: { crNumber: '1010000002' },
      }),
    ).toEqual({
      kind: 'ANSWERED',
      value: {
        status: 'VALID',
        retrievedAtEpochSeconds: 1_800_000_000n,
        certificateRef: 'ZC-1',
        validUntilEpochSeconds: 1_811_721_600n,
      },
    });
    const lapsed = await zatca({ certificateNumber: 'ZC-1', status: 'VALID', expiryDate: '2026-01-01' });
    expect(lapsed.kind === 'ANSWERED' && lapsed.value.status).toBe('EXPIRED');
    expect(
      (await zatca({ certificateNumber: 'ZC-1', status: 'VALID', taxpayer: { crNumber: '4030000202' } })).kind,
    ).toBe('UNAVAILABLE');
    const none = new ZatcaTaxAdapter(config('TAX_COMPLIANCE'), new Credentials(), {
      call: () => Promise.reject(new TransportError('tax.certificate', 404, 'none')),
    }) as TaxCompliancePort;
    expect(
      expectOk(await none.certificateStatus({ tenantId: 'bank-a', crNumber: '1010000002', correlationId: 'c' })),
    ).toEqual({ kind: 'ANSWERED', value: { status: 'NOT_FOUND', retrievedAtEpochSeconds: 1_800_000_000n } });
  });
  it('Rate publisher converts percent to basis points and carries the publication reference', async () => {
    const t = transport({
      operation: 'rates.benchmark',
      match: {},
      response: { ratePercent: '5.60', asOf: 1_800_000_000, publicationId: 'pub-9' },
    });
    const r = expectOk(
      await (new RatePublisherAdapter(config('RATE_PUBLISHER'), new Credentials(), t) as RatePublisherPort).benchmark(
        'SAIBOR-3M',
        at,
      ),
    );
    expect(r).toEqual({
      kind: 'PUBLISHED',
      value: {
        code: 'SAIBOR-3M',
        rate: { bp: 560n, basis: 'REDUCING', period: 'ANNUAL' },
        asOfEpochSeconds: 1_800_000_000n,
        referenceId: 'pub-9',
      },
    });
  });
  it('SADAD, Open Banking PIS and the broker carry the idempotency key to the rail', async () => {
    const sadad = transport({
      operation: 'bill.present',
      match: { idempotencyKey: 'k-s' },
      response: {
        BillDetails: { BillerID: '901', BillNumber: 'o' },
        Status: 'PRESENTED',
        PresentedDateTime: '2027-01-15T08:00:00Z',
      },
    });
    expect(
      expectOk(
        await (
          new SadadAdapter(config('BILL_COLLECTION'), new Credentials(), sadad, '901') as BillCollectionPort
        ).present({
          tenantId: 'bank-a',
          obligationRef: 'o',
          payerRef: 'p',
          amount: money(100n),
          dueDateGregorian: '2026-10-01',
          idempotencyKey: 'k-s',
          correlationId: 'c',
        }),
      ),
    ).toEqual({ kind: 'ANSWERED', value: { billRef: '901-o', presentedAtEpochSeconds: 1_800_000_000n } });
    expect(sadad.calls[0]?.request['BillDetails']).toEqual({ BillerID: '901', BillNumber: 'o' });
    expect(sadad.calls[0]?.request['Amount']).toEqual({ Amount: '1.00', Currency: 'SAR' });
    const ob = transport({
      operation: 'pis.initiate',
      match: { idempotencyKey: 'k-o' },
      response: { paymentId: 'p-1', status: 'INITIATED', initiatedAt: 1 },
    });
    expect(
      expectOk(
        await (new OpenBankingAdapter(config('OPEN_BANKING'), new Credentials(), ob) as OpenBankingPorts).initiate({
          tenantId: 'bank-a',
          applicantRef: 'a',
          consentId: 'cns',
          amount: money(100n),
          direction: 'COLLECT',
          reference: 'r',
          idempotencyKey: 'k-o',
          correlationId: 'c',
        }),
      ).kind,
    ).toBe('ANSWERED');
    const broker = transport({
      operation: 'commodity.purchase',
      match: { idempotencyKey: 'k-b' },
      response: { lotId: 'lot-1', quantity: '10', unit: 'MT', price: '50000.00', confirmedAt: 1 },
    });
    const lot = expectOk(
      await (
        new CommodityBrokerAdapter(config('COMMODITY_BROKER'), new Credentials(), broker) as CommodityBrokerPort
      ).purchase({
        tenantId: 'bank-a',
        brokerRef: 'br',
        commodityCode: 'LME-AL',
        amount: money(5_000_000n),
        idempotencyKey: 'k-b',
        correlationId: 'c',
      }),
    );
    expect(lot.kind).toBe('ANSWERED');
    if (lot.kind === 'ANSWERED') expect(lot.value.price.minorUnits).toBe(5_000_000n);
  });
  it('the circuit opens after repeated failures and reports UNAVAILABLE without calling', async () => {
    const t = transport(down('employment.status'));
    const a = new GosiAdapter(config('EMPLOYMENT_VERIFICATION'), new Credentials(), t) as EmploymentVerificationPort;
    const call = () => a.employment({ tenantId: 'bank-a', applicantRef: 'a', consentId: 'cns', correlationId: 'c' });
    await call();
    await call();
    const third = expectOk(await call());
    expect(third.kind).toBe('UNAVAILABLE');
    if (third.kind === 'UNAVAILABLE') expect(third.reason).toBe('circuit open');
    expect(t.calls).toHaveLength(2);
  });
});

describe('ZATCA e-invoicing', () => {
  // The authority's stamp key, pinned by the institution; and an impostor's (SR-016).
  const authority = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const impostor = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const einv = (t: FixtureTransport): EInvoicingProvider =>
    new ZatcaEInvoicingAdapter(config('E_INVOICING'), new Credentials(), t, { authorityKeys: [authority.publicKey] });
  const ref = { invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000001', invoiceHash: 'h' };
  /** A QR code: TLV tag 6 the hash, 7 the signature over it, 8 the signer's public key. */
  const qr = (hash: string, signer: KeyObject, claimedKey: KeyObject = signer): string => {
    const tlv = (tag: number, value: Uint8Array) => Buffer.concat([Buffer.from([tag, value.length]), value]);
    const signature = sign('sha256', Buffer.from(hash), { key: signer, dsaEncoding: 'der' });
    const pub = (claimedKey.type === 'public' ? claimedKey : createPublicKey(claimedKey)).export({
      format: 'der',
      type: 'spki',
    });
    return Buffer.concat([tlv(6, Buffer.from(hash)), tlv(7, signature), tlv(8, pub)]).toString('base64');
  };
  const PASS = { infoMessages: [], warningMessages: [], errorMessages: [], status: 'PASS' };
  /** A Fatoora answer: the published outcome fields, plus the decoded invoice content. */
  const fatoora = (top: Record<string, unknown>, invoice: Record<string, unknown> = {}) =>
    transport({
      operation: 'einvoice.lookup',
      match: {},
      response: {
        validationResults: PASS,
        ...top,
        invoice: {
          seller: { crNumber: '1010000002' },
          buyer: { crNumber: '7001000001' },
          taxInclusiveAmount: '1.00',
          issueDate: '2026-09-01',
          ...invoice,
        },
      },
    });
  const cleared = (qrCode: string | undefined, extra: Record<string, unknown> = {}) =>
    fatoora({ clearanceStatus: 'CLEARED', ...extra }, { ...(qrCode === undefined ? {} : { qrCode }), ...extra });
  const stampOf = async (t: FixtureTransport) => expectOk(await einv(t).validateInvoice('t', ref, 'c')).stampValid;

  it('SR-016: the stamp is verified from the QR code, never taken from a response flag', async () => {
    expect(await stampOf(cleared(qr('h', authority.privateKey, authority.publicKey)))).toBe(true);
    // A response that merely says so.
    expect(await stampOf(cleared(undefined, { stampValid: true }))).toBe(false);
    // Signed by someone else, presenting their own key, or claiming the authority's key.
    expect(await stampOf(cleared(qr('h', impostor.privateKey, impostor.publicKey)))).toBe(false);
    expect(await stampOf(cleared(qr('h', impostor.privateKey, authority.publicKey)))).toBe(false);
    // The authority's genuine stamp, but over another invoice.
    expect(await stampOf(cleared(qr('another', authority.privateKey, authority.publicKey)))).toBe(false);
    // Not a QR code at all.
    expect(await stampOf(cleared('AAEC'))).toBe(false);
    // No key pinned: nothing is ever valid.
    const unpinned = new ZatcaEInvoicingAdapter(
      config('E_INVOICING'),
      new Credentials(),
      cleared(qr('h', authority.privateKey)),
    );
    expect(expectOk(await unpinned.validateInvoice('t', ref, 'c')).stampValid).toBe(false);
  });

  it('maps a cleared invoice with its lines to minor units', async () => {
    const t = fatoora(
      { clearanceStatus: 'CLEARED', validationResults: { ...PASS, infoMessages: [{ code: 'XSD_ZATCA_VALID' }] } },
      {
        qrCode: qr('h', authority.privateKey),
        taxInclusiveAmount: '185000.00',
        invoiceLines: [
          {
            id: 1,
            lineExtensionAmount: '185000.00',
            itemClassificationCode: '2523',
            itemName: 'Cement',
            invoicedQuantity: '100',
            unitCode: 'T',
          },
        ],
      },
    );
    const v = expectOk(await einv(t).validateInvoice('t', ref, 'c'));
    expect(v.clearanceStatus).toBe('CLEARED');
    expect(v.stampValid).toBe(true);
    expect(v.issuerCr).toBe('1010000002');
    expect(v.totalAmount.minorUnits).toBe(18_500_000n);
    expect(v.lineItems[0]).toMatchObject({
      lineNo: 1,
      descriptionEn: 'Cement',
      goodsClassificationCode: '2523',
      unitOfMeasure: 'T',
    });
    expect(v.lineItems[0]?.lineAmount.minorUnits).toBe(18_500_000n);
  });
  it('maps the published Fatoora outcome: only CLEARED / REPORTED under PASS or WARNING with no error validates', async () => {
    const statusOf = async (top: Record<string, unknown>) =>
      expectOk(await einv(fatoora(top)).validateInvoice('t', ref, 'c')).clearanceStatus;
    expect(await statusOf({ clearanceStatus: 'CLEARED' })).toBe('CLEARED');
    expect(
      await statusOf({
        clearanceStatus: 'CLEARED',
        validationResults: { ...PASS, status: 'WARNING', warningMessages: [{ code: 'BR-KSA-08' }] },
      }),
    ).toBe('CLEARED');
    expect(await statusOf({ reportingStatus: 'REPORTED' })).toBe('REPORTED');
    expect(await statusOf({ reportingStatus: 'NOT_REPORTED' })).toBe('REJECTED');
    expect(
      await statusOf({
        clearanceStatus: 'NOT_CLEARED',
        validationResults: { ...PASS, status: 'ERROR', errorMessages: [{ code: 'BR-KSA-F-06' }] },
      }),
    ).toBe('REJECTED');
    // Contradictions and unknowns never validate.
    expect(
      await statusOf({
        clearanceStatus: 'CLEARED',
        validationResults: { ...PASS, errorMessages: [{ code: 'BR-KSA-F-06' }] },
      }),
    ).toBe('REJECTED');
    expect(await statusOf({ clearanceStatus: 'CLEARED', validationResults: { ...PASS, status: 'ERROR' } })).toBe(
      'REJECTED',
    );
    expect(await statusOf({ clearanceStatus: 'CLEARED', validationResults: { ...PASS, status: 'constructor' } })).toBe(
      'REJECTED',
    );
    expect(await statusOf({ clearanceStatus: 'CLEARED', validationResults: undefined })).toBe('REJECTED');
    expect(
      ruleCodes({
        validationResults: { errorMessages: [{ code: 'BR-KSA-F-06' }], warningMessages: [{ code: 'BR-KSA-08' }] },
      }),
    ).toEqual(['BR-KSA-F-06', 'BR-KSA-08']);
  });
  it('an unknown clearance status never validates, an unknown invoice is NOT_FOUND, and a down authority refuses', async () => {
    expect(
      expectOk(await einv(fatoora({ clearanceStatus: 'PENDING', stampValid: true })).validateInvoice('t', ref, 'c'))
        .clearanceStatus,
    ).toBe('REJECTED');
    const missing = new ZatcaEInvoicingAdapter(config('E_INVOICING'), new Credentials(), {
      call: () => Promise.reject(new TransportError('einvoice.lookup', 404, 'none')),
    });
    expect(expectOk(await missing.validateInvoice('t', ref, 'c')).clearanceStatus).toBe('NOT_FOUND');
    expect((await einv(transport(down('einvoice.lookup'))).validateInvoice('t', ref, 'c')).ok).toBe(false);
  });
  it('refuses an invoice with one unparseable line rather than rounding it', async () => {
    const t = fatoora(
      { clearanceStatus: 'CLEARED' },
      {
        taxInclusiveAmount: '10.00',
        invoiceLines: [{ id: 1, lineExtensionAmount: '3.333', itemClassificationCode: 'x' }],
      },
    );
    expect((await einv(t).validateInvoice('t', ref, 'c')).ok).toBe(false);
  });
});

/** A transport that answers one fixed body (or throws), recording the envelope it was given. */
const answering = (response: Record<string, unknown> | Error) => {
  const calls: { operation: string; envelope: RailEnvelope }[] = [];
  return {
    calls,
    call: (operation: string, envelope: RailEnvelope) => {
      calls.push({ operation, envelope });
      return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
    },
  };
};
const plain = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

describe('Nafath: the third-party published MFA flow', () => {
  const nafath = (response: Record<string, unknown> | Error) => {
    const t = answering(response);
    return {
      t,
      port: new NafathAdapter(config('IDENTITY_AUTHENTICATION'), new Credentials(), t) as IdentityAuthenticationPort,
    };
  };
  it('starts a transaction: transId and random become one reference, live for 200 seconds', async () => {
    const { t, port } = nafath({ transId: '4f1c-uuid', random: 42 });
    const r = expectOk(
      await port.startAuthentication({
        tenantId: 'bank-a',
        applicantRef: 'app',
        purpose: 'LOGIN',
        correlationId: 'c-1',
      }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { transactionRef: '4f1c-uuid:42', expiresAtEpochSeconds: 1_800_000_200n },
    });
    expect(t.calls[0]?.envelope.url).toBe('https://rail.sandbox.example/api/v1/mfa/request?local=ar&requestId=c-1');
    expect(t.calls[0]?.envelope.body).toEqual({ applicantRef: 'app', service: 'Login' });
    expect(
      expectOk(
        await nafath({ transId: 'x', random: 'not-a-number' }).port.startAuthentication({
          tenantId: 'bank-a',
          applicantRef: 'app',
          purpose: 'LOGIN',
          correlationId: 'c',
        }),
      ).kind,
    ).toBe('UNAVAILABLE');
  });
  it.each([
    ['WAITING', { kind: 'REFUSED', code: 'STATUS_WAITING' }],
    ['REJECTED', { kind: 'REFUSED', code: 'STATUS_REJECTED' }],
    ['EXPIRED', { kind: 'REFUSED', code: 'STATUS_EXPIRED' }],
    ['ERROR', { kind: 'REFUSED', code: 'STATUS_ERROR' }],
    ['constructor', { kind: 'UNAVAILABLE', reason: 'response malformed' }],
    ['SOMETHING_NEW', { kind: 'UNAVAILABLE', reason: 'response malformed' }],
  ])('a %s status is not an identity', async (status, expected) => {
    const { t, port } = nafath({ status, transId: 'tx' });
    expect(
      expectOk(await port.confirmAuthentication({ tenantId: 'bank-a', transactionRef: 'tx:42', correlationId: 'c' })),
    ).toEqual(expected);
    expect(t.calls[0]?.envelope.body).toEqual({ transId: 'tx', random: '42' });
  });
  it('a COMPLETED status is accepted for its own transaction only, and the identifier it carries does not cross', async () => {
    const { port } = nafath({ status: 'COMPLETED', transId: 'tx', iat: 1_800_000_000, nationalId: 'SHOULD NOT CROSS' });
    const r = expectOk(
      await port.confirmAuthentication({ tenantId: 'bank-a', transactionRef: 'tx:42', correlationId: 'c' }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { assertionId: 'tx', identityRef: 'nafath:tx', authenticatedAtEpochSeconds: 1_800_000_000n },
    });
    expect(plain(r)).not.toContain('SHOULD NOT CROSS');
    const other = nafath({ status: 'COMPLETED', transId: 'someone-else', iat: 1_800_000_000 }).port;
    expect(
      expectOk(await other.confirmAuthentication({ tenantId: 'bank-a', transactionRef: 'tx:42', correlationId: 'c' }))
        .kind,
    ).toBe('UNAVAILABLE');
    expect(
      (await port.confirmAuthentication({ tenantId: 'bank-a', transactionRef: 'no-random', correlationId: 'c' })).ok,
    ).toBe(false);
  });
});

describe('GOSI: the wage certificate', () => {
  const gosi = (response: Record<string, unknown> | Error) =>
    (
      new GosiAdapter(
        config('EMPLOYMENT_VERIFICATION'),
        new Credentials(),
        answering(response),
      ) as EmploymentVerificationPort
    )
      .employment({ tenantId: 'bank-a', applicantRef: 'a', consentId: 'cns', correlationId: 'c' })
      .then(expectOk);
  const employment = (extra: Record<string, unknown> = {}, wage: Record<string, unknown> = {}) => ({
    establishmentNumber: '50000101',
    establishmentName: 'Establishment',
    joiningDate: '2016-02-01',
    employmentStatus: 'ACTIVE',
    wage: { currency: 'SAR', basicWage: '10000.00', housingAllowance: '2500.00', otherAllowances: '500.00', ...wage },
    ...extra,
  });
  it('maps the active employment with the highest wage, and the contributor’s particulars do not cross', async () => {
    const r = await gosi({
      certificateNumber: 'G-1',
      issueDate: '2027-01-15',
      contributor: { name: 'SHOULD NOT CROSS', identity: 'SHOULD NOT CROSS' },
      employments: [
        employment({ establishmentNumber: '50000999', employmentStatus: 'INACTIVE' }, { basicWage: '90000.00' }),
        employment({}, { totalWage: '13000.00' }),
      ],
    });
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: {
        employed: true,
        retrievedAtEpochSeconds: 1_800_000_000n,
        referenceId: 'G-1',
        employerRef: 'gosi-establishment:50000101',
        registeredSalary: money(1_300_000n),
        employedSinceEpochSeconds: BigInt(Date.UTC(2016, 1, 1) / 1000),
      },
    });
    expect(plain(r)).not.toContain('SHOULD NOT CROSS');
  });
  it('sums basic, housing and other allowances where no total is given; no active employment is not employed', async () => {
    const r = await gosi({ certificateNumber: 'G-2', employments: [employment()] });
    expect(r.kind === 'ANSWERED' && r.value.registeredSalary?.minorUnits).toBe(1_300_000n);
    expect(
      await gosi({ certificateNumber: 'G-3', employments: [employment({ employmentStatus: 'INACTIVE' })] }),
    ).toEqual({
      kind: 'ANSWERED',
      value: { employed: false, retrievedAtEpochSeconds: 1_800_000_000n, referenceId: 'G-3' },
    });
  });
  it('one employment that does not read refuses the certificate; a 404 is NOT_FOUND', async () => {
    for (const bad of [
      employment({ employmentStatus: 'constructor' }),
      employment({}, { basicWage: '1.234' }),
      employment({}, { currency: 'USD' }),
      employment({}, { totalWage: 'twelve' }),
    ])
      expect((await gosi({ certificateNumber: 'G-4', employments: [employment(), bad] })).kind).toBe('UNAVAILABLE');
    expect(await gosi(new TransportError('employment.status', 404, 'none'))).toEqual({
      kind: 'REFUSED',
      code: 'NOT_FOUND',
    });
  });
});

describe('Bayan: its own mapping of the common bureau layout', () => {
  const facility = (extra: Record<string, unknown> = {}) => ({
    facilityType: 'TERM_FINANCE',
    status: 'ACTIVE',
    creditLimit: '500000.00',
    outstandingBalance: '250000.50',
    overdueAmount: '1200.00',
    daysPastDue: 35,
    currency: 'SAR',
    ...extra,
  });
  const reportOf = (extra: Record<string, unknown> = {}) => ({
    reportId: 'BY-1',
    subject: { found: true },
    score: { value: 640, reasonCodes: ['R7'] },
    facilities: [facility(), facility({ status: 'DELINQUENT', outstandingBalance: '10000.00', daysPastDue: 95 })],
    defaults: [{ amount: '5000.00', settled: false, currency: 'SAR' }],
    judgments: [{ caseType: 'X', amount: '1.00' }],
    ...extra,
  });
  const bayan = (response: Record<string, unknown> | Error) => {
    const t = answering(response);
    const port = new BayanAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest) as CreditBureauPort;
    const request = () =>
      port
        .request({
          tenantId: 'bank-a',
          counterpartyId: 'cp',
          commercialRegistration: '1010000002',
          consentId: 'cns',
          correlationId: 'c',
        })
        .then(expectOk);
    return { t, port, request };
  };
  it('maps exposure, overdue, worst delinquency, open facilities, the opaque score and defaults', async () => {
    const { t, request } = bayan(reportOf());
    const r = await request();
    expect(r).toEqual({
      kind: 'REPORT',
      summary: {
        bureauReference: 'BY-1',
        retrievedAt: at,
        totalExposure: money(26_000_050n),
        overdueAmount: money(240_000n),
        worstDelinquencyDays: 95,
        activeFacilities: 2,
        bureauScore: 640,
        defaults: [{ amount: money(500_000n), settled: false }],
      },
    });
    expect(t.calls[0]?.envelope.url).toBe('https://rail.sandbox.example/v1/credit-reports');
    expect(t.calls[0]?.envelope.body?.['product']).toBe('COMMERCIAL_CREDIT_REPORT');
  });
  it('a subject with no file is NO_RECORD; a report without a score maps without one', async () => {
    expect(await bayan({ reportId: 'BY-2', subject: { found: false } }).request()).toEqual({
      kind: 'NO_RECORD',
      bureauReference: 'BY-2',
    });
    const r = await bayan(reportOf({ score: undefined })).request();
    expect(r.kind === 'REPORT' && 'bureauScore' in r.summary).toBe(false);
  });
  it.each([
    ['a default without an amount', { defaults: [{ settled: true }] }],
    ['a default with a fractional JSON number', { defaults: [{ amount: 12.5, settled: true }] }],
    ['a default without its settled flag', { defaults: [{ amount: '1.00' }] }],
    ['a facility status of constructor', { facilities: [facility({ status: 'constructor' })] }],
    ['a facility in another currency', { facilities: [facility({ currency: 'USD' })] }],
    ['a facility with negative days past due', { facilities: [facility({ daysPastDue: -1 })] }],
    ['a score that is not an integer', { score: { value: '6.5' } }],
    ['no subject block', { subject: undefined }],
  ])('%s makes the report UNAVAILABLE, never a report without that line', async (_name, extra) => {
    expect((await bayan(reportOf(extra)).request()).kind).toBe('UNAVAILABLE');
  });
  it('reports a facility event as a decimal amount and returns the acknowledgement', async () => {
    const { t, port } = bayan({ acknowledgementId: 'ack-b' });
    expect(
      expectOk(
        await port.report({
          tenantId: 'bank-a',
          facilityRef: 'f-1',
          counterpartyId: 'cp',
          event: 'OPENED',
          amount: money(1_000_050n),
          asOfEpochSeconds: 1n,
          idempotencyKey: 'k-1',
          correlationId: 'c',
        }),
      ),
    ).toEqual({ kind: 'ACKNOWLEDGED', acknowledgementRef: 'ack-b' });
    expect(t.calls[0]?.envelope.body).toMatchObject({ amount: '10000.50', currency: 'SAR', idempotencyKey: 'k-1' });
  });
});

describe('Payments hub: ISO 20022 statuses and the riyal guard', () => {
  const hub = (response: Record<string, unknown> | Error) => {
    const t = answering(response);
    return { t, port: new PaymentsHubAdapter(config('PAYMENTS_HUB'), new Credentials(), t) as PaymentsPort };
  };
  const disburse = (port: PaymentsPort, amount = money(100_000n)) =>
    port
      .disburse({
        tenantId: 'bank-a',
        beneficiaryRef: 'b',
        amount,
        purposeCode: 'P',
        reference: 'e2e-1',
        idempotencyKey: 'k-1',
        correlationId: 'c',
      })
      .then((r) => r);
  const collect = (port: PaymentsPort) =>
    port
      .collect({
        tenantId: 'bank-a',
        payerRef: 'p',
        amount: money(100_000n),
        reference: 'e2e-1',
        idempotencyKey: 'k-1',
        correlationId: 'c',
      })
      .then(expectOk);
  const pacs002 = (TxSts: unknown, extra: Record<string, unknown> = {}) => ({
    OrgnlEndToEndId: 'e2e-1',
    TxId: 'HUB-1',
    TxSts,
    AccptncDtTm: '2027-01-15T08:00:00Z',
    ...extra,
  });
  it.each([
    [money(100n, 'AED'), 'CURRENCY_MISMATCH'],
    [money(0n), 'AMOUNT_NOT_POSITIVE'],
    [money(-100n), 'AMOUNT_NOT_POSITIVE'],
  ])('refuses %o before any call (%s)', async (amount, reason) => {
    const { t, port } = hub(pacs002('ACSC'));
    const r = await disburse(port, amount);
    expect(!r.ok && r.error.reason).toBe(reason);
    expect(t.calls).toHaveLength(0);
    const c = await port.collect({
      tenantId: 'bank-a',
      payerRef: 'p',
      amount,
      reference: 'r',
      idempotencyKey: 'k',
      correlationId: 'c',
    });
    expect(!c.ok && c.error.reason).toBe(reason);
    expect(t.calls).toHaveLength(0);
  });
  it.each([
    ['ACSC', 'SETTLED'],
    ['ACSP', 'ACCEPTED'],
    ['ACCP', 'ACCEPTED'],
    ['PDNG', 'ACCEPTED'],
    ['RJCT', 'REJECTED'],
  ])('maps TxSts %s to %s', async (code, status) => {
    const { t, port } = hub(pacs002(code, code === 'RJCT' ? { StsRsnInf: { Rsn: { Cd: 'AC04' } } } : {}));
    expect(expectOk(await disburse(port))).toEqual({
      kind: 'ANSWERED',
      value: { instructionRef: 'HUB-1', status, acceptedAtEpochSeconds: 1_800_000_000n },
    });
    expect(t.calls[0]?.envelope.body).toMatchObject({
      EndToEndId: 'e2e-1',
      InstrId: 'k-1',
      IntrBkSttlmAmt: { Amount: '1000.00', Ccy: 'SAR' },
      Purp: { Cd: 'P' },
    });
  });
  it('a collection with return information is RETURNED; unknown statuses and foreign end-to-end ids are not understood', async () => {
    expect((await collect(hub(pacs002('ACSC', { RtrInf: { Rsn: { Cd: 'MD06' } } })).port)).kind === 'ANSWERED').toBe(
      true,
    );
    const returned = await collect(hub(pacs002('ACSC', { RtrInf: { Rsn: { Cd: 'MD06' } } })).port);
    expect(returned.kind === 'ANSWERED' && returned.value.status).toBe('RETURNED');
    for (const bad of [pacs002('constructor'), pacs002('XXXX'), pacs002('ACSC', { OrgnlEndToEndId: 'someone-else' })])
      expect((await collect(hub(bad).port)).kind).toBe('UNAVAILABLE');
    expect(expectOk(await disburse(hub(pacs002('ACSC', { RtrInf: {} })).port)).kind).toBe('UNAVAILABLE');
  });
});

describe('SADAD: present and reconcile under the institution’s biller id', () => {
  const sadad = (response: Record<string, unknown> | Error, billerId = '901') => {
    const t = answering(response);
    return {
      t,
      port: new SadadAdapter(config('BILL_COLLECTION'), new Credentials(), t, billerId) as BillCollectionPort,
    };
  };
  const bill = (n: string, status: string, extra: Record<string, unknown> = {}) => ({
    BillDetails: { BillerID: '901', BillNumber: n },
    Status: status,
    PaidAmount: { Amount: '3100.00', Currency: 'SAR' },
    PaymentDateTime: '2027-01-15T08:00:00Z',
    SadadPaymentId: `SP-${n}`,
    ...extra,
  });
  const paid = (port: BillCollectionPort) =>
    port.paid({ tenantId: 'bank-a', sinceEpochSeconds: 1_799_000_000n, correlationId: 'c' }).then(expectOk);
  it('reconciles paid and settled bills, skipping bills only presented', async () => {
    const { t, port } = sadad({
      Data: {
        Bill: [
          bill('1', 'SETTLED', { SettlementReference: 'ST-1' }),
          bill('2', 'PAID'),
          bill('3', 'PRESENTED', { PaidAmount: undefined }),
        ],
      },
    });
    expect(await paid(port)).toEqual({
      kind: 'ANSWERED',
      value: [
        { billRef: '901-1', amount: money(310_000n), paidAtEpochSeconds: 1_800_000_000n, settlementRef: 'ST-1' },
        { billRef: '901-2', amount: money(310_000n), paidAtEpochSeconds: 1_800_000_000n, settlementRef: 'SP-2' },
      ],
    });
    expect(t.calls[0]?.envelope.url).toBe(
      'https://rail.sandbox.example/v1/bills/reconciliation?fromDateTime=2027-01-03T18%3A13%3A20.000Z',
    );
  });
  it.each([
    ['an unknown status', bill('1', 'constructor')],
    ['another biller’s bill', bill('1', 'PAID', { BillDetails: { BillerID: '902', BillNumber: '1' } })],
    ['an amount in another currency', bill('1', 'PAID', { PaidAmount: { Amount: '1.00', Currency: 'USD' } })],
    ['no payment reference', bill('1', 'PAID', { SadadPaymentId: undefined })],
  ])('one line with %s refuses the whole batch rather than dropping a payment', async (_n, line) => {
    expect((await paid(sadad({ Data: { Bill: [bill('2', 'PAID'), line] } }).port)).kind).toBe('UNAVAILABLE');
  });
  it('presents only riyals, only under a configured biller id', async () => {
    const present = (port: BillCollectionPort, amount = money(100n)) =>
      port.present({
        tenantId: 'bank-a',
        obligationRef: 'o',
        payerRef: 'p',
        amount,
        dueDateGregorian: '2027-02-01',
        idempotencyKey: 'k',
        correlationId: 'c',
      });
    const ok1 = sadad({});
    const r = await present(ok1.port, money(100n, 'AED'));
    expect(!r.ok && r.error.reason).toBe('CURRENCY_MISMATCH');
    const unconfigured = sadad({}, '');
    const u = await present(unconfigured.port);
    expect(!u.ok && u.error.reason).toBe('BILLER_NOT_CONFIGURED');
    expect(ok1.t.calls.length + unconfigured.t.calls.length).toBe(0);
    const refused = sadad({
      BillDetails: { BillerID: '901', BillNumber: 'o' },
      Status: 'REJECTED',
      PresentedDateTime: '2027-01-15T08:00:00Z',
    });
    expect(expectOk(await present(refused.port))).toEqual({ kind: 'REFUSED', code: 'NOT_PRESENTED' });
  });
});

describe('Open Banking AIS: affordability derived from the SAMA framework’s accounts, balances and transactions', () => {
  const BASE = 'https://rail.sandbox.example/open-banking/account-information/2022.11.01-final-errata2';
  const amount = (a: string, cur = 'SAR') => ({ Amount: a, Currency: cur });
  const tx = (date: string, credit: boolean, a: string, extra: Record<string, unknown> = {}) => ({
    AccountId: 'A1',
    TransactionId: `${date}-${a}`,
    TransactionType: 'KSAOB.LocalBankTransfer',
    CreditDebitIndicator: credit ? 'KSAOB.Credit' : 'KSAOB.Debit',
    Status: 'KSAOB.Booked',
    BookingDateTime: `${date}T09:00:00+03:00`,
    Amount: amount(a),
    ...extra,
  });
  const PAGE_1 = [
    tx('2026-08-20', false, '1500.00', { Status: 'KSAOB.Rejected' }),
    tx('2026-10-27', true, '10000.00', { Flags: ['KSAOB.Payroll'] }),
    tx('2026-11-01', false, '8000.00'),
    tx('2026-11-15', true, '500.00', { Status: 'KSAOB.Pending' }),
    tx('2026-11-27', true, '10000.00', { Flags: ['KSAOB.Payroll'] }),
  ];
  const PAGE_2 = [
    tx('2026-12-01', false, '8000.00', { Flags: ['KSAOB.Loan'] }),
    tx('2026-12-05', true, '2000.00'),
    tx('2026-12-20', false, '1500.00', { Status: 'KSAOB.Rejected' }),
    tx('2026-12-27', true, '10000.00', { Flags: ['KSAOB.Payroll'] }),
    tx('2027-01-02', false, '1000.00'),
  ];
  const fixtures = (
    page2: readonly unknown[] = PAGE_2,
    next = `${BASE}/accounts/A1/transactions?page=2`,
  ): Fixture[] => [
    {
      operation: 'ais.accounts',
      match: { url: `${BASE}/accounts` },
      response: {
        Data: {
          Account: [
            { AccountId: 'A1', Currency: 'SAR' },
            { AccountId: 'U1', Currency: 'USD' },
          ],
        },
        Links: { Self: `${BASE}/accounts` },
        Meta: { TotalPages: 1 },
      },
    },
    {
      operation: 'ais.balances',
      match: { url: `${BASE}/accounts/A1/balances` },
      response: {
        Data: {
          Balance: [
            { Type: 'KSAOB.InterimAvailable', CreditDebitIndicator: 'KSAOB.Credit', Amount: amount('999.00') },
            { Type: 'KSAOB.InterimBooked', CreditDebitIndicator: 'KSAOB.Credit', Amount: amount('5500.00') },
          ],
        },
      },
    },
    {
      operation: 'ais.transactions',
      match: { url: /page=2$/ },
      response: { Data: { Transaction: page2 }, Links: {}, Meta: { TotalPages: 2 } },
    },
    {
      operation: 'ais.transactions',
      match: {
        url: /\/accounts\/A1\/transactions\?fromBookingDateTime=2026-07-01T00%3A00%3A00.000Z&toBookingDateTime=/,
      },
      response: { Data: { Transaction: PAGE_1 }, Links: { Next: next }, Meta: { TotalPages: 2 } },
    },
  ];
  const ais = (t: FixtureTransport, months = 3) =>
    (new OpenBankingAdapter(config('OPEN_BANKING'), new Credentials(), t) as OpenBankingPorts)
      .affordabilityFacts({ tenantId: 'bank-a', applicantRef: 'app-1', consentId: 'cns', months, correlationId: 'c' })
      .then((r) => r);

  it('derives the four facts across pages, leaving out the dollar account, pending lines and the current month', async () => {
    const t = transport(...fixtures());
    expect(expectOk(await ais(t))).toEqual({
      kind: 'ANSWERED',
      value: {
        // Oct–Dec booked credits 32,000.00 over three months.
        averageMonthlyInflow: money(1_066_666n),
        // 5,500 now; end-Dec 6,500, end-Nov 2,500, end-Oct 500.
        lowestMonthEndBalance: money(50_000n),
        returnedPaymentsLast6Months: 2,
        salaryCreditsObserved: 3,
        retrievedAtEpochSeconds: 1_800_000_000n,
        referenceId: 'ob-ais:cns:1800000000',
      },
    });
    expect(t.calls.map((c) => c.operation)).toEqual([
      'ais.accounts',
      'ais.balances',
      'ais.transactions',
      'ais.transactions',
    ]);
    expect(t.calls.every((c) => c.headers['x-sanad-applicant-ref'] === 'app-1' && c.method === 'GET')).toBe(true);
    expect(t.calls.some((c) => c.url?.includes('U1') === true)).toBe(false);
  });
  it('follows no next link outside the configured rail', async () => {
    expect(expectOk(await ais(transport(...fixtures(PAGE_2, 'https://elsewhere.example/steal?page=2')))).kind).toBe(
      'UNAVAILABLE',
    );
  });
  it.each([
    ['an amount in another currency', tx('2026-12-02', true, '1.00', { Amount: amount('1.00', 'USD') })],
    ['an amount as a JSON number', tx('2026-12-02', true, '1.00', { Amount: { Amount: 1.5, Currency: 'SAR' } })],
    ['an unknown indicator', tx('2026-12-02', true, '1.00', { CreditDebitIndicator: 'constructor' })],
    ['an unknown status', tx('2026-12-02', true, '1.00', { Status: 'KSAOB.Unknown' })],
    ['a booking date that is not ISO', tx('2026-12-02', true, '1.00', { BookingDateTime: '02/12/2026' })],
  ])('one line with %s is not understood, not skipped', async (_n, bad) => {
    expect(expectOk(await ais(transport(...fixtures([...PAGE_2, bad])))).kind).toBe('UNAVAILABLE');
  });
  it('refuses a window outside one to twenty-four months before any call', async () => {
    const t = transport(...fixtures());
    expect((await ais(t, 0)).ok).toBe(false);
    expect((await ais(t, 25)).ok).toBe(false);
    expect(t.calls).toHaveLength(0);
  });
});
