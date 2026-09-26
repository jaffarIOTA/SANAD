/**
 * The KSA rail adapters against recorded fixtures.
 *
 * Three properties per rail: a good answer maps to the port's outcome; the
 * rail being down is `UNAVAILABLE`, never a throw and never an answer; and a
 * consent-gated rail refuses before any call when no consent is supplied.
 */
import { describe, expect, it } from 'vitest';

import { FixtureTransport, type Fixture } from '../../adapters/kernel/fixture-transport.ts';
import type { RailAdapterConfig } from '../../adapters/ksa/kernel/rail-adapter.ts';
import { decimalToMinor } from '../../adapters/ksa/kernel/rail-adapter.ts';
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
import { type CredentialProvider, type CredentialRef, SecretValue } from '../../core/ports/credentials.ts';
import type { IdentityAuthenticationPort } from '../../core/ports/identity-authentication.ts';
import type { IdentityVerificationPort } from '../../core/ports/identity-verification.ts';
import type { DocumentVerificationPort } from '../../core/ports/document-verification.ts';
import type { CreditBureauPort } from '../../core/ports/credit-bureau.ts';
import type { EmploymentVerificationPort } from '../../core/ports/employment-verification.ts';
import type { CounterpartyRegistryPort } from '../../core/ports/counterparty-registry.ts';
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

class Credentials implements CredentialProvider {
  async get(_ref: CredentialRef): Promise<SecretValue> { return new SecretValue('a-provider-credential-value'); }
}
const config = (provider: RailAdapterConfig['provider']): RailAdapterConfig => ({
  tenantId: 'bank-a', provider, environment: 'sandbox', freshnessWindowSeconds: 0, failurePosture: 'FAIL_CLOSED', credentialTtlSeconds: 600,
  breaker: { failureThreshold: 2, resetAfterSeconds: 30, successThreshold: 1 }, nowEpochSeconds: () => 1_800_000_000, baseUrl: 'https://rail.sandbox.example',
});
const at = tsaInstant({ verified: true, genTimeEpochSeconds: 1_800_000_000n, tokenDigest: 't', authorityId: 'test' });
const attest = () => Promise.resolve(at);
const down = (operation: string): Fixture => ({ operation, match: {}, response: {}, failsWith: 'ECONNRESET' });
const transport = (...f: Fixture[]) => new FixtureTransport(f);

describe('vendor decimals never become floats', () => {
  it.each([['1234.56', 123_456n], ['0.1', 10n], ['7', 700n], ['-3.05', -305n]])('%s → %s minor', (s, n) => expect(decimalToMinor(s)).toBe(n));
  it('refuses more than two decimals rather than rounding', () => { expect(decimalToMinor('1.234')).toBeUndefined(); expect(percentToBp('7.255')).toBeUndefined(); expect(percentToBp('7.25')).toBe(725n); });
});

describe('every rail: an unreachable rail is UNAVAILABLE, not an answer', () => {
  it('Nafath', async () => {
    const a = (new NafathAdapter(config('IDENTITY_AUTHENTICATION'), new Credentials(), transport(down('identity.start'))) as IdentityAuthenticationPort);
    expect(expectOk(await a.startAuthentication({ tenantId: 't', applicantRef: 'app', purpose: 'LOGIN', correlationId: 'c' })).kind).toBe('UNAVAILABLE');
  });
  it('SIMAH', async () => {
    const a = (new SimahAdapter(config('CREDIT_BUREAU'), new Credentials(), transport(down('bureau.enquiry')), attest) as CreditBureauPort);
    expect(expectOk(await a.request({ tenantId: 't', counterpartyId: 'cp', commercialRegistration: '1010000002', consentId: 'cns', correlationId: 'c' })).kind).toBe('UNAVAILABLE');
  });
  it('Payments hub', async () => {
    const a = (new PaymentsHubAdapter(config('PAYMENTS_HUB'), new Credentials(), transport(down('payments.disburse'))) as PaymentsPort);
    expect(expectOk(await a.disburse({ tenantId: 't', beneficiaryRef: 'b', amount: money(1n), purposeCode: 'P', reference: 'r', idempotencyKey: 'k', correlationId: 'c' })).kind).toBe('UNAVAILABLE');
  });
  it('Rate publisher: an unavailable benchmark is a typed outcome the quotation refuses on', async () => {
    const a = (new RatePublisherAdapter(config('RATE_PUBLISHER'), new Credentials(), transport(down('rates.benchmark'))) as RatePublisherPort);
    expect(expectOk(await a.benchmark('SAIBOR-3M', at)).kind).toBe('UNAVAILABLE');
  });
});

