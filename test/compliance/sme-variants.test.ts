/**
 * SME product variants (the UAE SME fund's six products, and the Saudi
 * tenants' single variant). Each case attempts a prohibited outcome and
 * passes only when it is refused; the same cases run against the
 * conventional and the Tawarruq module, whose variant code is written twice
 * (modules are isolated) and must stay identical.
 *
 * Source of the fund's figures: Tuum prototype screens shared 2026-10-08.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadDocumentChecklist, loadProductCatalogue, loadSmeDefinition } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { type Result, expectOk } from '@sanad/core/kernel/result.ts';
import type { BusinessFacts, Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { smeTermConventional } from '@sanad/products/sme-term-conventional/index.ts';
import { smeTermIslamic } from '@sanad/products/sme-term-islamic/index.ts';

const at = (s: number) =>
  tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_790_000_000;
const AE_DEFINITION = expectOk(loadSmeDefinition('AE'));
const RATE = {
  rate: rate(150n, 'REDUCING'),
  source: 'TENANT_CATALOGUE' as const,
  sourceRef: 'fund-rate-card',
  snapshottedAtEpochSeconds: BigInt(T0),
};

/** A small services enterprise: AED 10,000,000 revenue, AED 1,000,000 operating cash flow, no existing debt. */
const ENTERPRISE: BusinessFacts = {
  annualRevenue: money(1_000_000_000n, 'AED'),
  fullTimeEmployees: 20,
  sector: 'SERVICES',
  annualOperatingCashFlow: money(100_000_000n, 'AED'),
  existingAnnualDebtService: money(0n, 'AED'),
  financialsSourceRef: 'audited-2025',
};

/** The golden core-banking case of core/pricing/dated-schedule.ts: AED 2,000,000 at 1.5% over 60 months. */
const GOLDEN = {
  variant: 'FIXED_ASSETS',
  purpose: 'EQUIPMENT',
  contributionPerTenThousand: '2000',
  yearsInOperation: '3',
  disbursementDate: '2029-08-04',
  firstDueDate: '2029-09-10',
};

const request = (amount: bigint, months: number, preferences: Readonly<Record<string, string>>): QuoteRequest => ({
  tenantId: 'sme-fund-ae',
  programmeId: 'sme-ae-fixed-assets',
  counterpartyId: 'ent-ae-1',
  requestedAmount: money(amount, 'AED'),
  requestedTenorDays: months * 30,
  asOf: at(T0),
  pricing: { rate: RATE },
  regulatory: { smeDefinition: AE_DEFINITION },
  affordability: { business: ENTERPRISE },
  preferences,
});

const fund = expectOk(loadProductCatalogue('sme-fund-ae'));
const entry = (code: string) => fund.entries.find((e) => e.productCode === code);
const conventionalTerms = expectOk(smeTermConventional.validateTerms(entry('sme-term-conventional')?.terms));
const islamicTerms = expectOk(smeTermIslamic.validateTerms(entry('sme-term-islamic')?.terms));

const MODULES = [
  {
    name: 'conventional',
    module: smeTermConventional,
    terms: conventionalTerms,
    raw: entry('sme-term-conventional')?.terms,
    quote: (r: QuoteRequest) => smeTermConventional.quote(conventionalTerms, r) as Result<Quote>,
  },
  {
    name: 'islamic',
    module: smeTermIslamic,
    terms: islamicTerms,
    raw: entry('sme-term-islamic')?.terms,
    quote: (r: QuoteRequest) => smeTermIslamic.quote(islamicTerms, r) as Result<Quote>,
  },
] as const;

const reasonOf = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.reason);
const controlOf = (r: Result<unknown>): string | undefined => (r.ok ? undefined : r.error.control);

