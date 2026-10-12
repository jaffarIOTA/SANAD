/**
 * The KSA demonstration transport, through the real adapters.
 *
 * Every operation a Saudi adapter calls is answered, in the shape that
 * adapter maps, so a synthetic end-to-end Saudi demonstration runs the same
 * mapping, consent and refusal code the live rails will; the synthetic cast
 * answers consistently from rail to rail (the registered wage GOSI reports is
 * the payroll credit the bank shows, the registry's managers are the people
 * the bureau and identity rails know); the documented steering rules produce
 * the failure paths; and no synthetic identity number crosses an adapter.
 */
import { describe, expect, it } from 'vitest';

import type { RailEnvelope, RailTransport } from '../../adapters/kernel/http-transport.ts';
import type { RailAdapterConfig } from '../../adapters/ksa/kernel/rail-adapter.ts';
import { BayanAdapter } from '../../adapters/ksa/bayan/adapter.ts';
import { CommodityBrokerAdapter } from '../../adapters/ksa/commodity-broker/adapter.ts';
import { CAST_COMPANIES, CAST_PEOPLE, castCompany } from '../../adapters/ksa/demonstration/cast.ts';
import {
  DEMO_SADAD_BILLER_ID,
  KSA_DEMONSTRATION_RULES,
  KsaDemonstrationTransport,
} from '../../adapters/ksa/demonstration/transport.ts';
import { GosiAdapter } from '../../adapters/ksa/gosi/adapter.ts';
import { NafathAdapter } from '../../adapters/ksa/nafath/adapter.ts';
import { OpenBankingAdapter } from '../../adapters/ksa/open-banking/adapter.ts';
import { PaymentsHubAdapter } from '../../adapters/ksa/payments-hub/adapter.ts';
import { RatePublisherAdapter } from '../../adapters/ksa/rate-publisher/adapter.ts';
import { SadadAdapter } from '../../adapters/ksa/sadad/adapter.ts';
import { SimahAdapter } from '../../adapters/ksa/simah/adapter.ts';
import { TahaqoqAdapter } from '../../adapters/ksa/tahaqoq/adapter.ts';
import { WathqAdapter } from '../../adapters/ksa/wathq/adapter.ts';
import { YakeenAdapter } from '../../adapters/ksa/yakeen/adapter.ts';
import { ZatcaEInvoicingAdapter } from '../../adapters/ksa/zatca-einvoicing/adapter.ts';
import { ZatcaTaxAdapter } from '../../adapters/ksa/zatca-tax/adapter.ts';
import { money } from '../../core/kernel/money.ts';
import { expectOk } from '../../core/kernel/result.ts';
import type { AccountInformationPort } from '../../core/ports/account-information.ts';
import { inMemoryAssertionReplayGuard } from '../../core/ports/assertion-replay.ts';
import type { BillCollectionPort } from '../../core/ports/bill-collection.ts';
import type { BusinessRegistryPort } from '../../core/ports/business-registry.ts';
import type { CommodityBrokerPort } from '../../core/ports/commodity-broker.ts';
import { type CredentialProvider, SecretValue } from '../../core/ports/credentials.ts';
import type { CreditBureauPort } from '../../core/ports/credit-bureau.ts';
import type { DocumentVerificationPort } from '../../core/ports/document-verification.ts';
import type { EInvoicingProvider } from '../../core/ports/e-invoicing.ts';
import type { EmploymentVerificationPort } from '../../core/ports/employment-verification.ts';
import type { IdentityAuthenticationPort } from '../../core/ports/identity-authentication.ts';
import type { IdentityVerificationPort } from '../../core/ports/identity-verification.ts';
import type { PaymentInitiationPort } from '../../core/ports/payment-initiation.ts';
import type { PaymentsPort } from '../../core/ports/payments.ts';
import type { RatePublisherPort } from '../../core/ports/rate-publisher.ts';
import type { TaxCompliancePort } from '../../core/ports/tax-compliance.ts';
import { tsaInstant } from '../../core/time/tsa.ts';
import { grantingLedger } from '../support/consents.ts';

const NOW = 1_800_000_000;
const at = tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(NOW), tokenDigest: 't', authorityId: 'test' });
const attest = () => Promise.resolve(at);