describe('consent-gated rails refuse before any call', () => {
  it.each([
    ['Yakeen', async (t: FixtureTransport) => (new YakeenAdapter(config('IDENTITY_VERIFICATION'), new Credentials(), t) as IdentityVerificationPort).verify({ tenantId: 't', applicantRef: 'a', consentId: '', correlationId: 'c' })],
    ['Tahaqoq', async (t: FixtureTransport) => (new TahaqoqAdapter(config('DOCUMENT_VERIFICATION'), new Credentials(), t) as DocumentVerificationPort).verifyDocument({ tenantId: 't', applicantRef: 'a', documentType: 'COMMERCIAL_REGISTRATION', documentRef: 'd', consentId: ' ', correlationId: 'c' })],
    ['GOSI', async (t: FixtureTransport) => (new GosiAdapter(config('EMPLOYMENT_VERIFICATION'), new Credentials(), t) as EmploymentVerificationPort).employment({ tenantId: 't', applicantRef: 'a', consentId: '', correlationId: 'c' })],
    ['Open Banking AIS', async (t: FixtureTransport) => (new OpenBankingAdapter(config('OPEN_BANKING'), new Credentials(), t) as OpenBankingPorts).affordabilityFacts({ tenantId: 't', applicantRef: 'a', consentId: '', months: 6, correlationId: 'c' })],
    ['Bayan', async (t: FixtureTransport) => (new BayanAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest) as CreditBureauPort).request({ tenantId: 't', counterpartyId: 'cp', commercialRegistration: '1010000002', consentId: '', correlationId: 'c' })],
  ])('%s', async (_name, call) => {
    const t = transport();
    const r = await call(t);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('CONSENT_MISSING');
    expect(t.calls).toHaveLength(0);
  });
});

