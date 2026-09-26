/**
 * The product engine: catalogue → pricing inputs → module quote → offer.
 */
import { describe, expect, it } from 'vitest';

import { loadProductCatalogue } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { entryFor, parseProductCatalogue } from '@sanad/core/products/catalogue.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { ISLAMIC_PRODUCT_CODES, ProductRegistry } from '@sanad/core/products/registry.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { murabahaScf } from '@sanad/products/murabaha-scf/index.ts';
import { loadOriginationPolicy } from '@sanad/config/loader.ts';
import { approve, raise, submitForReview, type Approved, type Principal } from '@sanad/core/origination/request.ts';
import { transactionCore, structureFor, riskPeriodSecondsFor } from '../support/fixtures.ts';

const at = tsaInstant({ verified: true, genTimeEpochSeconds: 1_790_000_000n, tokenDigest: 't', authorityId: 'test' });
const trade = { type: 'CLEARED_INVOICE' as const, invoiceUuid: '3cf5d9a2-0000-4000-8000-000000000001', invoiceHash: 'h', issuerCr: '1010000002', recipientCr: '7001000001' };

function approvedRequest(): Approved {
  const policy = expectOk(loadOriginationPolicy('bank-a'));
  const maker: Principal = { principalId: 'stf-maker-01', tenantId: 'bank-a' };
  const checker: Principal = { principalId: 'stf-checker-01', tenantId: 'bank-a', authority: 'SENIOR_CHECKER' };
  const keyed = expectOk(raise({ core: {
    requestId: 'req-pe', tenantId: 'bank-a', programmeId: 'prg-0001', counterpartyId: 'cpt-0001', channel: 'MAKER_CHECKER',
    identification: { kind: 'STAFF_PRINCIPAL', principalId: 'stf-maker-01' }, tradeReference: trade,
    requestedAmount: money(18_500_000n), requestedTenorDays: 90, correlationId: 'c', raisedAt: at,
  }, maker, policy }));
  const review = expectOk(submitForReview(keyed, at));
  if (review.state !== 'AWAITING_REVIEW') throw new Error('expected review');
  return expectOk(approve(review, checker, at, undefined, policy));
}

describe('tenant product catalogues', () => {
  it('both tenants parse, and they differ', () => {
    const a = expectOk(loadProductCatalogue('bank-a')); const b = expectOk(loadProductCatalogue('fintech-b'));
    expect(a.entries.map((e) => e.productCode)).toContain('tawarruq-personal');
    expect(b.entries.map((e) => e.productCode)).toContain('embedded-lending');
    expect(a.entries.find((e) => e.productCode === 'murabaha-scf')?.pricingRule.kind).toBe('CATALOGUE_RATE');
    expect(b.entries.find((e) => e.productCode === 'murabaha-scf')?.pricingRule.kind).toBe('FIXED_PROFIT_AMOUNT');
  });
  it('an Islamic product cannot be enabled without a board ruling reference', () => {
    const r = parseProductCatalogue({ version: 'x', entries: [{ productCode: 'tawarruq-personal', enabled: true, nameEn: 'x', nameAr: 'x', programmeIds: 'ALL', pricingRule: { kind: 'FIXED_PROFIT_AMOUNT', profitMinorUnits: '1' }, terms: {}, effectiveFromEpochSeconds: '1' }] }, ISLAMIC_PRODUCT_CODES);
    expect(r.ok).toBe(false); if (!r.ok) { expect(r.error.control).toBe('SH-18'); expect(r.error.reason).toBe('BOARD_RULING_REQUIRED'); }
  });
  it('refuses unknown keys, and a product not on the programme', () => {
    expect(parseProductCatalogue({ version: 'x', entries: [{ productCode: 'bnpl', enabled: false, nameEn: 'x', nameAr: 'x', programmeIds: 'ALL', pricingRule: { kind: 'FIXED_PROFIT_AMOUNT', profitMinorUnits: '0' }, terms: {}, effectiveFromEpochSeconds: '1', interestRate: 5 }] }, ISLAMIC_PRODUCT_CODES).ok).toBe(false);
    const a = expectOk(loadProductCatalogue('bank-a'));
    expect(entryFor(a, 'murabaha-scf', 'prg-0009', 1_790_000_000n).ok).toBe(false);
    expect(entryFor(a, 'bnpl', 'prg-0001', 1_790_000_000n).ok).toBe(false); // disabled
    expect(expectOk(entryFor(a, 'murabaha-scf', 'prg-0001', 1_790_000_000n)).boardRulingRef).toBe('SSB-A-2026-014');
  });
});

