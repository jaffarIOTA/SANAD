/**
 * The UAE rail adapters against recorded fixtures (ADR 0005).
 *
 * The same properties as the Saudi rails — a good answer maps to the port; a
 * rail that is down is `UNAVAILABLE`, never a throw and never an answer; a
 * consent-gated rail refuses before any call; a malformed answer fails
 * closed — plus the one the UAE adds: every amount is AED, in minor units,
 * reached without a float.
 *
 * The fixtures speak each adapter's assumed contract, modelled on a named
 * public standard (see each adapter's README): Companies House for NER, UAE
 * Pass attribute names for ICP, a standard bureau report for AECB, VIES for
 * FTA, the WPS SIF for MOHRE, docs.uaepass.ae for UAE Pass, ISO 20022 for the
 * partner bank, and the published CBUAE Open Finance v2.1 API.
 */
import { describe, expect, it } from 'vitest';

import { FixtureTransport, type Fixture } from '../../adapters/kernel/fixture-transport.ts';
import { type RailTransport, TransportError } from '../../adapters/kernel/http-transport.ts';
import type { RailAdapterConfig } from '../../adapters/kernel/rail-adapter.ts';
import { aed, aedAmountObject, aedDecimal, requireAed } from '../../adapters/uae/kernel/dirham.ts';
import { isoEpoch } from '../../adapters/uae/kernel/iso-time.ts';
import { lookupStatus } from '../../adapters/uae/kernel/vocabulary.ts';
import { AECB_DEVIATIONS, AecbAdapter } from '../../adapters/uae/aecb/adapter.ts';
import { UAE_PASS_DEVIATIONS, UaePassAdapter } from '../../adapters/uae/uae-pass/adapter.ts';
import { ICP_DEVIATIONS, IcpAdapter } from '../../adapters/uae/icp/adapter.ts';
import { NER_DEVIATIONS, NerAdapter } from '../../adapters/uae/ner/adapter.ts';
import { MOHRE_DEVIATIONS, MohreAdapter, wpsCompliant } from '../../adapters/uae/mohre/adapter.ts';
import { FTA_DEVIATIONS, FtaAdapter } from '../../adapters/uae/fta/adapter.ts';
import { PARTNER_BANK_DEVIATIONS, PartnerBankAdapter } from '../../adapters/uae/partner-bank/adapter.ts';
import { OPEN_FINANCE_DEVIATIONS, OpenFinanceAdapter } from '../../adapters/uae/open-finance/adapter.ts';
import { type CredentialProvider, type CredentialRef, SecretValue } from '../../core/ports/credentials.ts';
import type { AccountInformationPort } from '../../core/ports/account-information.ts';
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

/** A rail that answers HTTP 404 to everything. */
class NotFound implements RailTransport {
  call(operation: string): Promise<Readonly<Record<string, unknown>>> {
    return Promise.reject(new TransportError(operation, 404, 'not found'));
  }
}