describe('the fund’s catalogue: six SME variants in AED', () => {
  it('the conventional module carries the six products from the prototype screens; the Tawarruq mirror ships disabled', () => {
    expect(conventionalTerms.currency).toBe('AED');
    expect(conventionalTerms.variants.map((v) => v.code)).toEqual([
      'SMALL_LOAN',
      'WORKING_CAPITAL',
      'FIXED_ASSETS',
      'EXPANSION',
      'FIRST_TIME_FOUNDERS',
      'ADVANCED_TECH_AI',
    ]);
    expect(entry('sme-term-conventional')?.enabled).toBe(true);
    expect(entry('sme-term-islamic')?.enabled).toBe(false);
    expect(islamicTerms.variants.map((v) => v.code)).toEqual(conventionalTerms.variants.map((v) => v.code));
  });

  it('each variant carries the ceiling, tenor, grace, contribution and years the screens show', () => {
    const v = Object.fromEntries(conventionalTerms.variants.map((x) => [x.code, x]));
    const shape = (code: string) => {
      const x = v[code];
      return x === undefined
        ? undefined
        : [
            x.maxAmount.minorUnits,
            x.maxMonths,
            x.maxGraceMonths,
            x.minContributionPerTenThousand,
            x.maxContributionPerTenThousand,
            x.minYearsInOperation,
          ];
    };
    expect(shape('SMALL_LOAN')?.slice(0, 2)).toEqual([100_000_000n, 36]);
    expect(shape('WORKING_CAPITAL')?.slice(0, 3)).toEqual([100_000_000n, 12, 3]);
    expect(shape('FIXED_ASSETS')).toEqual([200_000_000n, 60, 6, 2000, 10_000, 1]);
    expect(shape('EXPANSION')).toEqual([500_000_000n, 72, 12, 2000, 4000, 2]);
    expect(shape('FIRST_TIME_FOUNDERS')?.slice(0, 2)).toEqual([100_000_000n, 60]);
    expect(shape('ADVANCED_TECH_AI')?.slice(0, 2)).toEqual([200_000_000n, 60]);
    expect(v['FIXED_ASSETS']?.collateral.map((c) => c.code)).toEqual([
      'PERSONAL_GUARANTEE',
      'PROMISSORY_NOTE',
      'UNDERLYING_ASSET',
      'INSURANCE',
    ]);
  });

  it.each(MODULES)('$name: every variant says where its figures come from and which are illustrative', (m) => {
    for (const variant of m.terms.variants) {
      expect(variant.note, variant.code).toMatch(/prototype screens shared 2026-10-08/);
      expect(variant.note, variant.code).toMatch(/ILLUSTRATIVE/);
      expect(variant.maxAmount.currency).toBe('AED');
    }
  });

  it.each(MODULES)(
    '$name: every variant’s checklist is configured for the fund, with the core documents required',
    (m) => {
      const core = ['TRADE_LICENCE', 'OWNER_EMIRATES_ID', 'PERSONAL_BUREAU_REPORT', 'PERSONAL_BANK_STATEMENT_12M'];
      for (const variant of m.terms.variants) {
        const ref = variant.documentChecklistRef;
        expect(ref, variant.code).toBeDefined();
        const list = expectOk(loadDocumentChecklist('sme-fund-ae', ref ?? ''));
        expect(list.tenantId).toBe('sme-fund-ae');
        for (const doc of core)
          expect(list.items.find((i) => i.documentType === doc)?.required, `${variant.code}/${doc}`).toBe(true);
      }
    },
  );

  it('the project and collateral documents differ by variant', () => {
    const required = (ref: string) =>
      expectOk(loadDocumentChecklist('sme-fund-ae', ref))
        .items.filter((i) => i.required)
        .map((i) => i.documentType);
    expect(required('sme-ae-fixed-assets')).toEqual(
      expect.arrayContaining([
        'SUPPLIER_QUOTATIONS',
        'ASSET_VALUATION_REPORT',
        'AUDITED_FINANCIALS_2Y',
        'WPS_SALARY_REPORT',
      ]),
    );
    expect(required('sme-ae-expansion')).toEqual(expect.arrayContaining(['SUPPLIER_QUOTATIONS', 'RENTAL_CONTRACT']));
    // A first-time founder has no two years of audited statements and may have no staff yet.
    expect(required('sme-ae-first-time-founders')).not.toContain('AUDITED_FINANCIALS_2Y');
    expect(required('sme-ae-first-time-founders')).not.toContain('WPS_SALARY_REPORT');
    expect(required('sme-ae-small-loan')).not.toContain('ASSET_VALUATION_REPORT');
  });
});

