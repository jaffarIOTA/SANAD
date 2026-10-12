/**
 * The UAE demonstration transport, through the real adapters.
 *
 * Every operation a UAE adapter makes is answered in that adapter's assumed
 * contract (nothing malformed, nothing left to a 501); a cast company answers
 * the same way on every rail — the register's people are the bureau's
 * subjects, the WPS establishment pays the payroll the bank shows, the TRN is
 * the register's — and the documented steering prefixes do what they say.
 */
import { describe, expect, it } from 'vitest';

import { type RailEnvelope, type RailTransport, TransportError } from '../../adapters/kernel/http-transport.ts';
import type { RailAdapterConfig } from '../../adapters/kernel/rail-adapter.ts';
import { AecbAdapter } from '../../adapters/uae/aecb/adapter.ts';
import { CAST, bankHistory, castCompany } from '../../adapters/uae/demonstration/cast.ts';
import { DEMONSTRATION_OPERATIONS, DemonstrationTransport } from '../../adapters/uae/demonstration/transport.ts';
import { FtaAdapter } from '../../adapters/uae/fta/adapter.ts';
import { IcpAdapter } from '../../adapters/uae/icp/adapter.ts';
import { MohreAdapter } from '../../adapters/uae/mohre/adapter.ts';
import { NerAdapter } from '../../adapters/uae/ner/adapter.ts';
import { OpenFinanceAdapter } from '../../adapters/uae/open-finance/adapter.ts';
import { PartnerBankAdapter } from '../../adapters/uae/partner-bank/adapter.ts';
import { UaePassAdapter } from '../../adapters/uae/uae-pass/adapter.ts';
import { inMemoryAssertionReplayGuard } from '../../core/ports/assertion-replay.ts';
import { type CredentialProvider, SecretValue } from '../../core/ports/credentials.ts';
import type { EmploymentVerificationPort } from '../../core/ports/employment-verification.ts';
import type { IdentityAuthenticationPort } from '../../core/ports/identity-authentication.ts';
import type { IdentityVerificationPort } from '../../core/ports/identity-verification.ts';
import type { PaymentsPort } from '../../core/ports/payments.ts';
import type { TaxCompliancePort } from '../../core/ports/tax-compliance.ts';
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import { tsaInstant } from '../../core/time/tsa.ts';
import { grantingLedger } from '../support/consents.ts';

const NOW = 1_800_000_000;
const TENANT = 'sme-fund-ae';
const CONSENTS = [
  'cns',
  'of-CN-1001001',
  'of-DXB-2002002',
  'of-SHJ-3003003',
  'of-demo-oasis-manager-1',
  'of-generic',
  'of-revoked',
];

/** Records which operations the adapters made, over the real demonstration transport. */
class Recording implements RailTransport {
  readonly operations = new Set<string>();
  readonly urls: string[] = [];
  readonly inner = new DemonstrationTransport(() => NOW);
  call(operation: string, envelope: RailEnvelope): Promise<Readonly<Record<string, unknown>>> {
    this.operations.add(operation);
    this.urls.push(envelope.url);
    return this.inner.call(operation, envelope);
  }
}
const credentials: CredentialProvider = { get: () => Promise.resolve(new SecretValue('demonstration')) };
const config = (provider: RailAdapterConfig['provider']): RailAdapterConfig => ({
  tenantId: TENANT,
  provider,
  environment: 'sandbox',
  freshnessWindowSeconds: 0,
  failurePosture: 'FAIL_CLOSED',
  credentialTtlSeconds: 600,
  breaker: { failureThreshold: 50, resetAfterSeconds: 30, successThreshold: 1 },
  nowEpochSeconds: () => NOW,
  baseUrl: 'https://demonstration.invalid',
  consents: grantingLedger(TENANT, CONSENTS),
  assertionReplay: inMemoryAssertionReplayGuard(),
});
const at = tsaInstant({ verified: true, genTimeEpochSeconds: 1n, tokenDigest: 't', authorityId: 'test' });