describe('quotation: from the tenant rule to pricing inputs', () => {
  const ctx = { principal: money(18_500_000n), tenorDays: 90, asOfEpochSeconds: 1_790_000_000n };
  it('a fixed profit amount passes through', () => {
    expect(expectOk(resolvePricingInputs({ kind: 'FIXED_PROFIT_AMOUNT', profitMinorUnits: '462500' }, ctx)).profitAmount?.minorUnits).toBe(462_500n);
  });
  it('a catalogue rate yields a sourced snapshot and the profit it implies over the tenor', () => {
    const r = expectOk(resolvePricingInputs({ kind: 'CATALOGUE_RATE', bp: '850', basis: 'FLAT', catalogueRef: 'c' }, ctx));
    expect(r.rate?.source).toBe('TENANT_CATALOGUE'); expect(r.rate?.rate.bp).toBe(850n);
    // 185 000 × 8.5% × 90/365 = 3 877.40
    expect(r.profitAmount?.minorUnits).toBe(387_740n);
  });
  it('benchmark plus margin refuses without the benchmark, and is bounded by the market range', () => {
    const rule = { kind: 'BENCHMARK_PLUS_MARGIN' as const, benchmarkCode: 'SAIBOR-3M', marginBp: '450', basis: 'REDUCING' as const, boundByMarketRange: true };
    expect(resolvePricingInputs(rule, ctx).ok).toBe(false);
    const benchmark = { code: 'SAIBOR-3M', rate: rate(560n, 'REDUCING'), asOfEpochSeconds: 1_790_000_000n, referenceId: 'pub-1' };
    expect(resolvePricingInputs(rule, { ...ctx, benchmark }).ok).toBe(false); // needs the range too
    const bounded = expectOk(resolvePricingInputs(rule, { ...ctx, benchmark, marketRange: { productClass: 'PERSONAL', lowBp: 600n, medianBp: 900n, highBp: 950n, asOfEpochSeconds: 1n, referenceId: 'm' } }));
    expect(bounded.rate?.rate.bp).toBe(950n); expect(bounded.rate?.source).toBe('RATE_PUBLISHER'); expect(bounded.rate?.sourceRef).toBe('pub-1');
  });
});

describe('the Murabaha module through the ProductModule interface', () => {
  const terms = expectOk(murabahaScf.validateTerms({ instalments: 'BULLET', structureCode: 'MURABAHA', maxTenorDays: 180 }));
  const base = { tenantId: 'bank-a', programmeId: 'prg-0001', counterpartyId: 'cpt-0001', requestedAmount: money(18_500_000n), requestedTenorDays: 90, asOf: at };
  it('is trade-first and refuses a quote without a trade', () => {
    expect(murabahaScf.descriptor.journeyShape).toBe('TRADE_FIRST');
    const r = murabahaScf.quote(terms, { ...base, pricing: { profitAmount: money(462_500n) } });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.control).toBe('SH-10');
  });
  it('quotes cost + profit = sale price with a schedule that sums exactly', () => {
    const q = expectOk(murabahaScf.quote(terms, { ...base, tradeReference: trade, pricing: { profitAmount: money(462_500n) } }));
    expect(q.totalPayable.minorUnits).toBe(18_962_500n); expect(q.totalCostOfCredit.minorUnits).toBe(462_500n);
    const repaid = q.schedule.filter((f) => f.direction === 'REPAYMENT').reduce((s, f) => s + f.amount.minorUnits, 0n);
    expect(repaid).toBe(18_962_500n);
    const three = expectOk(murabahaScf.validateTerms({ instalments: { count: 3 }, structureCode: 'MURABAHA', maxTenorDays: 180 }));
    const q3 = expectOk(murabahaScf.quote(three, { ...base, tradeReference: trade, pricing: { profitAmount: money(462_501n) } }));
    const parts = q3.schedule.filter((f) => f.direction === 'REPAYMENT').map((f) => f.amount.minorUnits);
    expect(parts.reduce((s, x) => s + x, 0n)).toBe(18_962_501n); expect(parts[2]! - parts[0]!).toBeLessThanOrEqual(2n);
  });
  it('the offer carries the platform APR, and the module never computed one', () => {
    const q = expectOk(murabahaScf.quote(terms, { ...base, tradeReference: trade, pricing: { profitAmount: money(462_500n) } }));
    const offer = expectOk(buildOffer(murabahaScf, q, at));
    expect(offer.apr.computedBy).toBe('core/pricing/apr.ts'); expect(offer.apr.bp).toBeGreaterThan(0n);
    expect(Object.keys(q.pricing).sort()).toEqual(['costAmount', 'profitAmount', 'salePriceAmount']);
    expect(offer.disclosureVersion).toMatch(/^[0-9a-f]{64}$/);
  });
  it('execute() opens a transaction in DRAFT and nothing later', () => {
    const q = expectOk(murabahaScf.quote(terms, { ...base, tradeReference: trade, pricing: { profitAmount: money(462_500n) } }));
    const approved = approvedRequest();
    const core = transactionCore('bank-a');
    const draft = expectOk(murabahaScf.execute(terms, approved, q, {
      transactionId: core.transactionId, structure: structureFor('bank-a'), riskPeriodRequiredSeconds: riskPeriodSecondsFor('bank-a'),
      maturityDateGregorian: core.maturityDateGregorian, maturityDateHijri: core.maturityDateHijri, decisionId: 'dec-1', creditPolicyVersion: '1.0.0', correlationId: 'c',
    }));
    expect(draft.state).toBe('DRAFT'); expect(draft.core.pricing.salePriceAmount.minorUnits).toBe(18_962_500n);
  });
});

describe('the registry', () => {
  it('holds a module once and refuses a family that disagrees with the Islamic list', () => {
    const r = new ProductRegistry().register(murabahaScf);
    expect(r.codes()).toEqual(['murabaha-scf']); expect(() => r.register(murabahaScf)).toThrow();
    expect(() => new ProductRegistry().register({ ...murabahaScf, descriptor: { ...murabahaScf.descriptor, family: 'CONVENTIONAL' } })).toThrow();
    expect(r.find('bnpl').ok).toBe(false);
  });
});