describe.each(MODULES)('SME $name: the variant governs the quote', (m) => {
  it('the golden core-banking case is priced on the dated ACT/365 schedule, and the platform computes the APR', () => {
    const q = expectOk(m.quote(request(200_000_000n, 60, GOLDEN))) as Quote & {
      monthlyInstalment: { minorUnits: bigint };
      datedSchedule: { rows: readonly unknown[]; totalInterest: { minorUnits: bigint } };
      variantCode: string;
    };
    expect(q.variantCode).toBe('FIXED_ASSETS');
    expect(q.monthlyInstalment.minorUnits).toBe(3_462_918n); // AED 34,629.18
    expect(q.datedSchedule.rows).toHaveLength(60);
    expect(q.datedSchedule.totalInterest.minorUnits).toBe(7_775_066n); // AED 77,750.66
    expect(q.totalPayable).toEqual(money(207_775_066n, 'AED')); // AED 2,077,750.66, no fee
    const offer = expectOk(buildOffer(m.module as never, q, at(T0)));
    expect(offer.apr.bp).toBeGreaterThanOrEqual(150n);
    expect(offer.apr.bp).toBeLessThanOrEqual(152n);
    expect(offer.disclosure.instalmentAmount?.minorUnits).toBe(3_462_918n);
  });

  it('a grace period gives interest-only instalments first, and the disclosure shows the grace and the level instalment instead of one instalment', () => {
    const prefs = {
      variant: 'EXPANSION',
      purpose: 'CAPEX_OPEX',
      contributionPerTenThousand: '3000',
      yearsInOperation: '4',
      graceMonths: '12',
      disbursementDate: '2029-08-04',
      firstDueDate: '2029-09-10',
    };
    const q = expectOk(m.quote(request(200_000_000n, 72, prefs))) as Quote & {
      graceMonths: number;
      datedSchedule: { rows: readonly { grace: boolean; principal: { minorUnits: bigint } }[] };
    };
    expect(q.graceMonths).toBe(12);
    expect(q.datedSchedule.rows.slice(0, 12).every((r) => r.grace && r.principal.minorUnits === 0n)).toBe(true);
    expect(q.datedSchedule.rows[12]?.grace).toBe(false);
    const d = m.module.disclose(q as never);
    expect(d.instalmentAmount).toBeUndefined();
    expect(d.lines.map((l) => l.code)).toContain('LEVEL_INSTALMENT');
    expect(d.lines.some((l) => l.code.startsWith('GRACE_PERIOD_'))).toBe(true);
    expect(expectOk(buildOffer(m.module as never, q, at(T0))).apr.bp).toBeGreaterThan(0n);
  });

  const refusals: readonly (readonly [string, Readonly<Record<string, string>>, bigint, number, string, string])[] = [
    ['no variant chosen', { ...GOLDEN, variant: '' }, 100_000_000n, 60, 'VARIANT_REQUIRED', 'OP-DETERMINACY'],
    ['an unknown variant', { ...GOLDEN, variant: 'PLATINUM' }, 100_000_000n, 60, 'VARIANT_UNKNOWN', 'OP-DETERMINACY'],
    ['an amount above the variant maximum', GOLDEN, 200_000_001n, 60, 'AMOUNT_EXCEEDS_VARIANT', 'OP-LIMIT'],
    ['a tenor above the variant maximum', GOLDEN, 100_000_000n, 61, 'TENOR_OUTSIDE_VARIANT', 'OP-DETERMINACY'],
    ['a tenor below the variant minimum', GOLDEN, 100_000_000n, 6, 'TENOR_OUTSIDE_VARIANT', 'OP-DETERMINACY'],
    [
      'more grace than the variant allows',
      { ...GOLDEN, graceMonths: '7' },
      100_000_000n,
      60,
      'GRACE_EXCEEDS_VARIANT',
      'OP-LIMIT',
    ],
    ['a malformed grace', { ...GOLDEN, graceMonths: '1.5' }, 100_000_000n, 60, 'GRACE_MALFORMED', 'OP-DETERMINACY'],
    [
      'a contribution below the band',
      { ...GOLDEN, contributionPerTenThousand: '1999' },
      100_000_000n,
      60,
      'CONTRIBUTION_OUTSIDE_VARIANT',
      'OP-LIMIT',
    ],
    [
      'no contribution where one is required',
      (({ contributionPerTenThousand: _c, ...rest }) => rest)(GOLDEN),
      100_000_000n,
      60,
      'CONTRIBUTION_OUTSIDE_VARIANT',
      'OP-LIMIT',
    ],
    [
      'a contribution above the band',
      { ...GOLDEN, variant: 'EXPANSION', purpose: 'CAPEX_OPEX', contributionPerTenThousand: '4001' },
      100_000_000n,
      60,
      'CONTRIBUTION_OUTSIDE_VARIANT',
      'OP-LIMIT',
    ],
    [
      'too few years in operation',
      { ...GOLDEN, variant: 'EXPANSION', purpose: 'CAPEX_OPEX', yearsInOperation: '1' },
      100_000_000n,
      60,
      'YEARS_IN_OPERATION_BELOW_VARIANT',
      'OP-LIMIT',
    ],
    [
      'years in operation not stated where the variant has a minimum',
      (({ yearsInOperation: _y, ...rest }) => rest)(GOLDEN),
      100_000_000n,
      60,
      'YEARS_IN_OPERATION_REQUIRED',
      'OP-DETERMINACY',
    ],
    ['no purpose', { ...GOLDEN, purpose: '' }, 100_000_000n, 60, 'PURPOSE_REQUIRED', 'OP-DETERMINACY'],
    [
      'a purpose the variant does not finance',
      { ...GOLDEN, purpose: 'WORKING_CAPITAL' },
      100_000_000n,
      60,
      'PURPOSE_NOT_ALLOWED',
      'OP-LIMIT',
    ],
    [
      'no disbursement date (never defaulted)',
      (({ disbursementDate: _d, ...rest }) => rest)(GOLDEN),
      100_000_000n,
      60,
      'DISBURSEMENT_DATE_REQUIRED',
      'OP-DETERMINACY',
    ],
    [
      'no first due date (never defaulted)',
      (({ firstDueDate: _d, ...rest }) => rest)(GOLDEN),
      100_000_000n,
      60,
      'FIRST_DUE_DATE_REQUIRED',
      'OP-DETERMINACY',
    ],
    [
      'a malformed date',
      { ...GOLDEN, firstDueDate: '10/09/2029' },
      100_000_000n,
      60,
      'DATE_MALFORMED',
      'OP-DETERMINACY',
    ],
    [
      'a first due date before disbursement',
      { ...GOLDEN, firstDueDate: '2029-08-01' },
      100_000_000n,
      60,
      'SCHEDULE_FIRST_DUE',
      'PLAT-02',
    ],
    ['an amount below the product minimum', GOLDEN, 4_999_999n, 60, 'AMOUNT_BELOW_PRODUCT', 'OP-LIMIT'],
  ];

  it.each(refusals)('refuses %s', (_name, prefs, amount, months, reason, control) => {
    const r = m.quote(request(amount, months, prefs));
    expect(reasonOf(r)).toBe(reason);
    expect(controlOf(r)).toBe(control);
  });

  it('refuses a request in another currency than the term sheet', () => {
    const r = m.quote({ ...request(100_000_000n, 60, GOLDEN), requestedAmount: money(100_000_000n, 'SAR') });
    expect(reasonOf(r)).toBe('CURRENCY_MISMATCH');
  });

  it('the module-level credit rule still applies inside every variant', () => {
    const r = m.quote({
      ...request(200_000_000n, 60, GOLDEN),
      affordability: { business: { ...ENTERPRISE, annualOperatingCashFlow: money(50_000_000n, 'AED') } },
    });
    expect(reasonOf(r)).toBe('DEBT_SERVICE_COVER_BELOW_POLICY');
  });
});