class Credentials implements CredentialProvider {
  get(): Promise<SecretValue> {
    return Promise.resolve(new SecretValue('demonstration-transport-needs-no-credential'));
  }
}

/** The demonstration transport, recording which operations it answered and what it answered. */
class Recording implements RailTransport {
  readonly operations = new Set<string>();
  readonly answers: unknown[] = [];
  readonly #inner = new KsaDemonstrationTransport(() => NOW);
  async call(operation: string, envelope: RailEnvelope) {
    this.operations.add(operation);
    const answer = await this.#inner.call(operation, envelope);
    this.answers.push(answer);
    return answer;
  }
}

function rails(t: RailTransport = new Recording()) {
  const cfg = (provider: RailAdapterConfig['provider']): RailAdapterConfig => ({
    tenantId: 'bank-a',
    provider,
    environment: 'sandbox',
    freshnessWindowSeconds: 0,
    failurePosture: 'FAIL_CLOSED',
    credentialTtlSeconds: 600,
    breaker: { failureThreshold: 50, resetAfterSeconds: 30, successThreshold: 1 },
    nowEpochSeconds: () => NOW,
    baseUrl: 'https://rail.demo.example',
    consents: grantingLedger('bank-a', ['cns']),
    assertionReplay: inMemoryAssertionReplayGuard(),
  });
  const c = new Credentials();
  return {
    nafath: new NafathAdapter(cfg('IDENTITY_AUTHENTICATION'), c, t) as IdentityAuthenticationPort,
    yakeen: new YakeenAdapter(cfg('IDENTITY_VERIFICATION'), c, t) as IdentityVerificationPort,
    wathq: new WathqAdapter(cfg('BUSINESS_REGISTRY'), c, t) as BusinessRegistryPort,
    simah: new SimahAdapter(cfg('CREDIT_BUREAU'), c, t, attest) as CreditBureauPort,
    bayan: new BayanAdapter(cfg('CREDIT_BUREAU'), c, t, attest) as CreditBureauPort,
    gosi: new GosiAdapter(cfg('EMPLOYMENT_VERIFICATION'), c, t) as EmploymentVerificationPort,
    zakat: new ZatcaTaxAdapter(cfg('TAX_COMPLIANCE'), c, t) as TaxCompliancePort,
    fatoora: new ZatcaEInvoicingAdapter(cfg('E_INVOICING'), c, t) as EInvoicingProvider,
    ob: new OpenBankingAdapter(cfg('OPEN_BANKING'), c, t) as AccountInformationPort & PaymentInitiationPort,
    sadad: new SadadAdapter(cfg('BILL_COLLECTION'), c, t, DEMO_SADAD_BILLER_ID) as BillCollectionPort,
    hub: new PaymentsHubAdapter(cfg('PAYMENTS_HUB'), c, t) as PaymentsPort,
    tahaqoq: new TahaqoqAdapter(cfg('DOCUMENT_VERIFICATION'), c, t) as DocumentVerificationPort,
    rates: new RatePublisherAdapter(cfg('RATE_PUBLISHER'), c, t) as RatePublisherPort,
    broker: new CommodityBrokerAdapter(cfg('COMMODITY_BROKER'), c, t) as CommodityBrokerPort,
  };
}

const base = { tenantId: 'bank-a', correlationId: 'demo-1' } as const;
const consented = { ...base, consentId: 'cns' } as const;
const plain = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
const bureauFor = (port: CreditBureauPort, commercialRegistration: string, counterpartyId = 'cp-demo') =>
  port.request({ ...consented, commercialRegistration, counterpartyId }).then(expectOk);