class Credentials implements CredentialProvider {
  readonly refs: CredentialRef[] = [];
  async get(ref: CredentialRef): Promise<SecretValue> {
    this.refs.push(ref);
    return new SecretValue('a-provider-credential-value');
  }
}
/** 2027-01-15T08:00:00Z. */
const NOW = 1_800_000_000;
const NOW_ISO = '2027-01-15T08:00:00Z';
const BASE = 'https://rail.sandbox.example';
const config = (provider: RailAdapterConfig['provider']): RailAdapterConfig => ({
  tenantId: 'sme-fund-ae',
  provider,
  environment: 'sandbox',
  freshnessWindowSeconds: 0,
  failurePosture: 'FAIL_CLOSED',
  credentialTtlSeconds: 600,
  breaker: { failureThreshold: 2, resetAfterSeconds: 30, successThreshold: 1 },
  nowEpochSeconds: () => NOW,
  baseUrl: BASE,
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
const mohreAdapter = (t: FixtureTransport) => new MohreAdapter(config('EMPLOYMENT_VERIFICATION'), new Credentials(), t);
const mohre = (t: FixtureTransport): EmploymentVerificationPort => mohreAdapter(t);
const fta = (t: FixtureTransport): TaxCompliancePort => new FtaAdapter(config('TAX_COMPLIANCE'), new Credentials(), t);
const bank = (t: FixtureTransport): PaymentsPort =>
  new PartnerBankAdapter(config('PAYMENTS_HUB'), new Credentials(), t);
const openFinance = (t: FixtureTransport): AccountInformationPort =>
  new OpenFinanceAdapter(config('OPEN_BANKING'), new Credentials(), t);

const LICENCE = 'CN-1234567';
const bureauReq = (consentId = 'cns-1') => ({
  tenantId: 'sme-fund-ae',
  counterpartyId: 'cp-1',
  commercialRegistration: LICENCE,
  consentId,
  correlationId: 'c',
});

// -- Fixture shapes, one per assumed contract ----------------------------------

/** A Companies House-style profile, with the NER's own fields. */
const nerProfile = (over: Readonly<Record<string, unknown>> = {}) => ({
  company_name: 'Test Trading LLC',
  company_name_ar: 'مؤسسة الاختبار',
  company_number: LICENCE,
  company_status: 'active',
  type: 'llc',
  date_of_creation: '2019-04-01',
  licence_expiry_date: '2027-12-31',
  economic_register_number: 'ERN-1',
  issuing_authority: { code: 'DET', name_en: 'Dubai Department of Economy and Tourism' },
  isic4_activities: [{ code: '4690', description_en: 'Non-specialized wholesale trade' }],
  share_capital: { amount: '300000.00', currency: 'AED' },
  registered_office_address: { address_line_1: 'SHOULD NOT CROSS' },
  etag: 'ner-lk-1',
  ...over,
});
const officers = (...items: Readonly<Record<string, unknown>>[]) => ({
  kind: 'officer-list',
  items,
  total_results: items.length,
});
const officer = (ref: string, over: Readonly<Record<string, unknown>> = {}) => ({
  name: 'SHOULD NOT CROSS',
  officer_role: 'manager',
  appointed_on: '2019-04-01',
  nationality: 'SHOULD NOT CROSS',
  identification: { registration_number: 'SHOULD NOT CROSS' },
  links: { officer: { appointments: `/officers/${ref}/appointments` } },
  ...over,
});
const controllers = (...items: Readonly<Record<string, unknown>>[]) => ({ items, total_results: items.length });
const controller = (ref: string, over: Readonly<Record<string, unknown>> = {}) => ({
  kind: 'individual-person-with-significant-control',
  name: 'SHOULD NOT CROSS',
  natures_of_control: ['ownership-of-shares-75-to-100-percent'],
  date_of_birth: { month: 1, year: 1980 },
  links: { self: `/company/${LICENCE}/persons-with-significant-control/individual/${ref}` },
  ...over,
});
const nerFixtures = (
  profile: Readonly<Record<string, unknown>> = nerProfile(),
  officerList: Readonly<Record<string, unknown>> = officers(),
  controllerList: Readonly<Record<string, unknown>> = controllers(),
): Fixture[] => [
  answer('registry.lookup', profile),
  answer('registry.officers', officerList),
  answer('registry.psc', controllerList),
];
const lookup = (t: FixtureTransport, licence = LICENCE) =>
  ner(t).lookup({ tenantId: 'sme-fund-ae', commercialRegistration: licence, correlationId: 'c' });

/** A bureau report in the common international layout. */
const amt = (amount: unknown, currency: unknown = 'AED') => ({ amount, currency });
const contract = (over: Readonly<Record<string, unknown>> = {}) => ({
  contract_ref: 'k-1',
  type: 'TERM_LOAN',
  role: 'PRIMARY',
  status: 'ACTIVE',
  credit_limit: amt('500000.00'),
  outstanding_balance: amt('250000.00'),
  overdue_amount: amt('0.00'),
  days_past_due: 0,
  payment_history: [{ period: '2026-12', days_past_due: 0 }],
  ...over,
});
const bureauReport = (over: Readonly<Record<string, unknown>> = {}) => ({
  report: { reference: 'aecb-r-1', generated_at: NOW_ISO, product: 'COMMERCIAL_CREDIT_REPORT', subject_found: true },
  subject: { trade_name: 'SHOULD NOT CROSS', emirates_id: 'SHOULD NOT CROSS' },
  contracts: [contract()],
  ...over,
});

/** UAE Pass userinfo attribute names under an ICP verification. */
const icpAnswer = (outcome: string, cardStatus: string, mismatched: readonly string[] = []) => ({
  verification: { reference: 'v-1', verified_at: '2027-01-15T08:01:40Z', outcome, mismatched_attributes: mismatched },
  card: { idType: 'ID', status: cardStatus },
  subject: { idn: 'SHOULD NOT CROSS', fullnameEN: 'SHOULD NOT CROSS', nationalityEN: 'SHOULD NOT CROSS' },
});

/** WPS SIF records. */
const sif = (month: string, fixed: unknown, variable: unknown = '0.00') => ({
  scr: {
    record_type: 'SCR',
    employer_id: '1000000000001',
    salary_month: month,
    edr_count: 10,
    total_salary: '150000.00',
    currency: 'AED',
  },
  edr: {
    record_type: 'EDR',
    iban: 'SHOULD NOT CROSS',
    fixed_income: fixed,
    variable_income: variable,
    days_in_period: 30,
  },
});
const wpsReport = (records: readonly unknown[], over: Readonly<Record<string, unknown>> = {}) => ({
  report: { reference: 'wps-1', generated_at: NOW_ISO },
  employee: {
    employment_status: 'ACTIVE',
    establishment_ref: 'est-1',
    contract_start_date: '2020-09-13',
    person_id: 'SHOULD NOT CROSS',
    labour_card_number: 'SHOULD NOT CROSS',
  },
  salary_records: records,
  ...over,
});

/** A VIES-style validation answer. */
const vies = (over: Readonly<Record<string, unknown>>) => ({
  requestDate: NOW_ISO,
  requestIdentifier: 'WAPI-1',
  name: 'SHOULD NOT CROSS',
  address: 'SHOULD NOT CROSS',
  ...over,
});
const taxCheck = (t: FixtureTransport, key = '100123456700003') =>
  fta(t).certificateStatus({ tenantId: 'sme-fund-ae', crNumber: key, correlationId: 'c' });

/** A pain.002 / pacs.002-style status report. */
const statusReport = (instrId: string, tx: Readonly<Record<string, unknown>>) => ({
  GrpHdr: { MsgId: 'm-1', CreDtTm: NOW_ISO },
  TxInfAndSts: { OrgnlInstrId: instrId, AccptncDtTm: NOW_ISO, AcctSvcrRef: 'pay-1', ...tx },
});
const disbursement = {
  tenantId: 'sme-fund-ae',
  beneficiaryRef: 'ben-1',
  amount: money(50_000_000n, 'AED'),
  purposeCode: 'LOA',
  reference: 'disb-1',
  idempotencyKey: 'k-d',
  correlationId: 'c',
};

describe('dirhams and dates at the boundary, without a float', () => {
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
  it('reads an Open Finance amount object: a string only, up to five decimals, nothing below the fils', () => {
    expect(aedAmountObject({ Amount: '1500.12000', Currency: 'AED' })).toEqual({
      minorUnits: 150_012n,
      currency: 'AED',
    });
    expect(aedAmountObject({ Amount: '9999999999999.99', Currency: 'AED' })?.minorUnits).toBe(999_999_999_999_999n);
    expect(aedAmountObject({ Amount: '1500.12345', Currency: 'AED' })).toBeUndefined();
    expect(aedAmountObject({ Amount: 1500, Currency: 'AED' })).toBeUndefined();
    expect(aedAmountObject({ Amount: '1500.00', Currency: 'USD' })).toBeUndefined();
    expect(aedAmountObject({ Amount: '-1.00', Currency: 'AED' })).toBeUndefined();
  });
  it('writes minor units as an ISO 20022 decimal by digit manipulation', () => {
    expect(aedDecimal(money(50_000_000n, 'AED'))).toBe('500000.00');
    expect(aedDecimal(money(5n, 'AED'))).toBe('0.05');
    expect(aedDecimal(money(-1_005n, 'AED'))).toBe('-10.05');
  });
  it('reads ISO 8601 times strictly', () => {
    expect(isoEpoch('2027-01-15T12:00:00+04:00')).toBe(1_800_000_000n);
    expect(isoEpoch('2027-01-15T08:00:00.123Z')).toBe(1_800_000_000n);
    expect(isoEpoch('2027-01-15')).toBe(1_799_971_200n);
    expect(isoEpoch('2026-02-30')).toBeUndefined();
    expect(isoEpoch('2027-01-15T08:00:00')).toBeUndefined();
    expect(isoEpoch(1_800_000_000)).toBeUndefined();
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
      'UAE Pass signing',
      () =>
        uaePass(transport(down('signature.start'))).startAuthentication({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          purpose: 'SIGNATURE_INTENT',
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
    ['NER', () => lookup(transport(down('registry.lookup')))],
    ['NER officers', () => lookup(transport(answer('registry.lookup', nerProfile()), down('registry.officers')))],
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
    ['FTA', () => taxCheck(transport(down('tax.registration')))],
    [
      'Partner bank',
      () => bank(transport(down('payments.disburse'))).disburse({ ...disbursement, amount: money(100n, 'AED') }),
    ],
    [
      'Open Finance',
      () =>
        openFinance(transport(down('openfinance.consent'))).affordabilityFacts({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          consentId: 'cns-1',
          months: 3,
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
  it('FTA: the validation service saying it is unavailable is UNAVAILABLE, not NOT_FOUND', async () => {
    const r = expectOk(
      await taxCheck(transport(answer('tax.registration', vies({ isValid: false, userError: 'MS_UNAVAILABLE' })))),
    );
    expect(r.kind).toBe('UNAVAILABLE');
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
    [
      'MOHRE establishment',
      (t: FixtureTransport) =>
        mohreAdapter(t).establishmentCompliance({
          tenantId: 'sme-fund-ae',
          tradeLicence: LICENCE,
          consentId: '',
          correlationId: 'c',
        }),
    ],
    [
      'Open Finance',
      (t: FixtureTransport) =>
        openFinance(t).affordabilityFacts({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          consentId: ' ',
          months: 3,
          correlationId: 'c',
        }),
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
      'AECB without a report reference',
      () => aecb(transport(answer('bureau.commercial', { report: { subject_found: true } }))).request(bureauReq()),
    ],
    [
      'AECB with a float amount',
      () =>
        aecb(
          transport(
            answer('bureau.commercial', bureauReport({ contracts: [contract({ outstanding_balance: amt(1200.5) })] })),
          ),
        ).request(bureauReq()),
    ],
    [
      'AECB in another currency',
      () =>
        aecb(
          transport(
            answer(
              'bureau.commercial',
              bureauReport({ contracts: [contract({ outstanding_balance: amt('1.00', 'SAR') })] }),
            ),
          ),
        ).request(bureauReq()),
    ],
    [
      'AECB with one unreadable default',
      () =>
        aecb(
          transport(
            answer(
              'bureau.commercial',
              bureauReport({ public_records: { bounced_cheques: [{ amount: amt('1.005'), settled: false }] } }),
            ),
          ),
        ).request(bureauReq()),
    ],
    [
      'AECB with a contract status we do not know',
      () =>
        aecb(
          transport(answer('bureau.commercial', bureauReport({ contracts: [contract({ status: 'toString' })] }))),
        ).request(bureauReq()),
    ],
    [
      'AECB with a score outside the published 300–900 scale',
      () => aecb(transport(answer('bureau.commercial', bureauReport({ score: { value: 950 } })))).request(bureauReq()),
    ],
    [
      'AECB stating another scale',
      () =>
        aecb(
          transport(answer('bureau.commercial', bureauReport({ score: { value: 700, range_min: 0, range_max: 999 } }))),
        ).request(bureauReq()),
    ],
    [
      'UAE Pass with an unknown assurance level',
      () =>
        uaePass(
          transport(
            answer('identity.confirm', {
              id_token: { jti: 'a', sub: 's', auth_time: NOW },
              userinfo: { sub: 's', userType: 'SOP9' },
            }),
          ),
        ).confirmAuthentication({ tenantId: 'sme-fund-ae', transactionRef: 'login:tx', correlationId: 'c' }),
    ],
    [
      'UAE Pass whose userinfo subject is not the id token’s',
      () =>
        uaePass(
          transport(
            answer('identity.confirm', {
              id_token: { jti: 'a', sub: 's', auth_time: NOW },
              userinfo: { sub: 'someone-else', userType: 'SOP3' },
            }),
          ),
        ).confirmAuthentication({ tenantId: 'sme-fund-ae', transactionRef: 'login:tx', correlationId: 'c' }),
    ],
    [
      'UAE Pass signer process with a status not in the published list',
      () =>
        uaePass(transport(answer('signature.confirm', { id: 'sp', status: 'probably_signed' }))).confirmAuthentication({
          tenantId: 'sme-fund-ae',
          transactionRef: 'sign:sp',
          correlationId: 'c',
        }),
    ],
    [
      'ICP with an unknown card status',
      () =>
        icp(transport(answer('identity.verify', icpAnswer('MATCH', 'toString')))).verify({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          consentId: 'cns',
          correlationId: 'c',
        }),
    ],
    [
      'ICP with an unknown outcome',
      () =>
        icp(transport(answer('identity.verify', icpAnswer('PROBABLY', 'VALID')))).verify({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          consentId: 'cns',
          correlationId: 'c',
        }),
    ],
    [
      'NER with an unknown company status',
      () => lookup(transport(...nerFixtures(nerProfile({ company_status: 'under-review' })))),
    ],
    [
      'NER echoing another licence',
      () => lookup(transport(...nerFixtures(nerProfile({ company_number: 'CN-0000001' })))),
    ],
    [
      'NER with an activity that is not ISIC4',
      () => lookup(transport(...nerFixtures(nerProfile({ isic4_activities: [{ code: 'TRADING' }] })))),
    ],
    [
      'NER with an officer it cannot reference',
      () => lookup(transport(...nerFixtures(nerProfile(), officers(officer('o-1', { links: {} }))))),
    ],
    [
      'NER with a truncated controller list',
      () =>
        lookup(transport(...nerFixtures(nerProfile(), officers(), { items: [controller('p-1')], total_results: 2 }))),
    ],
    [
      'MOHRE with an unreadable SIF month',
      () =>
        mohre(
          transport(answer('employment.wps', wpsReport([sif('092026', '15000.00'), sif('132026', '1.00')]))),
        ).employment({
          tenantId: 'sme-fund-ae',
          applicantRef: 'a',
          consentId: 'cns',
          correlationId: 'c',
        }),
    ],
    [
      'MOHRE with an unknown employment status',
      () =>
        mohre(
          transport(answer('employment.wps', wpsReport([], { employee: { employment_status: 'MAYBE' } }))),
        ).employment({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: 'cns', correlationId: 'c' }),
    ],
    [
      'FTA with an unknown outcome',
      () => taxCheck(transport(answer('tax.registration', vies({ isValid: true, userError: 'SOMETHING_NEW' })))),
    ],
    [
      'FTA whose isValid contradicts its outcome',
      () => taxCheck(transport(answer('tax.registration', vies({ isValid: true, userError: 'INVALID' })))),
    ],
    [
      'FTA answering for another TRN',
      () =>
        taxCheck(
          transport(
            answer('tax.registration', vies({ isValid: true, userError: 'VALID', vatNumber: '100999999999993' })),
          ),
        ),
    ],
    [
      'Partner bank with an unknown status',
      () =>
        bank(transport(answer('payments.disburse', statusReport('k-d', { TxSts: 'PROBABLY_PAID' })))).disburse(
          disbursement,
        ),
    ],
    [
      'Partner bank reporting on another instruction',
      () =>
        bank(transport(answer('payments.disburse', statusReport('k-other', { TxSts: 'ACSC' })))).disburse(disbursement),
    ],
    [
      'Partner bank rejecting without a reason code',
      () => bank(transport(answer('payments.disburse', statusReport('k-d', { TxSts: 'RJCT' })))).disburse(disbursement),
    ],
  ] as readonly Call[])('%s', async (_name, call) => {
    const r = expectOk(await call());
    expect(r).toEqual({ kind: 'UNAVAILABLE', reason: 'response malformed' });
  });
});

describe('answers map to the port in AED, and identifiers do not cross', () => {
  it('AECB reduces a commercial report to the summary: open borrower contracts, worst history, defaults and cheques', async () => {
    const t = transport(
      answer(
        'bureau.commercial',
        bureauReport({
          score: { value: 688, range_min: 300, range_max: 900, band: 'B', reason_codes: [{ code: 'C14' }] },
          contracts: [
            contract({ outstanding_balance: amt('250000.00'), overdue_amount: amt('1250.75'), days_past_due: 30 }),
            contract({
              contract_ref: 'k-2',
              type: 'OVERDRAFT',
              outstanding_balance: amt('4000.10'),
              overdue_amount: amt('4000.10'),
              status: 'WRITTEN_OFF',
              days_past_due: 0,
              payment_history: [
                { period: '2026-07', days_past_due: 90 },
                { period: '2026-08', days_past_due: 0 },
              ],
            }),
            contract({ contract_ref: 'k-3', status: 'SETTLED', outstanding_balance: amt('0.00') }),
            contract({
              contract_ref: 'k-4',
              role: 'GUARANTOR',
              outstanding_balance: amt('999999.00'),
              days_past_due: 120,
            }),
          ],
          enquiries: [{ date: '2026-12-01', sector: 'BANK' }],
          public_records: {
            court_cases: [{ case_ref: 'SHOULD NOT CROSS', status: 'OPEN' }],
            bounced_cheques: [{ cheque_date: '2026-05-01', amount: amt('15000.00'), settled: true }],
          },
        }),
        { tradeLicenceNumber: LICENCE, consentRef: 'cns-1' },
      ),
    );
    const r = expectOk(await (aecb(t) as CreditBureauPort).request(bureauReq()));
    expect(r.kind).toBe('REPORT');
    if (r.kind === 'REPORT') {
      expect(r.summary.bureauReference).toBe('aecb-r-1');
      expect(r.summary.totalExposure).toEqual({ minorUnits: 25_400_010n, currency: 'AED' });
      expect(r.summary.overdueAmount).toEqual({ minorUnits: 525_085n, currency: 'AED' });
      expect(r.summary.activeFacilities).toBe(2);
      expect(r.summary.worstDelinquencyDays).toBe(90);
      expect(r.summary.defaults).toEqual([
        { amount: { minorUnits: 400_010n, currency: 'AED' }, settled: false },
        { amount: { minorUnits: 1_500_000n, currency: 'AED' }, settled: true },
      ]);
      expect(r.summary.bureauScore).toBe(688);
      expect(r.summary.retrievedAt).toBe(at);
    }
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    expect(t.calls[0]?.headers['authorization']).toMatch(/^Bearer /);
  });
  it('AECB: no hit is NO_RECORD with the bureau reference; an individual report is keyed by reference; no score is no score', async () => {
    expect(
      expectOk(
        await aecb(
          transport(answer('bureau.commercial', { report: { reference: 'r-0', subject_found: false } })),
        ).request(bureauReq()),
      ),
    ).toEqual({ kind: 'NO_RECORD', bureauReference: 'r-0' });
    const t = transport(
      answer('bureau.individual', bureauReport({ contracts: [] }), { applicantRef: 'owner-1', consentRef: 'cns' }),
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
    if (r.kind === 'REPORT') {
      expect(r.summary.totalExposure).toEqual({ minorUnits: 0n, currency: 'AED' });
      expect(r.summary).not.toHaveProperty('bureauScore');
    }
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
  it('UAE Pass: a verified login maps to an assertion from the published claims; the Emirates ID and profile never cross', async () => {
    const start = transport(
      answer(
        'identity.start',
        { state: 'tx-1', expires_in: 300 },
        {
          url: `${BASE}/idshub/authorize`,
          response_type: 'code',
          scope: 'urn:uae:digitalid:profile:general',
          state: 'app-1',
        },
      ),
    );
    expect(
      expectOk(
        await uaePass(start).startAuthentication({
          tenantId: 'sme-fund-ae',
          applicantRef: 'app-1',
          purpose: 'LOGIN',
          correlationId: 'c',
        }),
      ),
    ).toEqual({ kind: 'ANSWERED', value: { transactionRef: 'login:tx-1', expiresAtEpochSeconds: 1_800_000_300n } });
    const t = transport(
      answer(
        'identity.confirm',
        {
          id_token: {
            jti: 'as-1',
            sub: 'sub-1',
            auth_time: 1_800_000_100,
            acr: 'urn:safelayer:tws:policies:authentication:level:low',
          },
          userinfo: {
            sub: 'sub-1',
            userType: 'SOP3',
            idn: 'SHOULD NOT CROSS',
            fullnameEN: 'SHOULD NOT CROSS',
            mobile: 'SHOULD NOT CROSS',
            email: 'SHOULD NOT CROSS',
          },
        },
        { url: `${BASE}/idshub/userinfo?state=tx-1` },
      ),
    );
    const r = expectOk(
      await uaePass(t).confirmAuthentication({
        tenantId: 'sme-fund-ae',
        transactionRef: 'login:tx-1',
        correlationId: 'c',
      }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { assertionId: 'as-1', identityRef: 'sub-1', authenticatedAtEpochSeconds: 1_800_000_100n },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
  });
  it('UAE Pass: a signing intent is a published signer process; its finished result is the assertion', async () => {
    const start = transport(
      answer(
        'signature.start',
        { id: 'sp-1', status: 'active', tasks: { pending: [{ id: 't-1', url: 'https://sign.example/sp-1' }] } },
        {
          url: `${BASE}/trustedx-resources/esignsp/v2/signer_processes`,
          process_type: 'urn:safelayer:eidas:processes:document:sign:esigp',
          state: 'app-1',
        },
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
    ).toEqual({ kind: 'ANSWERED', value: { transactionRef: 'sign:sp-1', expiresAtEpochSeconds: 1_800_000_900n } });
    const done = transport(
      answer(
        'signature.confirm',
        {
          id: 'sp-1',
          status: 'finished',
          finished_at: NOW_ISO,
          signer: { sub: 'sub-1', userType: 'SOP2', idn: 'SHOULD NOT CROSS' },
        },
        { url: `${BASE}/trustedx-resources/esignsp/v2/signer_processes/sp-1` },
      ),
    );
    const r = expectOk(
      await uaePass(done).confirmAuthentication({
        tenantId: 'sme-fund-ae',
        transactionRef: 'sign:sp-1',
        correlationId: 'c',
      }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: { assertionId: 'sp-1', identityRef: 'sub-1', authenticatedAtEpochSeconds: 1_800_000_000n },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    for (const [status, code] of [
      ['failed', 'STATUS_FAILED'],
      ['failed_documents', 'STATUS_FAILED_DOCUMENTS'],
      ['canceled', 'STATUS_CANCELED'],
    ] as const) {
      const t = transport(answer('signature.confirm', { id: 'sp-1', status }));
      expect(
        expectOk(
          await uaePass(t).confirmAuthentication({
            tenantId: 'sme-fund-ae',
            transactionRef: 'sign:sp-1',
            correlationId: 'c',
          }),
        ),
      ).toEqual({ kind: 'REFUSED', code });
    }
  });
  it('UAE Pass: a basic (SOP1) account may log in but not step up or sign; OAuth errors are refusals; an unknown reference never calls', async () => {
    const claims = (userType: string) => ({
      id_token: { jti: `a-${userType}`, sub: 's', auth_time: NOW },
      userinfo: { sub: 's', userType },
    });
    const confirm = (
      transactionRef: string,
      op = 'identity.confirm',
      response: Readonly<Record<string, unknown>> = claims('SOP1'),
    ) =>
      uaePass(transport(answer(op, response))).confirmAuthentication({
        tenantId: 'sme-fund-ae',
        transactionRef,
        correlationId: 'c',
      });
    expect(expectOk(await confirm('login:tx')).kind).toBe('ANSWERED');
    expect(expectOk(await confirm('stepup:tx'))).toEqual({ kind: 'REFUSED', code: 'ASSURANCE_INSUFFICIENT' });
    expect(
      expectOk(
        await confirm('sign:sp', 'signature.confirm', {
          id: 'sp',
          status: 'finished',
          finished_at: NOW_ISO,
          signer: { sub: 's', userType: 'SOP1' },
        }),
      ),
    ).toEqual({ kind: 'REFUSED', code: 'ASSURANCE_INSUFFICIENT' });
    expect(expectOk(await confirm('stepup:tx', 'identity.confirm', claims('SOP2'))).kind).toBe('ANSWERED');
    expect(expectOk(await confirm('login:tx', 'identity.confirm', { error: 'authorization_pending' }))).toEqual({
      kind: 'REFUSED',
      code: 'STATUS_PENDING',
    });
    expect(expectOk(await confirm('login:tx', 'identity.confirm', { error: 'access_denied' }))).toEqual({
      kind: 'REFUSED',
      code: 'STATUS_REJECTED',
    });
    const none = transport();
    expect(
      expectOk(
        await uaePass(none).confirmAuthentication({
          tenantId: 'sme-fund-ae',
          transactionRef: 'tx-1',
          correlationId: 'c',
        }),
      ),
    ).toEqual({ kind: 'REFUSED', code: 'TRANSACTION_REF_UNKNOWN' });
    expect(none.calls).toHaveLength(0);
  });
  it('ICP: a matching but expired card is not verified, attributes never cross, and mismatches are renamed', async () => {
    const t = transport(
      answer('identity.verify', icpAnswer('MATCH', 'EXPIRED'), { applicantRef: 'app-1', consentRef: 'cns-1' }),
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
    const valid = expectOk(
      await icp(transport(answer('identity.verify', icpAnswer('MATCH', 'VALID')))).verify({
        tenantId: 'sme-fund-ae',
        applicantRef: 'a',
        consentId: 'cns',
        correlationId: 'c',
      }),
    );
    expect(valid.kind === 'ANSWERED' && valid.value.verified).toBe(true);
    const partial = expectOk(
      await icp(
        transport(
          answer(
            'identity.verify',
            icpAnswer('PARTIAL_MATCH', 'VALID', ['fullnameEN', 'firstnameEN', 'nationalityEN', 'shoeSize']),
          ),
        ),
      ).verify({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: 'cns', correlationId: 'c' }),
    );
    expect(partial).toMatchObject({
      kind: 'ANSWERED',
      value: { verified: false, mismatches: ['name', 'nationality', 'other'] },
    });
  });
  it('NER: a Companies House-style profile maps to the record; officers and controllers become references; capital is AED fils', async () => {
    const t = transport(
      answer('registry.lookup', nerProfile(), { url: `${BASE}/company/${LICENCE}` }),
      answer(
        'registry.officers',
        officers(officer('own-1'), officer('mgr-2'), officer('gone-3', { resigned_on: '2024-01-01' })),
        { url: `${BASE}/company/${LICENCE}/officers` },
      ),
      answer(
        'registry.psc',
        controllers(controller('own-1'), controller('ceased-4', { ceased_on: '2023-01-01' }), controller('own-5')),
        { url: `${BASE}/company/${LICENCE}/persons-with-significant-control` },
      ),
    );
    const r = expectOk(await lookup(t));
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: {
        commercialRegistration: LICENCE,
        legalNameAr: 'مؤسسة الاختبار',
        legalNameEn: 'Test Trading LLC',
        legalForm: 'LLC',
        status: 'ACTIVE',
        activityCodes: ['4690'],
        signatoryRefs: ['own-1', 'own-5', 'mgr-2'],
        lookupRef: 'ner-lk-1',
        retrievedAtEpochSeconds: 1_800_000_000n,
        paidCapitalMinorUnits: 30_000_000n,
        registeredAtGregorian: '2019-04-01',
      },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    expect(json(r)).not.toContain('ERN-1');
  });
  it('NER: an unknown licence is NOT_FOUND, a malformed licence never calls, a status maps by vocabulary, and a past expiry makes an active licence EXPIRED', async () => {
    const unknown = await new NerAdapter(config('BUSINESS_REGISTRY'), new Credentials(), new NotFound()).lookup({
      tenantId: 'sme-fund-ae',
      commercialRegistration: LICENCE,
      correlationId: 'c',
    });
    expect(expectOk(unknown)).toEqual({ kind: 'REFUSED', code: 'NOT_FOUND' });
    const missing = transport({ operation: 'registry.lookup', match: {}, response: {}, failsWith: 'x' });
    expect(expectOk(await lookup(missing)).kind).toBe('UNAVAILABLE');
    const none = transport();
    const bad = await lookup(none, '../x');
    expect(bad.ok).toBe(false);
    expect(none.calls).toHaveLength(0);

    const statusOf = async (over: Readonly<Record<string, unknown>>) => {
      const r = expectOk(await lookup(transport(...nerFixtures(nerProfile(over)))));
      return r.kind === 'ANSWERED' ? r.value.status : r.kind;
    };
    expect(await statusOf({ company_status: 'frozen' })).toBe('SUSPENDED');
    expect(await statusOf({ company_status: 'liquidation' })).toBe('SUSPENDED');
    expect(await statusOf({ company_status: 'dissolved' })).toBe('CANCELLED');
    expect(await statusOf({ company_status: 'expired' })).toBe('EXPIRED');
    expect(await statusOf({ licence_expiry_date: '2026-12-31' })).toBe('EXPIRED');
    expect(await statusOf({ licence_expiry_date: 'not-a-date' })).toBe('UNAVAILABLE');
  });
  it('NER: a capital stated in another currency is left out, not relabelled', async () => {
    const r = expectOk(
      await lookup(transport(...nerFixtures(nerProfile({ share_capital: { amount: '1000.00', currency: 'USD' } })))),
    );
    expect(r.kind).toBe('ANSWERED');
    if (r.kind === 'ANSWERED') expect(r.value).not.toHaveProperty('paidCapitalMinorUnits');
  });
  it('MOHRE: the registered salary is the latest SIF month’s fixed income, in AED fils, with the report reference', async () => {
    const t = transport(
      answer(
        'employment.wps',
        wpsReport([
          sif('072026', '14500.00', '900.00'),
          sif('092026', '15250.50', '1200.00'),
          sif('082026', '15000.00'),
        ]),
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
        employedSinceEpochSeconds: 1_599_955_200n,
      },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    const left = expectOk(
      await mohre(
        transport(answer('employment.wps', wpsReport([], { employee: { employment_status: 'TERMINATED' } }))),
      ).employment({ tenantId: 'sme-fund-ae', applicantRef: 'a', consentId: 'cns', correlationId: 'c' }),
    );
    expect(left).toMatchObject({ kind: 'ANSWERED', value: { employed: false } });
    expect(left.kind === 'ANSWERED' && left.value).not.toHaveProperty('registeredSalary');
  });
  it('MOHRE: an establishment’s SIF control records are judged against the 85%-paid rule in integers', async () => {
    expect(wpsCompliant(17, 20)).toBe(true);
    expect(wpsCompliant(16, 20)).toBe(false);
    expect(wpsCompliant(12, 14)).toBe(true);
    expect(wpsCompliant(11, 14)).toBe(false);
    expect(wpsCompliant(0, 0)).toBe(true);
    const scr = (month: string, due: number, paid: number) => ({
      record_type: 'SCR',
      salary_month: month,
      employees_due: due,
      edr_count: paid,
      total_salary: '95000.00',
      currency: 'AED',
    });
    const t = transport(
      answer(
        'employment.wps.establishment',
        {
          report: { reference: 'wps-e-1', generated_at: NOW_ISO },
          establishment: { establishment_ref: 'est-1', employer_id: 'SHOULD NOT CROSS' },
          salary_control_records: [scr('122026', 14, 13), scr('112026', 14, 11)],
        },
        { tradeLicenceNumber: LICENCE, consentRef: 'cns' },
      ),
    );
    const r = expectOk(
      await mohreAdapter(t).establishmentCompliance({
        tenantId: 'sme-fund-ae',
        tradeLicence: LICENCE,
        consentId: 'cns',
        correlationId: 'c',
      }),
    );
    expect(r).toEqual({
      kind: 'ANSWERED',
      value: {
        establishmentRef: 'est-1',
        months: [
          {
            payMonth: '2026-11',
            employeesDue: 14,
            employeesPaid: 11,
            totalPaid: { minorUnits: 9_500_000n, currency: 'AED' },
            compliant: false,
          },
          {
            payMonth: '2026-12',
            employeesDue: 14,
            employeesPaid: 13,
            totalPaid: { minorUnits: 9_500_000n, currency: 'AED' },
            compliant: true,
          },
        ],
        compliantLatestMonth: true,
        referenceId: 'wps-e-1',
        retrievedAtEpochSeconds: 1_800_000_000n,
      },
    });
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
  });
  it('FTA: a VIES-style answer by TRN or licence maps to the port; the name and address never cross; a malformed key never calls', async () => {
    const byTrn = transport(
      answer('tax.registration', vies({ isValid: true, userError: 'VALID', vatNumber: '100123456700003' }), {
        url: `${BASE}/v1/vat-registrations/100123456700003`,
      }),
    );
    const valid = expectOk(await taxCheck(byTrn));
    expect(valid).toEqual({
      kind: 'ANSWERED',
      value: { status: 'VALID', retrievedAtEpochSeconds: 1_800_000_000n, certificateRef: 'WAPI-1' },
    });
    expect(json(valid)).not.toContain('SHOULD NOT CROSS');
    const byLicence = transport(
      answer('tax.registration', vies({ isValid: false, userError: 'INVALID' }), {
        url: `${BASE}/v1/vat-registrations?licence=${LICENCE}`,
      }),
    );
    const nf = expectOk(await taxCheck(byLicence, LICENCE));
    expect(nf.kind === 'ANSWERED' && nf.value.status).toBe('NOT_FOUND');
    const statusOf = async (userError: string) => {
      const r = expectOk(await taxCheck(transport(answer('tax.registration', vies({ isValid: false, userError })))));
      return r.kind === 'ANSWERED' ? r.value.status : r;
    };
    expect(await statusOf('DEREGISTERED')).toBe('EXPIRED');
    expect(await statusOf('SUSPENDED')).toBe('SUSPENDED');
    expect(await statusOf('INVALID_INPUT')).toEqual({ kind: 'REFUSED', code: 'INVALID_INPUT' });
    const none = transport();
    expect((await taxCheck(none, '!')).ok).toBe(false);
    expect(none.calls).toHaveLength(0);
  });
  it('Partner bank: an ISO 20022 instruction in AED with the idempotency key; status codes map to the port; another currency or a non-positive amount never calls', async () => {
    const t = transport(
      answer('payments.disburse', statusReport('k-d', { TxSts: 'ACCP' }), {
        PmtId: { InstrId: 'k-d', EndToEndId: 'disb-1' },
        InstdAmt: { Ccy: 'AED', Amt: '500000.00' },
        Purp: { Cd: 'LOA' },
        Cdtr: { Ref: 'ben-1' },
      }),
    );
    expect(expectOk(await bank(t).disburse(disbursement))).toEqual({
      kind: 'ANSWERED',
      value: { instructionRef: 'pay-1', status: 'ACCEPTED', acceptedAtEpochSeconds: 1_800_000_000n },
    });
    const statusOf = async (tx: Readonly<Record<string, unknown>>) => {
      const r = expectOk(
        await bank(transport(answer('payments.disburse', statusReport('k-d', tx)))).disburse(disbursement),
      );
      return r.kind === 'ANSWERED' ? r.value.status : r.kind;
    };
    expect(await statusOf({ TxSts: 'ACSC' })).toBe('SETTLED');
    expect(await statusOf({ TxSts: 'PDNG' })).toBe('ACCEPTED');
    expect(await statusOf({ TxSts: 'ACSP' })).toBe('ACCEPTED');
    expect(await statusOf({ TxSts: 'RJCT', StsRsnInf: { Rsn: { Cd: 'AC04' } } })).toBe('REJECTED');
    const c = transport(
      answer('payments.collect', statusReport('k-c', { TxSts: 'ACSC', RtrInf: { RtrRsn: { Cd: 'AM04' } } }), {
        PmtId: { InstrId: 'k-c', EndToEndId: 'inst-1' },
        InstdAmt: { Ccy: 'AED', Amt: '1000.00' },
      }),
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
    const sar = await bank(none).disburse({ ...disbursement, amount: money(1n, 'SAR') });
    expect(sar.ok).toBe(false);
    if (!sar.ok) expect(sar.error.reason).toBe('CURRENCY_MISMATCH');
    const zero = await bank(none).disburse({ ...disbursement, amount: money(0n, 'AED') });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error.reason).toBe('AMOUNT_NOT_POSITIVE');
    expect(none.calls).toHaveLength(0);
  });
});

describe('UAE Open Finance (CBUAE v2.1 Account Information): affordability facts from the published API', () => {
  const consent = (over: Readonly<Record<string, unknown>> = {}) => ({
    Data: {
      ConsentId: 'cns-1',
      CreationDateTime: '2027-01-14T09:00:00+04:00',
      Status: 'Authorized',
      StatusUpdateDateTime: '2027-01-14T09:02:00+04:00',
      Permissions: ['ReadAccountsBasic', 'ReadBalances', 'ReadTransactionsDetail'],
      ExpirationDateTime: '2027-04-14T09:00:00+04:00',
      OpenFinanceBilling: { UserType: 'SME', Purpose: 'RiskAssessment' },
      ...over,
    },
    Links: { Self: `${BASE}/account-access-consents/cns-1` },
    Meta: {},
  });
  const accounts = {
    Data: {
      Account: [
        {
          AccountId: 'a1',
          Status: 'Active',
          Currency: 'AED',
          AccountType: 'SME',
          AccountSubType: 'CurrentAccount',
          AccountHolderName: 'SHOULD NOT CROSS',
        },
        { AccountId: 'a2', Status: 'Active', Currency: 'USD', AccountType: 'SME', AccountSubType: 'Savings' },
        { AccountId: 'a3', Status: 'Active', Currency: 'AED', AccountType: 'SME', AccountSubType: 'CreditCard' },
        { AccountId: 'a4', Status: 'Dormant', Currency: 'AED', AccountType: 'SME', AccountSubType: 'Savings' },
      ],
    },
    Links: { Self: `${BASE}/accounts` },
    Meta: { TotalPages: 1 },
  };
  const balances = {
    Data: {
      AccountId: 'a1',
      Balance: [
        {
          CreditDebitIndicator: 'Credit',
          Type: 'ClosingAvailable',
          DateTime: '2027-01-15T12:00:00+04:00',
          Amount: { Amount: '99999.00', Currency: 'AED' },
        },
        {
          CreditDebitIndicator: 'Credit',
          Type: 'ClosingBooked',
          DateTime: '2027-01-15T12:00:00+04:00',
          Amount: { Amount: '60000.00', Currency: 'AED' },
        },
      ],
    },
    Links: { Self: `${BASE}/accounts/a1/balances` },
    Meta: { TotalPages: 1 },
  };
  const line = (
    id: string,
    date: string,
    direction: 'Credit' | 'Debit',
    amount: unknown,
    over: Readonly<Record<string, unknown>> = {},
  ) => ({
    TransactionId: id,
    TransactionDateTime: `${date}T10:00:00+04:00`,
    BookingDateTime: `${date}T10:00:00+04:00`,
    TransactionType: 'LocalBankTransfer',
    SubTransactionType: 'MoneyTransfer',
    CreditDebitIndicator: direction,
    Status: 'Booked',
    TransactionInformation: 'SHOULD NOT CROSS',
    Amount: { Amount: amount, Currency: 'AED' },
    ...over,
  });
  const fx = {
    SourceCurrency: 'USD',
    TargetCurrency: 'AED',
    UnitCurrency: 'USD',
    ExchangeRate: 3.6725,
    InstructedAmount: { Amount: '100.00', Currency: 'USD' },
  };
  const lines = (withFx: boolean, amountOverride?: unknown) => [
    line('t1', '2026-10-05', 'Credit', amountOverride ?? '3000.00'),
    line('t2', '2026-11-26', 'Credit', '2000.00', { SubTransactionType: 'Deposit', Flags: ['Payroll'] }),
    line('t3', '2026-11-10', 'Debit', '500.00'),
    line('t4', '2026-12-05', 'Credit', '1500.12000'),
    line('t5', '2026-12-06', 'Credit', '50000.00', { SubTransactionType: 'Disbursement', Flags: ['Finance'] }),
    line('t6', '2026-12-10', 'Debit', '700.00', { TransactionType: 'Cheque', Status: 'Rejected' }),
    line('t7', '2026-08-10', 'Debit', '100.00', { TransactionType: 'Cheque', Status: 'Rejected' }),
    line('t8', '2027-01-03', 'Debit', '400.00'),
    line('t9', '2026-12-20', 'Debit', '367.25', {
      TransactionType: 'ECommerce',
      SubTransactionType: 'Purchase',
      ...(withFx ? { CurrencyExchange: fx } : {}),
    }),
    line('t10', '2026-12-30', 'Credit', '9999.00', { Status: 'Pending' }),
  ];
  const fixtures = (
    over: { consent?: Readonly<Record<string, unknown>>; lines?: readonly unknown[]; paged?: boolean } = {},
  ): Fixture[] => {
    const all = over.lines ?? lines(true);
    const pages = over.paged === true ? [all.slice(0, 4), all.slice(4)] : [all];
    return [
      answer('openfinance.consent', over.consent ?? consent(), { url: `${BASE}/account-access-consents/cns-1` }),
      answer('openfinance.accounts', accounts, { url: `${BASE}/accounts` }),
      answer('openfinance.balances', balances, { url: `${BASE}/accounts/a1/balances` }),
      answer(
        'openfinance.transactions',
        {
          Data: { AccountId: 'a1', Transaction: pages[0] },
          Links: { Self: 'x', ...(pages.length > 1 ? { Next: `${BASE}/accounts/a1/transactions?page=2` } : {}) },
          Meta: { TotalPages: pages.length },
        },
        {
          url: `${BASE}/accounts/a1/transactions?fromBookingDateTime=2026-07-01T00:00:00&toBookingDateTime=2027-01-15T12:00:00`,
        },
      ),
      ...(pages.length > 1
        ? [
            answer(
              'openfinance.transactions',
              { Data: { AccountId: 'a1', Transaction: pages[1] }, Links: { Self: 'x' }, Meta: { TotalPages: 2 } },
              { url: `${BASE}/accounts/a1/transactions?page=2` },
            ),
          ]
        : []),
    ];
  };
  const read = (t: FixtureTransport, months = 3) =>
    openFinance(t).affordabilityFacts({
      tenantId: 'sme-fund-ae',
      applicantRef: 'app-1',
      consentId: 'cns-1',
      months,
      correlationId: 'c',
    });
  const EXPECTED = {
    kind: 'ANSWERED',
    value: {
      // (3000.00 + 2000.00 + 1500.12) / 3, by integer division; the loan disbursement and the pending credit are not inflow.
      averageMonthlyInflow: { minorUnits: 216_670n, currency: 'AED' },
      // Oct month-end: 60000.00 + 400.00 − (Dec 51132.87) − (Nov 1500.00) = 7767.13.
      lowestMonthEndBalance: { minorUnits: 776_713n, currency: 'AED' },
      returnedPaymentsLast6Months: 2,
      salaryCreditsObserved: 1,
      retrievedAtEpochSeconds: 1_800_000_000n,
      referenceId: 'of:cns-1:1800000000',
    },
  };

  it('derives the facts from AED current accounts: decimal strings to exact minor units, no line or name crossing', async () => {
    const t = transport(...fixtures());
    const r = expectOk(await read(t));
    expect(r).toEqual(EXPECTED);
    expect(json(r)).not.toContain('SHOULD NOT CROSS');
    // Only the eligible account is read; the USD, card and dormant accounts are left out, never converted.
    expect(t.calls.map((c) => c.operation)).toEqual([
      'openfinance.consent',
      'openfinance.accounts',
      'openfinance.balances',
      'openfinance.transactions',
    ]);
  });
  it('never reads the exchange rate: the answer is identical with and without the float-valued FX block', async () => {
    const withFx = expectOk(await read(transport(...fixtures({ lines: lines(true) }))));
    const without = expectOk(await read(transport(...fixtures({ lines: lines(false) }))));
    expect(withFx).toEqual(without);
    expect(json(withFx)).not.toContain('3.6725');
  });
  it('a numeric amount, or a non-zero digit below the fils, refuses the whole read', async () => {
    expect(expectOk(await read(transport(...fixtures({ lines: lines(true, 3000) }))))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'response malformed',
    });
    expect(expectOk(await read(transport(...fixtures({ lines: lines(true, '3000.001') }))))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'response malformed',
    });
  });
  it('follows Links.Next across pages to the same answer', async () => {
    expect(expectOk(await read(transport(...fixtures({ paged: true }))))).toEqual(EXPECTED);
  });
  it('sends the interaction id and the consent binding; the credential header cannot be displaced', async () => {
    const t = transport(...fixtures());
    await read(t);
    const accountsCall = t.calls[1];
    expect(accountsCall?.headers['x-fapi-interaction-id']).toBe('c');
    expect(accountsCall?.headers['x-sanad-consent-id']).toBe('cns-1');
    expect(accountsCall?.headers['authorization']).toMatch(/^Bearer /);
    expect(accountsCall?.headers['x-correlation-id']).toBe('c');
  });
  it.each([
    ['Revoked', { Status: 'Revoked' }, 'CONSENT_REVOKED'],
    ['AwaitingAuthorization', { Status: 'AwaitingAuthorization' }, 'CONSENT_AWAITING_AUTHORIZATION'],
    [
      'a purpose other than risk assessment',
      { OpenFinanceBilling: { UserType: 'SME', Purpose: 'BudgetingAnalysis' } },
      'CONSENT_PURPOSE_MISMATCH',
    ],
    [
      'no transaction permission',
      { Permissions: ['ReadAccountsBasic', 'ReadBalances'] },
      'CONSENT_PERMISSIONS_INSUFFICIENT',
    ],
  ] as const)('the bank’s consent says %s: refused before any account is read', async (_n, over, code) => {
    const t = transport(...fixtures({ consent: consent(over) }));
    expect(expectOk(await read(t))).toEqual({ kind: 'REFUSED', code });
    expect(t.calls).toHaveLength(1);
  });
  it('an unknown consent at the bank is CONSENT_NOT_FOUND; a consent for another id is malformed; no eligible account is refused', async () => {
    const unknown = await new OpenFinanceAdapter(
      config('OPEN_BANKING'),
      new Credentials(),
      new NotFound(),
    ).affordabilityFacts({
      tenantId: 'sme-fund-ae',
      applicantRef: 'app-1',
      consentId: 'cns-1',
      months: 3,
      correlationId: 'c',
    });
    expect(expectOk(unknown)).toEqual({ kind: 'REFUSED', code: 'CONSENT_NOT_FOUND' });
    expect(expectOk(await read(transport(...fixtures({ consent: consent({ ConsentId: 'cns-other' }) }))))).toEqual({
      kind: 'UNAVAILABLE',
      reason: 'response malformed',
    });
    const noneEligible = transport(
      answer('openfinance.consent', consent()),
      answer('openfinance.accounts', { Data: { Account: [accounts.Data.Account[1]] }, Links: { Self: 'x' }, Meta: {} }),
    );
    expect(expectOk(await read(noneEligible))).toEqual({ kind: 'REFUSED', code: 'NO_ELIGIBLE_ACCOUNT' });
  });
  it('refuses a months window it cannot read, before any call', async () => {
    const t = transport();
    const r = await read(t, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('MONTHS_OUT_OF_RANGE');
    expect(t.calls).toHaveLength(0);
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
    ['Open Finance', OPEN_FINANCE_DEVIATIONS, 'UAE-RAIL-OPENFINANCE-01'],
  ] as const)('%s', (_name, deviations, item) => {
    expect(deviations.length).toBeGreaterThan(0);
    for (const d of deviations) {
      expect(d.containment.length).toBeGreaterThan(0);
      expect(d.verificationRef).toBe(item);
    }
  });
  it('reads its credential under the capability it was configured for', async () => {
    const creds = new Credentials();
    const t = transport(answer('bureau.commercial', { report: { reference: 'r', subject_found: false } }));
    await new AecbAdapter(config('CREDIT_BUREAU'), creds, t, attest).request(bureauReq());
    expect(creds.refs[0]).toMatchObject({ tenantId: 'sme-fund-ae', provider: 'CREDIT_BUREAU', environment: 'sandbox' });
  });
});

describe('UAE M5a: the signing intent carries the letter’s digest; the instruction carries the IBAN', () => {
  const digest = 'a'.repeat(64);
  it('UAE Pass: a signing intent with a document hash sends it as a SHA-256 digest entry', async () => {
    const t = transport(
      answer(
        'signature.start',
        { id: 'sp-2', status: 'active', tasks: { pending: [{ id: 't-1', url: 'https://sign.example/sp-2' }] } },
        { documents: [{ name: 'offer-letter', digest: { algorithm: 'SHA-256', value: digest } }] },
      ),
    );
    const r = expectOk(
      await uaePass(t).startAuthentication({
        tenantId: 'sme-fund-ae',
        applicantRef: 'app-1',
        purpose: 'SIGNATURE_INTENT',
        documentHash: digest,
        correlationId: 'c',
      }),
    );
    expect(r.kind).toBe('ANSWERED');
    // The fixture answers only a body that carries the digest: without it, no answer.
    const without = await uaePass(
      transport(
        answer(
          'signature.start',
          { id: 'sp-2', status: 'active', tasks: { pending: [{ id: 't-1' }] } },
          { documents: [{ name: 'offer-letter', digest: { algorithm: 'SHA-256', value: digest } }] },
        ),
      ),
    ).startAuthentication({ tenantId: 'sme-fund-ae', applicantRef: 'app-1', purpose: 'SIGNATURE_INTENT', correlationId: 'c' });
    expect(without.ok && without.value.kind === 'ANSWERED').toBe(false);
  });
  it('Partner bank: a disbursement to an IBAN names it as the creditor account (CdtrAcct/Id/IBAN)', async () => {
    const t = transport(
      answer('payments.disburse', statusReport('k-d', { TxSts: 'ACCP' }), {
        Cdtr: { Ref: 'ben-1' },
        CdtrAcct: { Id: { IBAN: 'AE070331234567890123456' } },
      }),
    );
    const r = expectOk(await bank(t).disburse({ ...disbursement, beneficiaryAccount: { iban: 'AE070331234567890123456' } }));
    expect(r.kind).toBe('ANSWERED');
  });
});