describe.each(MODULES)('SME $name: a malformed term sheet does not parse', (m) => {
  const raw = m.raw as Record<string, unknown>;
  const variants = raw['variants'] as Record<string, unknown>[];
  const first = variants[0] as Record<string, unknown>;
  const withVariant = (patch: Record<string, unknown>) => ({
    ...raw,
    variants: [{ ...first, ...patch }, ...variants.slice(1)],
  });
  const cases: readonly (readonly [string, unknown, string])[] = [
    ['no currency', (({ currency: _c, ...rest }) => rest)(raw), 'TERMS_CURRENCY'],
    ['an unsupported currency', { ...raw, currency: 'USD' }, 'TERMS_CURRENCY'],
    ['the old single-sheet shape', { ...raw, maxMonths: 60 }, 'TERMS_UNKNOWN_KEY'],
    ['no variants', { ...raw, variants: [] }, 'TERMS_VARIANTS'],
    ['two variants with one code', { ...raw, variants: [first, first] }, 'TERMS_VARIANT_DUPLICATE'],
    ['an unknown variant key', withVariant({ interestRate: 150 }), 'TERMS_VARIANT_UNKNOWN_KEY'],
    ['grace as long as the tenor', withVariant({ maxGraceMonths: first['maxMonths'] }), 'TERMS_VARIANT_GRACE'],
    [
      'a contribution band upside down',
      withVariant({ minContributionPerTenThousand: 5000, maxContributionPerTenThousand: 4000 }),
      'TERMS_VARIANT_CONTRIBUTION',
    ],
    ['no purposes', withVariant({ purposes: [] }), 'TERMS_VARIANT_LABELS'],
    [
      'a purpose without its Arabic label',
      withVariant({ purposes: [{ code: 'X', labelEn: 'X' }] }),
      'TERMS_VARIANT_LABELS',
    ],
    ['a variant ceiling below the product minimum', withVariant({ maxAmountMinorUnits: '1' }), 'TERMS_VARIANT_AMOUNT'],
    ['a fractional minimum of years', withVariant({ minYearsInOperation: 1.5 }), 'TERMS_VARIANT_YEARS'],
  ];
  it.each(cases)('refuses %s', (_name, sheet, reason) => {
    expect(reasonOf(m.module.validateTerms(sheet))).toBe(reason);
  });
});

describe('the two copies of the variant code cannot drift apart', () => {
  it('the bodies of the conventional and Tawarruq variants files are identical after their header comments', () => {
    const body = (path: string) => {
      const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
      return text.slice(text.indexOf('*/') + 2);
    };
    expect(body('../../products/sme-term-islamic/variants.ts')).toBe(
      body('../../products/sme-term-conventional/variants.ts'),
    );
  });
});