/** The adapters, typed by the ports they serve (MOHRE and AECB keep their adapter-only methods). */
function rails(t: RailTransport = new Recording()) {
  const icp: IdentityVerificationPort = new IcpAdapter(config('IDENTITY_VERIFICATION'), credentials, t);
  const fta: TaxCompliancePort = new FtaAdapter(config('TAX_COMPLIANCE'), credentials, t);
  const pass: IdentityAuthenticationPort = new UaePassAdapter(config('IDENTITY_AUTHENTICATION'), credentials, t);
  const bank: PaymentsPort = new PartnerBankAdapter(config('PAYMENTS_HUB'), credentials, t);
  return {
    t,
    ner: new NerAdapter(config('BUSINESS_REGISTRY'), credentials, t),
    icp,
    aecb: new AecbAdapter(config('CREDIT_BUREAU'), credentials, t, () => Promise.resolve(at)),
    fta,
    mohre: new MohreAdapter(config('EMPLOYMENT_VERIFICATION'), credentials, t),
    pass,
    bank,
    of: new OpenFinanceAdapter(config('OPEN_BANKING'), credentials, t),
  };
}
type Rails = ReturnType<typeof rails>;
const c = 'corr-1';

const registry = (r: Rails, licence: string) =>
  r.ner.lookup({ tenantId: TENANT, commercialRegistration: licence, correlationId: c });
const verify = (r: Rails, ref: string): ReturnType<IdentityVerificationPort['verify']> =>
  r.icp.verify({ tenantId: TENANT, applicantRef: ref, consentId: 'cns', correlationId: c });
const company = (r: Rails, licence: string) =>
  r.aecb.request({
    tenantId: TENANT,
    counterpartyId: 'cp',
    commercialRegistration: licence,
    consentId: 'cns',
    correlationId: c,
  });
const person = (r: Rails, ref: string) =>
  r.aecb.requestIndividual({ tenantId: TENANT, applicantRef: ref, consentId: 'cns', correlationId: c });
const tax = (r: Rails, key: string) => r.fta.certificateStatus({ tenantId: TENANT, crNumber: key, correlationId: c });
const employment = (r: Rails, ref: string): ReturnType<EmploymentVerificationPort['employment']> =>
  r.mohre.employment({ tenantId: TENANT, applicantRef: ref, consentId: 'cns', correlationId: c });
const establishment = (r: Rails, licence: string) =>
  r.mohre.establishmentCompliance({ tenantId: TENANT, tradeLicence: licence, consentId: 'cns', correlationId: c });
const affordability = (r: Rails, consentId: string, months = 12) =>
  r.of.affordabilityFacts({ tenantId: TENANT, applicantRef: 'a', consentId, months, correlationId: c });
async function login(r: Rails, ref: string, purpose: 'LOGIN' | 'STEP_UP' | 'SIGNATURE_INTENT' = 'LOGIN') {
  const started = expectOk(
    await r.pass.startAuthentication({ tenantId: TENANT, applicantRef: ref, purpose, correlationId: c }),
  );
  if (started.kind !== 'ANSWERED') return started;
  return expectOk(
    await r.pass.confirmAuthentication({
      tenantId: TENANT,
      transactionRef: started.value.transactionRef,
      correlationId: c,
    }),
  );
}
const disburse = (r: Rails, reference: string): ReturnType<PaymentsPort['disburse']> =>
  r.bank.disburse({
    tenantId: TENANT,
    beneficiaryRef: 'ben',
    amount: money(1_000_000n, 'AED'),
    purposeCode: 'LOA',
    reference,
    idempotencyKey: `k-${reference}`,
    correlationId: c,
  });
const collect = (r: Rails, reference: string): ReturnType<PaymentsPort['collect']> =>
  r.bank.collect({
    tenantId: TENANT,
    payerRef: 'p',
    amount: money(500_000n, 'AED'),
    reference,
    idempotencyKey: `k-${reference}`,
    correlationId: c,
  });