describe('answers map to the port, and identifiers do not cross', () => {
  it('Yakeen returns the match and the mismatched field names, never the attributes', async () => {
    const t = transport({ operation: 'identity.verify', match: { applicantRef: 'app-1' }, response: { matched: false, verificationId: 'v-1', verifiedAt: 1_800_000_100, mismatchedFields: ['address'], fullName: 'SHOULD NOT CROSS', dateOfBirth: '1990-01-01' } });
    const r = expectOk(await (new YakeenAdapter(config('IDENTITY_VERIFICATION'), new Credentials(), t) as IdentityVerificationPort).verify({ tenantId: 't', applicantRef: 'app-1', consentId: 'cns-1', correlationId: 'c' }));
    expect(r).toEqual({ kind: 'ANSWERED', value: { verified: false, verificationRef: 'v-1', verifiedAtEpochSeconds: 1_800_000_100n, mismatches: ['address'] } });
    expect(JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('SHOULD NOT CROSS');
    expect(t.calls[0]?.headers['authorization']).toMatch(/^Bearer /);
  });
  it('SIMAH maps a report with decimal amounts to minor units and attests the retrieval', async () => {
    const t = transport({ operation: 'bureau.enquiry', match: { subjectCr: '1010000002' }, response: { enquiryId: 'e-1', found: true, totalExposure: '120000.00', overdueAmount: '0', worstDelinquencyDays: 0, activeFacilities: 2, score: 712, defaults: [{ amount: '1500.50', settled: true }] } });
    const r = expectOk(await (new SimahAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest) as CreditBureauPort).request({ tenantId: 't', counterpartyId: 'cp', commercialRegistration: '1010000002', consentId: 'cns', correlationId: 'c' }));
    expect(r.kind).toBe('REPORT'); if (r.kind === 'REPORT') { expect(r.summary.totalExposure.minorUnits).toBe(12_000_000n); expect(r.summary.defaults[0]?.amount.minorUnits).toBe(150_050n); expect(r.summary.bureauScore).toBe(712); expect(r.summary.retrievedAt).toBe(at); }
  });
  it('SIMAH reporting returns the acknowledgement reference', async () => {
    const t = transport({ operation: 'bureau.report', match: { facilityRef: 'f-1', idempotencyKey: 'k-1' }, response: { acknowledgementId: 'ack-1' } });
    const r = expectOk(await (new SimahAdapter(config('CREDIT_BUREAU'), new Credentials(), t, attest) as CreditBureauPort).report({ tenantId: 't', facilityRef: 'f-1', counterpartyId: 'cp', event: 'OPENED', amount: money(100n), asOfEpochSeconds: 1n, idempotencyKey: 'k-1', correlationId: 'c' }));
    expect(r).toEqual({ kind: 'ACKNOWLEDGED', acknowledgementRef: 'ack-1' });
  });
  it('Wathq drops signatory identifiers and treats 404 as unknown', async () => {
    const t = transport({ operation: 'registry.lookup', match: { url: 'https://rail.sandbox.example/v1/commercial-registrations/1010000002' }, response: { nameAr: 'شركة', nameEn: 'Co', legalForm: 'LLC', status: 'ACTIVE', activityClass: 'G46', signatories: [{ ref: 'sig-1', nationalId: 'SHOULD NOT CROSS' }] } });
    const a = (new WathqAdapter(config('BUSINESS_REGISTRY'), new Credentials(), t) as CounterpartyRegistryPort);
    const p = expectOk(await a.findByRegistration('t', '1010000002'));
    expect(p?.signatoryRefs).toEqual(['sig-1']); expect(JSON.stringify(p, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('SHOULD NOT CROSS');
    expect(await a.findByRegistration('t', '12').then((r) => r.ok)).toBe(false);
    expect((await a.get('t', 'cpt-1')).ok).toBe(false);
  });
  it('ZATCA maps an unknown status to UNAVAILABLE, never VALID', async () => {
    const t = transport({ operation: 'tax.certificate', match: {}, response: { status: 'SOMETHING_NEW', asOf: 1 } });
    expect(expectOk(await (new ZatcaTaxAdapter(config('TAX_COMPLIANCE'), new Credentials(), t) as TaxCompliancePort).certificateStatus({ tenantId: 't', crNumber: '1010000002', correlationId: 'c' })).kind).toBe('UNAVAILABLE');
  });
  it('Rate publisher converts percent to basis points and carries the publication reference', async () => {
    const t = transport({ operation: 'rates.benchmark', match: {}, response: { ratePercent: '5.60', asOf: 1_800_000_000, publicationId: 'pub-9' } });
    const r = expectOk(await (new RatePublisherAdapter(config('RATE_PUBLISHER'), new Credentials(), t) as RatePublisherPort).benchmark('SAIBOR-3M', at));
    expect(r).toEqual({ kind: 'PUBLISHED', value: { code: 'SAIBOR-3M', rate: { bp: 560n, basis: 'REDUCING', period: 'ANNUAL' }, asOfEpochSeconds: 1_800_000_000n, referenceId: 'pub-9' } });
  });
  it('SADAD, Open Banking PIS and the broker carry the idempotency key to the rail', async () => {
    const sadad = transport({ operation: 'bill.present', match: { idempotencyKey: 'k-s' }, response: { billId: 'b-1', presentedAt: 1 } });
    expect(expectOk(await (new SadadAdapter(config('BILL_COLLECTION'), new Credentials(), sadad) as BillCollectionPort).present({ tenantId: 't', obligationRef: 'o', payerRef: 'p', amount: money(100n), dueDateGregorian: '2026-10-01', idempotencyKey: 'k-s', correlationId: 'c' })).kind).toBe('ANSWERED');
    const ob = transport({ operation: 'pis.initiate', match: { idempotencyKey: 'k-o' }, response: { paymentId: 'p-1', status: 'INITIATED', initiatedAt: 1 } });
    expect(expectOk(await (new OpenBankingAdapter(config('OPEN_BANKING'), new Credentials(), ob) as OpenBankingPorts).initiate({ tenantId: 't', applicantRef: 'a', consentId: 'cns', amount: money(100n), direction: 'COLLECT', reference: 'r', idempotencyKey: 'k-o', correlationId: 'c' })).kind).toBe('ANSWERED');
    const broker = transport({ operation: 'commodity.purchase', match: { idempotencyKey: 'k-b' }, response: { lotId: 'lot-1', quantity: '10', unit: 'MT', price: '50000.00', confirmedAt: 1 } });
    const lot = expectOk(await (new CommodityBrokerAdapter(config('COMMODITY_BROKER'), new Credentials(), broker) as CommodityBrokerPort).purchase({ tenantId: 't', brokerRef: 'br', commodityCode: 'LME-AL', amount: money(5_000_000n), idempotencyKey: 'k-b', correlationId: 'c' }));
    expect(lot.kind).toBe('ANSWERED'); if (lot.kind === 'ANSWERED') expect(lot.value.price.minorUnits).toBe(5_000_000n);
  });
  it('the circuit opens after repeated failures and reports UNAVAILABLE without calling', async () => {
    const t = transport(down('employment.status'));
    const a = (new GosiAdapter(config('EMPLOYMENT_VERIFICATION'), new Credentials(), t) as EmploymentVerificationPort);
    const call = () => a.employment({ tenantId: 't', applicantRef: 'a', consentId: 'cns', correlationId: 'c' });
    await call(); await call();
    const third = expectOk(await call());
    expect(third.kind).toBe('UNAVAILABLE'); if (third.kind === 'UNAVAILABLE') expect(third.reason).toBe('circuit open');
    expect(t.calls).toHaveLength(2);
  });
});