describe('the KSA demonstration transport answers every operation the Saudi adapters call', () => {
  it('each adapter operation is answered, and answered in the shape its adapter maps', async () => {
    const t = new Recording();
    const r = rails(t);
    const person = 'ksa-demo-person-a';
    const company = '1010000101';
    const results: { kind?: string; ok?: boolean }[] = [];
    const push = (x: unknown) => results.push(x as { kind?: string });

    const started = expectOk(await r.nafath.startAuthentication({ ...base, applicantRef: person, purpose: 'LOGIN' }));
    push(started);
    if (started.kind !== 'ANSWERED') throw new Error('Nafath did not start');
    push(expectOk(await r.nafath.confirmAuthentication({ ...base, transactionRef: started.value.transactionRef })));
    push(expectOk(await r.yakeen.verify({ ...consented, applicantRef: person })));
    push(expectOk(await r.wathq.lookup({ ...base, commercialRegistration: company })));
    push(await bureauFor(r.simah, company));
    push(await bureauFor(r.bayan, company));
    for (const port of [r.simah, r.bayan])
      push(
        expectOk(
          await port.report({
            ...base,
            facilityRef: 'f-1',
            counterpartyId: 'cp',
            event: 'OPENED',
            amount: money(100_000n),
            asOfEpochSeconds: BigInt(NOW),
            idempotencyKey: 'k-report',
          }),
        ),
      );
    push(expectOk(await r.gosi.employment({ ...consented, applicantRef: person })));
    push(expectOk(await r.zakat.certificateStatus({ ...base, crNumber: company })));
    const invoice = expectOk(
      await r.fatoora.validateInvoice('bank-a', { invoiceUuid: 'uuid-1', invoiceHash: 'h-1' }, 'c'),
    );
    expect(invoice.clearanceStatus).toBe('CLEARED');
    const history = expectOk(
      await r.fatoora.fetchTradeHistory(
        'bank-a',
        company,
        { fromDateGregorian: '2026-01-01', toDateGregorian: '2026-12-31' },
        'c',
      ),
    );
    expect(history.distinctBuyerCount).toBe(2);
    push(expectOk(await r.ob.affordabilityFacts({ ...consented, applicantRef: person, months: 12 })));
    const pis = expectOk(
      await r.ob.initiate({
        ...consented,
        applicantRef: person,
        amount: money(310_000n),
        direction: 'COLLECT',
        reference: 'inst-1',
        idempotencyKey: 'k-pis',
      }),
    );
    push(pis);
    if (pis.kind === 'ANSWERED')
      push(expectOk(await r.ob.status({ ...base, instructionRef: pis.value.instructionRef })));
    push(
      expectOk(
        await r.sadad.present({
          ...base,
          obligationRef: 'DEMO-OBL-0009',
          payerRef: person,
          amount: money(310_000n),
          dueDateGregorian: '2027-02-01',
          idempotencyKey: 'k-bill',
        }),
      ),
    );
    push(expectOk(await r.sadad.paid({ ...base, sinceEpochSeconds: BigInt(NOW - 7 * 86_400) })));
    push(
      expectOk(
        await r.hub.disburse({
          ...base,
          beneficiaryRef: 'ben-1',
          amount: money(5_000_000n),
          purposeCode: 'LOAN',
          reference: 'disb-1',
          idempotencyKey: 'k-disb',
        }),
      ),
    );
    push(
      expectOk(
        await r.hub.collect({
          ...base,
          payerRef: person,
          amount: money(310_000n),
          reference: 'coll-1',
          idempotencyKey: 'k-coll',
        }),
      ),
    );
    push(
      expectOk(
        await r.tahaqoq.verifyDocument({
          ...consented,
          applicantRef: person,
          documentType: 'COMMERCIAL_REGISTRATION',
          documentRef: 'doc-1',
        }),
      ),
    );
    const benchmark = expectOk(await r.rates.benchmark('SAIBOR-3M', at));
    const market = expectOk(await r.rates.marketRates('PERSONAL_FINANCE', at));
    expect([benchmark.kind, market.kind]).toEqual(['PUBLISHED', 'PUBLISHED']);
    const lot = expectOk(
      await r.broker.purchase({
        ...base,
        brokerRef: 'br',
        commodityCode: 'LME-AL',
        amount: money(5_000_000n),
        idempotencyKey: 'k-lot',
      }),
    );
    push(lot);
    if (lot.kind === 'ANSWERED') {
      push(expectOk(await r.broker.transferTitle({ ...base, lotRef: lot.value.lotRef, toPartyRef: person })));
      const sale = expectOk(
        await r.broker.sellOnBehalf({
          ...base,
          lotRef: lot.value.lotRef,
          onBehalfOfPartyRef: person,
          idempotencyKey: 'k-sale',
        }),
      );
      push(sale);
      expect(sale.kind === 'ANSWERED' && sale.value.proceeds.minorUnits).toBe(5_000_000n);
    }

    expect(
      results.map((x) => x.kind).filter((k) => k !== 'ANSWERED' && k !== 'REPORT' && k !== 'ACKNOWLEDGED'),
    ).toEqual([]);
    expect([...t.operations].sort()).toEqual(Object.keys(KSA_DEMONSTRATION_RULES).sort());
  });

  it('says plainly when an operation has no rule, and the adapter reads that as UNAVAILABLE', async () => {
    await expect(
      new KsaDemonstrationTransport(() => NOW).call('no.such.operation', {
        method: 'GET',
        url: 'https://x/y',
        headers: {},
      }),
    ).rejects.toMatchObject({ status: 501 });
    await expect(
      new KsaDemonstrationTransport(() => NOW).call('constructor', { method: 'GET', url: 'https://x/y', headers: {} }),
    ).rejects.toMatchObject({ status: 501 });
  });

  it('answers deterministically: the same question twice is the same answer', async () => {
    const a = rails();
    const b = rails();
    for (const company of CAST_COMPANIES) {
      expect(plain(await a.wathq.lookup({ ...base, commercialRegistration: company.crNumber }))).toBe(
        plain(await b.wathq.lookup({ ...base, commercialRegistration: company.crNumber })),
      );
      expect(plain(await bureauFor(a.simah, company.crNumber))).toBe(plain(await bureauFor(b.simah, company.crNumber)));
    }
  });
});