describe('every UAE operation is answered, in the adapter’s assumed contract', () => {
  it('walks every rail through the real adapters and touches every demonstration rule, with nothing malformed', async () => {
    const t = new Recording();
    const r = rails(t);
    const outcomes = [
      await registry(r, 'CN-1001001'),
      await verify(r, 'demo-falcon-owner-1'),
      await company(r, 'CN-1001001'),
      await person(r, 'demo-falcon-owner-1'),
      await r.aecb.report({
        tenantId: TENANT,
        facilityRef: 'f',
        counterpartyId: 'cp',
        event: 'OPENED',
        amount: money(1n, 'AED'),
        asOfEpochSeconds: 1n,
        idempotencyKey: 'k',
        correlationId: c,
      }),
      await tax(r, '100100100100003'),
      await employment(r, 'demo-oasis-manager-1'),
      await establishment(r, 'DXB-2002002'),
      await disburse(r, 'disb-1'),
      await collect(r, 'inst-1'),
      await affordability(r, 'of-CN-1001001'),
    ];
    for (const o of outcomes) expect(o.ok && 'kind' in o.value && o.value.kind).not.toBe('UNAVAILABLE');
    expect((await login(r, 'demo-falcon-owner-1')).kind).toBe('ANSWERED');
    expect((await login(r, 'demo-falcon-owner-1', 'SIGNATURE_INTENT')).kind).toBe('ANSWERED');
    expect([...t.operations].sort()).toEqual(Object.keys(DEMONSTRATION_OPERATIONS).sort());
  });
  it('says plainly when an operation has no rule', async () => {
    const call = new DemonstrationTransport().call('nothing.here', {
      method: 'GET',
      url: 'https://demonstration.invalid/x',
      headers: {},
    });
    await expect(call).rejects.toBeInstanceOf(TransportError);
    await expect(call).rejects.toMatchObject({ status: 501 });
  });
  it('keeps the references the intake records: ner-demo-<licence> and icp-demo-<party>', async () => {
    const r = rails();
    const reg = expectOk(await registry(r, 'CN-7654321'));
    expect(reg.kind === 'ANSWERED' && reg.value.lookupRef).toBe('ner-demo-CN-7654321');
    const id = expectOk(await verify(r, 'party-a'));
    expect(id.kind === 'ANSWERED' && id.value.verificationRef).toBe('icp-demo-party-a');
  });
});

