/**
 * Adversarial cases for SME Lending, conventional and Islamic (CLAUDE.md §11).
 * Each attempts a prohibited outcome and passes only when the attempt fails.
 * Parameterised over both tenants' catalogues, and the Tawarruq sequence
 * cases run against personal and SME Tawarruq alike, so the two copies of the
 * sequence cannot drift apart unnoticed.
 */
import { describe, expect, it } from 'vitest';

import { loadProductCatalogue, loadSmeDefinition } from '@sanad/config/loader.ts';
import { classifySme, parseSmeDefinition } from '@sanad/core/applicant/sme-size.ts';
import { parseBusinessCreditRule } from '@sanad/core/decisioning/business-affordability.ts';
import { parseGuarantee } from '@sanad/core/decisioning/guarantee.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import { parseProductCatalogue } from '@sanad/core/products/catalogue.ts';
import type { BusinessFacts, Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { ISLAMIC_PRODUCT_CODES } from '@sanad/core/products/registry.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { smeTermConventional } from '@sanad/products/sme-term-conventional/index.ts';
import { disburse as disburseConventional } from '@sanad/products/sme-term-conventional/execution.ts';
import { smeTermIslamic } from '@sanad/products/sme-term-islamic/index.ts';
import * as smeSeq from '@sanad/products/sme-term-islamic/execution.ts';
import { tawarruqPersonal } from '@sanad/products/tawarruq-personal/index.ts';
import * as personalSeq from '@sanad/products/tawarruq-personal/execution.ts';

const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_790_000_000;
const DEFINITION = expectOk(loadSmeDefinition());
const RATE = {
  rate: rate(960n, 'REDUCING'),
  source: 'TENANT_CATALOGUE' as const,
  sourceRef: 'test-rate',
  snapshottedAtEpochSeconds: BigInt(T0),
};

/** A small enterprise that passes bank-a's illustrative policy comfortably. */
const SMALL: BusinessFacts = {
  annualRevenue: money(600_000_000n),
  fullTimeEmployees: 22,
  annualOperatingCashFlow: money(90_000_000n),
  existingAnnualDebtService: money(12_000_000n),
  financialsSourceRef: 'audited-2025',
};

const conventionalTerms = (tenant: 'bank-a' | 'fintech-b') =>
  expectOk(
    smeTermConventional.validateTerms(
      expectOk(loadProductCatalogue(tenant)).entries.find((e) => e.productCode === 'sme-term-conventional')?.terms,
    ),
  );
const islamicTerms = (tenant: 'bank-a' | 'fintech-b') =>
  expectOk(
    smeTermIslamic.validateTerms(
      expectOk(loadProductCatalogue(tenant)).entries.find((e) => e.productCode === 'sme-term-islamic')?.terms,
    ),
  );

/** The Saudi tenants' single variant, with the dates the dated schedule needs (never defaulted). */
const PREFERENCES = {
  variant: 'SME_TERM',
  purpose: 'WORKING_CAPITAL',
  disbursementDate: '2026-11-01',
  firstDueDate: '2026-12-01',
};

/** `business: null` means the request carries no business facts at all. */
const request = (amount: bigint, months: number, business: BusinessFacts | null = SMALL): QuoteRequest => ({
  tenantId: 'bank-a',
  programmeId: 'prg-0001',
  counterpartyId: 'ent-1',
  requestedAmount: money(amount),
  requestedTenorDays: months * 30,
  asOf: at(T0),
  pricing: { rate: RATE },
  regulatory: { smeDefinition: DEFINITION },
  preferences: PREFERENCES,
  ...(business === null ? {} : { affordability: { business } }),
});

const MODULES = [
  {
    name: 'conventional',
    quote: (tenant: 'bank-a' | 'fintech-b', r: QuoteRequest) => smeTermConventional.quote(conventionalTerms(tenant), r),
  },
  {
    name: 'islamic',
    quote: (tenant: 'bank-a' | 'fintech-b', r: QuoteRequest) => smeTermIslamic.quote(islamicTerms(tenant), r),
  },
] as const;

describe('enterprise size follows the regulator’s definition, never a guess', () => {
  it('revenue decides; employees decide only when there is no revenue history', () => {
    expect(
      expectOk(classifySme(DEFINITION, { annualRevenue: money(250_000_000n), fullTimeEmployees: 200 })).sizeClass,
    ).toBe('MICRO'); // revenue wins over headcount
    expect(
      expectOk(classifySme(DEFINITION, { annualRevenue: money(300_000_001n), fullTimeEmployees: 1 })).sizeClass,
    ).toBe('SMALL');
    expect(
      expectOk(classifySme(DEFINITION, { annualRevenue: money(20_000_000_001n), fullTimeEmployees: 10 })).sizeClass,
    ).toBe('LARGE');
    const byStaff = expectOk(classifySme(DEFINITION, { fullTimeEmployees: 60 }));
    expect(byStaff).toMatchObject({ sizeClass: 'MEDIUM', basis: 'EMPLOYEES' });
  });
  it('an enterprise with neither revenue history nor employees is refused, not classified', () => {
    const r = classifySme(DEFINITION, { fullTimeEmployees: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('SIZE_UNCLASSIFIABLE');
  });
  it('a definition without its circular, or with bands out of order, does not load', () => {
    expect(parseSmeDefinition({ citation: 'x', effectiveFromEpochSeconds: '1', bands: [] }).ok).toBe(false);
    const swapped = {
      citation: 'SAMA Circular test citation',
      effectiveFromEpochSeconds: '1',
      bands: [
        { sizeClass: 'SMALL', revenueUpToMinorUnits: '1', employeesUpTo: 1 },
        { sizeClass: 'MICRO', revenueUpToMinorUnits: '2', employeesUpTo: 2 },
        { sizeClass: 'MEDIUM', revenueUpToMinorUnits: '3', employeesUpTo: 3 },
      ],
    };
    expect(parseSmeDefinition(swapped).ok).toBe(false);
  });
});

describe.each(MODULES)('SME $name: prohibited quotes are refused', (m) => {
  it.each(['bank-a', 'fintech-b'] as const)(
    '%s: without a sourced rate, the SME definition, or business facts',
    (tenant) => {
      const noRate = m.quote(tenant, { ...request(10_000_000n, 24), pricing: {} });
      expect(noRate.ok).toBe(false);
      if (!noRate.ok) expect(noRate.error.control).toBe('PLAT-03');
      const { regulatory: _r, ...noDefinition } = request(10_000_000n, 24);
      const d = m.quote(tenant, noDefinition);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.error.reason).toBe('SME_DEFINITION_MISSING');
      const f = m.quote(tenant, request(10_000_000n, 24, null));
      expect(f.ok).toBe(false);
      if (!f.ok) expect(f.error.reason).toBe('BUSINESS_FACTS_MISSING');
      const unsourced = m.quote(tenant, request(10_000_000n, 24, { ...SMALL, financialsSourceRef: ' ' }));
      expect(unsourced.ok).toBe(false);
      if (!unsourced.ok) expect(unsourced.error.reason).toBe('FINANCIALS_UNSOURCED');
    },
  );

  it('a large enterprise is not served by a product for SMEs', () => {
    const r = m.quote('bank-a', request(10_000_000n, 24, { ...SMALL, annualRevenue: money(25_000_000_000n) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe('SIZE_NOT_ELIGIBLE');
      expect(r.error.context?.['policyRef']).toMatch(/credit policy/);
    }
  });

  it('cash flow that would not cover the debt service by the policy margin is refused', () => {
    const r = m.quote('bank-a', request(100_000_000n, 24, { ...SMALL, annualOperatingCashFlow: money(40_000_000n) }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.control).toBe('OP-LIMIT');
      expect(r.error.reason).toBe('DEBT_SERVICE_COVER_BELOW_POLICY');
    }
  });

  it('more than the policy share of revenue is refused', () => {
    // bank-a: 30% of SAR 6,000,000 = SAR 1,800,000. Ask for SAR 1,900,000.
    const r = m.quote(
      'bank-a',
      request(190_000_000n, 60, { ...SMALL, annualOperatingCashFlow: money(5_000_000_000n) }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('ABOVE_REVENUE_SHARE');
  });

  it('an enterprise with no revenue history gets only what the policy allows it, or nothing', () => {
    const young = { ...SMALL, fullTimeEmployees: 4 } as BusinessFacts;
    const { annualRevenue: _a, ...noHistory } = young;
    const over = m.quote('bank-a', request(60_000_000n, 24, noHistory));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.reason).toBe('ABOVE_NEW_ENTERPRISE_LIMIT');
    const fintech = m.quote('fintech-b', request(5_000_000n, 24, noHistory));
    expect(fintech.ok).toBe(false);
    if (!fintech.ok) expect(fintech.error.reason).toBe('NO_REVENUE_HISTORY');
  });

  it('a clean quote becomes an offer whose APR the platform computed, with the guaranteed portion disclosed', () => {
    const q: Quote = expectOk<Quote, unknown>(m.quote('bank-a', request(50_000_000n, 24)) as Result<Quote, unknown>);
    const module = m.name === 'conventional' ? smeTermConventional : smeTermIslamic;
    const offer = expectOk(buildOffer(module as never, q, at(T0)));
    expect(offer.apr.bp).toBeGreaterThan(0n);
    expect(offer.disclosure.lines.find((l) => l.code === 'GUARANTEED_PORTION')?.amount.minorUnits).toBe(40_000_000n); // 80% of SAR 500,000
  });

  it.each(['bank-a', 'fintech-b'] as const)(
    '%s: the Saudi term sheet is one SAR variant; an AED request is refused',
    (tenant) => {
      const r = m.quote(tenant, { ...request(10_000_000n, 24), requestedAmount: money(10_000_000n, 'AED') });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.reason).toBe('CURRENCY_MISMATCH');
    },
  );
});

describe('the limits say whose they are', () => {
  it('a credit rule that does not name the institution’s policy as its source does not parse', () => {
    const base = {
      eligibleSizes: ['SMALL'],
      minDebtServiceCoverPerTenThousand: 12500,
      maxFinancingShareOfRevenuePerTenThousand: 3000,
      source: 'TENANT_CREDIT_POLICY',
      policyRef: 'policy v1',
    };
    expect(parseBusinessCreditRule(base, (s) => money(BigInt(s))).ok).toBe(true);
    expect(parseBusinessCreditRule({ ...base, source: 'SAMA' }, (s) => money(BigInt(s))).ok).toBe(false);
    expect(parseBusinessCreditRule({ ...base, policyRef: '' }, (s) => money(BigInt(s))).ok).toBe(false);
  });
  it('a guarantee without its programme reference does not parse', () => {
    expect(
      parseGuarantee({
        programme: 'Kafalah',
        coveragePerTenThousand: 8000,
        programmeRef: 'short',
        requiredBeforeDisbursement: true,
      }).ok,
    ).toBe(false);
    expect(
      parseGuarantee({
        programme: 'Kafalah',
        coveragePerTenThousand: 10_001,
        programmeRef: 'Kafalah programme document',
        requiredBeforeDisbursement: true,
      }).ok,
    ).toBe(false);
  });
});

describe('SME Tawarruq cannot be enabled without the tenant board’s ruling (SH-18)', () => {
  it.each(['bank-a', 'fintech-b'] as const)(
    '%s ships it disabled, and enabling it without a ruling is refused',
    (tenant) => {
      const catalogue = expectOk(loadProductCatalogue(tenant));
      expect(catalogue.entries.find((e) => e.productCode === 'sme-term-islamic')?.enabled).toBe(false);
      const raw = JSON.parse(JSON.stringify(catalogue, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as {
        entries: Record<string, unknown>[];
      };
      const enabled = {
        ...raw,
        entries: raw.entries.map((e) => (e['productCode'] === 'sme-term-islamic' ? { ...e, enabled: true } : e)),
      };
      const r = parseProductCatalogue(enabled, ISLAMIC_PRODUCT_CODES);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.control).toBe('SH-18');
    },
  );
});

describe('conventional SME execution', () => {
  const q = () => expectOk(smeTermConventional.quote(conventionalTerms('bank-a'), request(50_000_000n, 24)));
  const approved = { state: 'APPROVED' as const, core: { tenantId: 'bank-a' } } as unknown as Parameters<
    typeof smeTermConventional.execute
  >[1];
  const ctx = {
    transactionId: 'txn-1',
    applicantRef: 'ent-1',
    bureauEnquiryRef: 'simah-c-1',
    consentId: 'consent-1',
    businessRegistryRef: 'wathq-1',
    openedAt: at(T0),
    correlationId: 'c-1',
  };
  it('no approval without a commercial bureau enquiry, consent, or a registry check', () => {
    for (const missing of ['bureauEnquiryRef', 'consentId', 'businessRegistryRef'] as const) {
      expect(
        smeTermConventional.execute(conventionalTerms('bank-a'), approved, q(), { ...ctx, [missing]: ' ' }).ok,
        missing,
      ).toBe(false);
    }
  });
  it('disburses once, with the bureau report, both keyed on the transaction', () => {
    const draft = expectOk(smeTermConventional.execute(conventionalTerms('bank-a'), approved, q(), ctx));
    const done = expectOk(disburseConventional(draft, at(T0 + 1)));
    const keys = done.outbox.events.map((e) => e.idempotencyKey);
    expect(keys).toEqual(['txn:txn-1:disburse', 'txn:txn-1:bureau']);
    expect(disburseConventional(draft, at(T0)).ok).toBe(false); // not before it was opened
  });
  it('where the term sheet requires the guarantee first, no disbursement without it', () => {
    const terms = {
      ...conventionalTerms('bank-a'),
      guarantee: {
        programme: 'Kafalah',
        coveragePerTenThousand: 8000,
        programmeRef: 'Kafalah programme document',
        requiredBeforeDisbursement: true,
      },
    };
    const draft = expectOk(smeTermConventional.execute(terms, approved, q(), ctx));
    const r = disburseConventional(draft, at(T0 + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('GUARANTEE_NOT_ISSUED');
    expect(disburseConventional(draft, at(T0 + 1), 'kafalah-g-1').ok).toBe(true);
  });
});

/** The same sequence cases, run against both Tawarruq modules. */
const lot = (price: bigint) => ({
  lotRef: 'lot-1',
  commodityCode: 'LME-AL',
  quantity: '10',
  unit: 'MT',
  price: money(price),
  confirmedAtEpochSeconds: BigInt(T0 + 1),
});
const SEQUENCES = [
  {
    name: 'personal Tawarruq',
    seq: personalSeq,
    draft: (agencyPermitted: boolean) => {
      const terms = {
        ...expectOk(
          tawarruqPersonal.validateTerms(
            expectOk(loadProductCatalogue('bank-a')).entries.find((e) => e.productCode === 'tawarruq-personal')?.terms,
          ),
        ),
        agencyPermitted,
      };
      const q = expectOk(
        tawarruqPersonal.quote(terms, {
          ...request(5_000_000n, 12),
          affordability: { monthlyIncome: money(2_000_000n), existingMonthlyObligations: money(0n) },
        }),
      );
      return {
        draft: expectOk(
          tawarruqPersonal.execute(terms, { state: 'APPROVED', core: { tenantId: 'bank-a' } } as never, q, {
            transactionId: 't',
            applicantRef: 'a',
            bureauEnquiryRef: 'b',
            consentId: 'c',
            openedAt: at(T0),
            correlationId: 'k',
          }),
        ),
        cost: q.commodityCost.minorUnits,
      };
    },
  },
  {
    name: 'SME Tawarruq',
    seq: smeSeq,
    draft: (agencyPermitted: boolean) => {
      const terms = { ...islamicTerms('bank-a'), agencyPermitted };
      const q = expectOk(smeTermIslamic.quote(terms, request(50_000_000n, 24)));
      return {
        draft: expectOk(
          smeTermIslamic.execute(terms, { state: 'APPROVED', core: { tenantId: 'bank-a' } } as never, q, {
            transactionId: 't',
            applicantRef: 'a',
            bureauEnquiryRef: 'b',
            consentId: 'c',
            businessRegistryRef: 'w',
            openedAt: at(T0),
            correlationId: 'k',
          }),
        ),
        cost: q.commodityCost.minorUnits,
      };
    },
  },
] as const;

describe.each(SEQUENCES)('$name sequence', (s) => {
  it('a lot that is not the quoted cost cannot be bought (SH-03)', () => {
    const { draft, cost } = s.draft(true);
    const r = (s.seq.purchaseCommodity as (...a: unknown[]) => { ok: boolean; error?: { control: string } })(
      draft,
      lot(cost - 1n),
      at(T0 + 1),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.control).toBe('SH-03');
  });
  it('steps must be attested in order, each strictly after the one before', () => {
    const { draft, cost } = s.draft(true);
    const seq = s.seq as unknown as typeof smeSeq;
    const bought = expectOk(seq.purchaseCommodity(draft as never, lot(cost), at(T0 + 1)));
    expect(seq.sellToCustomer(bought, 'deed', at(T0 + 1)).ok).toBe(false); // same instant
    const sold = expectOk(seq.sellToCustomer(bought, 'deed', at(T0 + 2)));
    const titled = expectOk(seq.transferTitle(sold, 'tr', at(T0 + 3)));
    expect(seq.realiseProceeds(titled, { saleRef: 's', proceeds: money(cost) }, at(T0 + 2)).ok).toBe(false);
  });
  it('agency is refused where the board does not permit it (SH-18)', () => {
    const { draft, cost } = s.draft(false);
    const seq = s.seq as unknown as typeof smeSeq;
    const titled = expectOk(
      seq.transferTitle(
        expectOk(
          seq.sellToCustomer(
            expectOk(seq.purchaseCommodity(draft as never, lot(cost), at(T0 + 1))),
            'deed',
            at(T0 + 2),
          ),
        ),
        'tr',
        at(T0 + 3),
      ),
    );
    const r = seq.realiseProceeds(titled, { saleRef: 's', proceeds: money(cost), agencyRef: 'agency-1' }, at(T0 + 4));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.control).toBe('SH-18');
  });
});

describe('SME Tawarruq: the guarantee, where required, is issued before the money moves', () => {
  it('refuses disbursement without it and allows it with it', () => {
    const terms = {
      ...islamicTerms('bank-a'),
      guarantee: {
        programme: 'Kafalah',
        coveragePerTenThousand: 8000,
        programmeRef: 'Kafalah programme document',
        requiredBeforeDisbursement: true,
      },
    };
    const q = expectOk(smeTermIslamic.quote(terms, request(50_000_000n, 24)));
    const draft = expectOk(
      smeTermIslamic.execute(terms, { state: 'APPROVED', core: { tenantId: 'bank-a' } } as never, q, {
        transactionId: 't',
        applicantRef: 'a',
        bureauEnquiryRef: 'b',
        consentId: 'c',
        businessRegistryRef: 'w',
        openedAt: at(T0),
        correlationId: 'k',
      }),
    );
    const realised = expectOk(
      smeSeq.realiseProceeds(
        expectOk(
          smeSeq.transferTitle(
            expectOk(
              smeSeq.sellToCustomer(
                expectOk(smeSeq.purchaseCommodity(draft, lot(q.commodityCost.minorUnits), at(T0 + 1))),
                'deed',
                at(T0 + 2),
              ),
            ),
            'tr',
            at(T0 + 3),
          ),
        ),
        { saleRef: 's', proceeds: q.commodityCost },
        at(T0 + 4),
      ),
    );
    const r = smeSeq.disburse(realised, at(T0 + 5));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('GUARANTEE_NOT_ISSUED');
    expect(smeSeq.disburse(realised, at(T0 + 5), 'kafalah-g-1').ok).toBe(true);
  });
});