describe('the synthetic cast answers consistently across the rails', () => {
  it.each(CAST_COMPANIES.map((c) => [c.nameEn, c] as const))('%s', async (_name, company) => {
    const r = rails();
    const byCr = expectOk(await r.wathq.lookup({ ...base, commercialRegistration: company.crNumber }));
    const byNational = expectOk(await r.wathq.lookup({ ...base, commercialRegistration: company.crNationalNumber }));
    expect(byCr.kind).toBe('ANSWERED');
    if (byCr.kind !== 'ANSWERED' || byNational.kind !== 'ANSWERED') return;
    expect(byCr.value).toMatchObject({ legalNameAr: company.nameAr, legalNameEn: company.nameEn, status: 'ACTIVE' });
    expect(byNational.value.legalNameAr).toBe(byCr.value.legalNameAr);
    expect(byCr.value.signatoryRefs).toHaveLength(company.managerRefs.length);
    expect(byCr.value.activityCodes).toEqual(company.activities.map((a) => a.id));

    // The bureau knows the company, and a flagged company carries an unsettled default.
    for (const bureau of [r.simah, r.bayan]) {
      const report = await bureauFor(bureau, company.crNumber);
      expect(report.kind).toBe('REPORT');
      if (report.kind !== 'REPORT') continue;
      expect(report.summary.bureauScore).toBe(company.bureau.score);
      expect(report.summary.defaults.some((d) => !d.settled)).toBe(company.bureauDefault);
    }

    // The zakat certificate is the company's own, in the state the cast gives it.
    const zakat = expectOk(await r.zakat.certificateStatus({ ...base, crNumber: company.crNumber }));
    expect(zakat).toMatchObject({
      kind: 'ANSWERED',
      value: { status: company.zakat.state, certificateRef: company.zakat.certificateNumber },
    });

    // Each manager and owner is a person every person-rail knows.
    for (const ref of new Set([...company.ownerRefs, ...company.managerRefs])) {
      expect(expectOk(await r.yakeen.verify({ ...consented, applicantRef: ref }))).toMatchObject({
        kind: 'ANSWERED',
        value: { verified: true },
      });
    }
  });

  it.each(CAST_PEOPLE.map((p) => [p.displayNameEn, p] as const))('%s', async (_name, person) => {
    const r = rails();
    const employment = expectOk(await r.gosi.employment({ ...consented, applicantRef: person.ref }));
    const affordability = expectOk(
      await r.ob.affordabilityFacts({ ...consented, applicantRef: person.ref, months: 12 }),
    );
    expect(employment.kind).toBe('ANSWERED');
    expect(affordability.kind).toBe('ANSWERED');
    if (employment.kind !== 'ANSWERED' || affordability.kind !== 'ANSWERED') return;

    // The employer GOSI names is a cast company the person owns or manages, or works for.
    const establishment = employment.value.employerRef?.replace('gosi-establishment:', '');
    const employer = CAST_COMPANIES.find((c) => c.establishmentNumber === establishment);
    expect(employer).toBeDefined();

    // The wage GOSI registers is the payroll credit the bank shows every month.
    expect(affordability.value.salaryCreditsObserved).toBe(12);
    expect(affordability.value.averageMonthlyInflow.minorUnits).toBe(employment.value.registeredSalary?.minorUnits);
    expect(affordability.value.returnedPaymentsLast6Months).toBe(person.bank.rejectedDebitsLast6Months);

    // The bureau's consumer file for the person, by member reference.
    const bureau = await bureauFor(r.simah, CAST_COMPANIES[0]?.crNumber ?? '', person.ref);
    expect(bureau.kind).toBe('REPORT');
    if (bureau.kind === 'REPORT') {
      expect(bureau.summary.bureauScore).toBe(person.bureau.score);
      expect(bureau.summary.worstDelinquencyDays).toBe(
        Math.max(0, ...person.bureau.facilities.map((f) => f.daysPastDue)),
      );
      expect(bureau.summary.defaults.some((d) => !d.settled)).toBe(person.bureau.defaults.some((d) => !d.settled));
    }

    // Nothing synthetic-but-identifying crosses any adapter.
    for (const answer of [employment, affordability, bureau]) expect(plain(answer)).not.toMatch(/SYNTH-|تجريبي [A-D]/);
  });

  it('the registry, identity and employment rails never carry a synthetic identity number out of the adapter', async () => {
    const t = new Recording();
    const r = rails(t);
    const out = [
      await r.wathq.lookup({ ...base, commercialRegistration: '1010000101' }),
      await r.yakeen.verify({ ...consented, applicantRef: 'ksa-demo-person-a' }),
      await r.gosi.employment({ ...consented, applicantRef: 'ksa-demo-person-a' }),
    ];
    // The rails did answer with them (the transport is faithful to a provider that returns identifiers)…
    expect(plain(t.answers)).toContain('SYNTH-');
    // …and the adapters dropped them.
    expect(plain(out)).not.toContain('SYNTH-');
  });
});