describe('a cast company answers consistently across every rail', () => {
  it.each(CAST.map((co) => [co.nameEn, co] as const))('%s', async (_name, co) => {
    const r = rails();
    // The register: names, activities, and its people as references.
    const reg = expectOk(await registry(r, co.licence));
    expect(reg.kind).toBe('ANSWERED');
    if (reg.kind !== 'ANSWERED') return;
    expect(reg.value).toMatchObject({
      legalNameEn: co.nameEn,
      legalNameAr: co.nameAr,
      status: 'ACTIVE',
      registeredAtGregorian: co.incorporatedOn,
    });
    expect(reg.value.activityCodes).toEqual(co.isic4.map((a) => a.code));
    expect(reg.value.paidCapitalMinorUnits).toBe(co.shareCapitalMinor);
    expect([...reg.value.signatoryRefs].sort()).toEqual(co.parties.map((p) => p.ref).sort());

    // Tax: the register's company is VAT-registered under its TRN, by TRN or by licence.
    for (const key of [co.trn, co.licence])
      expect(expectOk(await tax(r, key))).toMatchObject({ kind: 'ANSWERED', value: { status: 'VALID' } });

    // Every person on the register verifies, has a bureau answer, and is the same UAE Pass subject for login and signing.
    for (const p of co.parties) {
      expect(expectOk(await verify(r, p.ref))).toMatchObject({
        kind: 'ANSWERED',
        value: { verified: true, mismatches: [] },
      });
      const file = expectOk(await person(r, p.ref));
      expect(file.kind).toBe(p.bureau.found ? 'REPORT' : 'NO_RECORD');
      if (file.kind === 'REPORT') expect(file.summary.bureauScore).toBe(p.bureau.score);
      const logged = await login(r, p.ref);
      const signed = await login(r, p.ref, 'SIGNATURE_INTENT');
      expect(
        logged.kind === 'ANSWERED' &&
          signed.kind === 'ANSWERED' &&
          logged.value.identityRef === signed.value.identityRef,
      ).toBe(true);
    }

    // The bureau's commercial file is the cast's.
    const file = expectOk(await company(r, co.licence));
    expect(file.kind).toBe(co.bureau.found ? 'REPORT' : 'NO_RECORD');
    if (file.kind === 'REPORT') {
      const open = co.bureau.contracts.filter(
        (k) => k.role !== 'GUARANTOR' && k.status !== 'CLOSED' && k.status !== 'SETTLED',
      );
      expect(file.summary.bureauScore).toBe(co.bureau.score);
      expect(file.summary.totalExposure.minorUnits).toBe(open.reduce((s, k) => s + k.outstandingMinor, 0n));
      expect(file.summary.activeFacilities).toBe(open.length);
    }

    // WPS: the establishment's fully paid month is the payroll the bank statement shows.
    const wps = expectOk(await establishment(r, co.licence));
    expect(wps.kind).toBe('ANSWERED');
    const payroll = co.bank.monthly.find((m) => m.kind === 'PAYROLL')?.amountMinor;
    if (wps.kind === 'ANSWERED') {
      expect(wps.value.establishmentRef).toBe(co.wps.establishmentRef);
      const full = wps.value.months.find((m) => m.employeesPaid === m.employeesDue);
      expect(full?.totalPaid.minorUnits).toBe(payroll);
    }

    // Open Finance: the bank's revenue, read through the published API, is the cast's statement.
    const facts = expectOk(await affordability(r, `of-${co.licence}`));
    expect(facts.kind).toBe('ANSWERED');
    if (facts.kind === 'ANSWERED') {
      const lines = bankHistory(co.bank).lines.filter((l) => l.date < '2027-01');
      const revenue = lines.filter((l) => l.kind === 'REVENUE').reduce((s, l) => s + l.amountMinor, 0n);
      expect(facts.value.averageMonthlyInflow).toEqual({ minorUnits: revenue / 12n, currency: 'AED' });
      expect(facts.value.returnedPaymentsLast6Months).toBe(co.bank.returnedMonths.filter((m) => m >= '2026-07').length);
      expect(facts.value.salaryCreditsObserved).toBe(0);
      expect(facts.value.retrievedAtEpochSeconds).toBe(BigInt(NOW));
      expect(facts.value.lowestMonthEndBalance.minorUnits).toBeGreaterThan(0n);
    }
  });

  it('the Oasis manager is a WPS employee of Oasis, paid the fixed salary the cast holds, with twelve salary credits in his account', async () => {
    const r = rails();
    const oasis = castCompany('DXB-2002002');
    const manager = oasis?.parties.find((p) => p.ref === 'demo-oasis-manager-1');
    const job = expectOk(await employment(r, 'demo-oasis-manager-1'));
    expect(job).toMatchObject({
      kind: 'ANSWERED',
      value: {
        employed: true,
        employerRef: oasis?.wps.establishmentRef,
        registeredSalary: { minorUnits: manager?.salary?.fixedMinor, currency: 'AED' },
      },
    });
    const facts = expectOk(await affordability(r, 'of-demo-oasis-manager-1'));
    expect(facts).toMatchObject({ kind: 'ANSWERED', value: { salaryCreditsObserved: 12 } });
    // An owner who is not on the payroll has no WPS record.
    expect(expectOk(await employment(r, 'demo-oasis-owner-1'))).toEqual({ kind: 'REFUSED', code: 'HTTP_404' });
  });

  it('Oasis paid 11 of 14 in November (below 85%) and 13 of 14 in December; Falcon’s USD account is left out of its affordability', async () => {
    const r = rails();
    const wps = expectOk(await establishment(r, 'DXB-2002002'));
    if (wps.kind !== 'ANSWERED') throw new Error('expected an answer');
    expect(wps.value.months.find((m) => m.payMonth === '2026-11')?.compliant).toBe(false);
    expect(wps.value.compliantLatestMonth).toBe(true);
    const t = new Recording();
    await affordability(rails(t), 'of-CN-1001001');
    expect(t.urls.filter((u) => u.includes('/balances'))).toEqual([
      'https://demonstration.invalid/accounts/acc-demo-falcon/balances',
    ]);
    // Twelve months of history read in pages of fifty: the transport paginates and the adapter follows.
    expect(t.urls.filter((u) => u.includes('page=2'))).toHaveLength(1);
  });
});

describe('the steering rules do what transport.ts documents', () => {
  it('licences: UNK- unknown everywhere, EXP- expired, SUS- suspended, DEF- defaulted, LATE- late payroll, DEREG- deregistered', async () => {
    const r = rails();
    expect(expectOk(await registry(r, 'UNK-1'))).toEqual({ kind: 'REFUSED', code: 'NOT_FOUND' });
    expect(expectOk(await company(r, 'UNK-1')).kind).toBe('NO_RECORD');
    expect(expectOk(await tax(r, 'UNK-1'))).toMatchObject({ value: { status: 'NOT_FOUND' } });
    expect(expectOk(await registry(r, 'EXP-1'))).toMatchObject({ value: { status: 'EXPIRED' } });
    expect(expectOk(await registry(r, 'SUS-1'))).toMatchObject({ value: { status: 'SUSPENDED' } });
    const def = expectOk(await company(r, 'DEF-1'));
    expect(def.kind === 'REPORT' && def.summary.bureauScore).toBe(412);
    expect(def.kind === 'REPORT' && def.summary.defaults.filter((d) => !d.settled)).toHaveLength(2);
    const late = expectOk(await establishment(r, 'LATE-1'));
    expect(late.kind === 'ANSWERED' && late.value.compliantLatestMonth).toBe(false);
    expect(expectOk(await tax(r, 'DEREG-1'))).toMatchObject({ value: { status: 'EXPIRED' } });
    expect(expectOk(await tax(r, '900000000000003'))).toMatchObject({ value: { status: 'NOT_FOUND' } });
    expect(expectOk(await registry(r, 'CN-5555555'))).toMatchObject({ value: { status: 'ACTIVE' } });
  });
  it('parties: mismatch, expired, default, nohit, unemployed', async () => {
    const r = rails();
    expect(expectOk(await verify(r, 'party-mismatch'))).toMatchObject({
      value: { verified: false, mismatches: ['name'] },
    });
    expect(expectOk(await verify(r, 'party-expired'))).toMatchObject({
      value: { verified: false, mismatches: ['card_status'] },
    });
    const d = expectOk(await person(r, 'party-default'));
    expect(d.kind === 'REPORT' && d.summary.defaults.length).toBe(1);
    expect(expectOk(await person(r, 'party-nohit')).kind).toBe('NO_RECORD');
    expect(expectOk(await employment(r, 'party-unemployed'))).toMatchObject({ value: { employed: false } });
  });
  it('UAE Pass: basic may log in but not sign; reject, pending and fail are refusals', async () => {
    const r = rails();
    expect((await login(r, 'party-basic')).kind).toBe('ANSWERED');
    expect(await login(r, 'party-basic', 'SIGNATURE_INTENT')).toEqual({
      kind: 'REFUSED',
      code: 'ASSURANCE_INSUFFICIENT',
    });
    expect(await login(r, 'party-basic', 'STEP_UP')).toEqual({ kind: 'REFUSED', code: 'ASSURANCE_INSUFFICIENT' });
    expect(await login(r, 'party-reject')).toEqual({ kind: 'REFUSED', code: 'STATUS_REJECTED' });
    expect(await login(r, 'party-reject', 'SIGNATURE_INTENT')).toEqual({ kind: 'REFUSED', code: 'STATUS_CANCELED' });
    expect(await login(r, 'party-pending')).toEqual({ kind: 'REFUSED', code: 'STATUS_PENDING' });
    expect(await login(r, 'party-fail', 'SIGNATURE_INTENT')).toEqual({ kind: 'REFUSED', code: 'STATUS_FAILED' });
  });
  it('payments: reject, pending, settled and a returned collection', async () => {
    const r = rails();
    const status = async (p: ReturnType<typeof disburse> | ReturnType<typeof collect>) => {
      const o = expectOk(await p);
      return o.kind === 'ANSWERED' ? o.value.status : o.kind;
    };
    expect(await status(disburse(r, 'disb-reject'))).toBe('REJECTED');
    expect(await status(disburse(r, 'disb-pending'))).toBe('ACCEPTED');
    expect(await status(disburse(r, 'disb-settled'))).toBe('SETTLED');
    expect(await status(disburse(r, 'disb-plain'))).toBe('ACCEPTED');
    expect(await status(collect(r, 'inst-plain'))).toBe('SETTLED');
    expect(await status(collect(r, 'inst-return'))).toBe('RETURNED');
  });
  it('Open Finance: a revoked consent is refused; any other consent reads a generic SME account', async () => {
    const r = rails();
    expect(expectOk(await affordability(r, 'of-revoked'))).toEqual({ kind: 'REFUSED', code: 'CONSENT_REVOKED' });
    expect(expectOk(await affordability(r, 'of-generic', 6)).kind).toBe('ANSWERED');
  });
});