describe('the steering rules give every failure path', () => {
  it('Nafath: approve once, refuse the replay, and refuse a rejected or expired request', async () => {
    const r = rails();
    const start = async (applicantRef: string) => {
      const s = expectOk(await r.nafath.startAuthentication({ ...base, applicantRef, purpose: 'STEP_UP' }));
      if (s.kind !== 'ANSWERED') throw new Error('not started');
      return s.value.transactionRef;
    };
    const ok = await start('ksa-demo-person-b');
    expect(expectOk(await r.nafath.confirmAuthentication({ ...base, transactionRef: ok })).kind).toBe('ANSWERED');
    expect(expectOk(await r.nafath.confirmAuthentication({ ...base, transactionRef: ok }))).toEqual({
      kind: 'REFUSED',
      code: 'ASSERTION_REPLAYED',
    });
    for (const [ref, code] of [
      ['applicant-reject', 'STATUS_REJECTED'],
      ['applicant-expire', 'STATUS_EXPIRED'],
      ['applicant-wait', 'STATUS_WAITING'],
    ] as const)
      expect(expectOk(await r.nafath.confirmAuthentication({ ...base, transactionRef: await start(ref) }))).toEqual({
        kind: 'REFUSED',
        code,
      });
  });

  it('Yakeen: mismatch, expired ID and unknown person', async () => {
    const r = rails();
    const verify = async (applicantRef: string) => expectOk(await r.yakeen.verify({ ...consented, applicantRef }));
    expect(await verify('applicant-mismatch')).toMatchObject({
      value: { verified: false, mismatches: ['dateOfBirth'] },
    });
    expect(await verify('applicant-expired-id')).toMatchObject({
      value: { verified: false, mismatches: ['idExpiry'] },
    });
    expect(await verify('applicant-unknown')).toEqual({ kind: 'REFUSED', code: 'NOT_FOUND' });
  });

  it('Wathq: struck off, suspended, not on the register, and a generic company otherwise', async () => {
    const r = rails();
    const status = async (cr: string) => {
      const x = expectOk(await r.wathq.lookup({ ...base, commercialRegistration: cr }));
      return x.kind === 'ANSWERED' ? x.value.status : x;
    };
    expect(await status('1010009999')).toBe('CANCELLED');
    expect(await status('1010008888')).toBe('SUSPENDED');
    expect(await status('1010000000')).toEqual({ kind: 'REFUSED', code: 'NOT_FOUND' });
    expect(await status('1010123456')).toBe('ACTIVE');
    expect(castCompany('1010123456')).toBeUndefined();
  });

  it('bureaus: a DEF registration carries a default; no file is NO_RECORD', async () => {
    const r = rails();
    const def = await bureauFor(r.bayan, 'DEF0000001');
    expect(def.kind === 'REPORT' && def.summary.defaults.some((d) => !d.settled)).toBe(true);
    expect((await bureauFor(r.simah, '1010000000')).kind).toBe('NO_RECORD');
    expect((await bureauFor(r.simah, '1010000101', 'cp-norecord')).kind).toBe('NO_RECORD');
  });

  it('GOSI, zakat, Fatoora and Open Banking failure paths', async () => {
    const r = rails();
    expect(expectOk(await r.gosi.employment({ ...consented, applicantRef: 'x-unemployed' }))).toMatchObject({
      value: { employed: false },
    });
    expect(expectOk(await r.gosi.employment({ ...consented, applicantRef: 'x-unknown' }))).toEqual({
      kind: 'REFUSED',
      code: 'NOT_FOUND',
    });
    const zakat = async (crNumber: string) => expectOk(await r.zakat.certificateStatus({ ...base, crNumber }));
    expect(await zakat('1010007777')).toMatchObject({ value: { status: 'EXPIRED' } });
    expect(await zakat('1010000000')).toMatchObject({ value: { status: 'NOT_FOUND' } });
    const invoice = async (invoiceHash: string) =>
      expectOk(await r.fatoora.validateInvoice('bank-a', { invoiceUuid: 'u', invoiceHash }, 'c')).clearanceStatus;
    expect(await invoice('h-reject')).toBe('REJECTED');
    expect(await invoice('h-simplified')).toBe('REPORTED');
    expect(await invoice('h-unknown')).toBe('NOT_FOUND');
    expect(expectOk(await r.ob.affordabilityFacts({ ...consented, applicantRef: 'x-noaccount', months: 6 }))).toEqual({
      kind: 'REFUSED',
      code: 'NO_SAR_ACCOUNT',
    });
    expect(expectOk(await r.ob.affordabilityFacts({ ...consented, applicantRef: 'x-unknown', months: 6 }))).toEqual({
      kind: 'REFUSED',
      code: 'NOT_FOUND',
    });
  });

  it('payments: rejected, insufficient funds, pending and a returned collection', async () => {
    const r = rails();
    const disburse = async (reference: string) => {
      const x = expectOk(
        await r.hub.disburse({
          ...base,
          beneficiaryRef: 'b',
          amount: money(100_000n),
          purposeCode: 'LOAN',
          reference,
          idempotencyKey: `k-${reference}`,
        }),
      );
      return x.kind === 'ANSWERED' ? x.value.status : x.kind;
    };
    expect(await disburse('d-ok')).toBe('SETTLED');
    expect(await disburse('d-reject')).toBe('REJECTED');
    expect(await disburse('d-insufficient')).toBe('REJECTED');
    expect(await disburse('d-pending')).toBe('ACCEPTED');
    const returned = expectOk(
      await r.hub.collect({
        ...base,
        payerRef: 'p',
        amount: money(100_000n),
        reference: 'c-return',
        idempotencyKey: 'k-ret',
      }),
    );
    expect(returned.kind === 'ANSWERED' && returned.value.status).toBe('RETURNED');
    expect(
      expectOk(
        await r.sadad.present({
          ...base,
          obligationRef: 'OBL-reject',
          payerRef: 'p',
          amount: money(100n),
          dueDateGregorian: '2027-02-01',
          idempotencyKey: 'k',
        }),
      ),
    ).toEqual({ kind: 'REFUSED', code: 'NOT_PRESENTED' });
    const paid = expectOk(await r.sadad.paid({ ...base, sinceEpochSeconds: BigInt(NOW - 86_400 * 7) }));
    expect(paid.kind === 'ANSWERED' && paid.value.map((b) => b.billRef)).toEqual([
      '901-DEMO-OBL-0001',
      '901-DEMO-OBL-0002',
    ]);
  });
});
