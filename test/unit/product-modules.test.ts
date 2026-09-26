/**
 * The two remaining product modules through the ProductModule interface, and
 * every module's descriptor against the registry and the catalogues.
 */
import { describe, expect, it } from 'vitest';

import { loadProductCatalogue } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { eventsOfKind } from '@sanad/core/outbox/outbox.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { ProductRegistry } from '@sanad/core/products/registry.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import { conventionalTerm, disburse } from '@sanad/products/conventional-term/index.ts';
import { book, embeddedLending } from '@sanad/products/embedded-lending/index.ts';
import { murabahaScf } from '@sanad/products/murabaha-scf/index.ts';
import { tawarruqPersonal } from '@sanad/products/tawarruq-personal/index.ts';

const T0 = 1_790_000_000;
const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const fintechB = expectOk(loadProductCatalogue('fintech-b'));
const approved = (tenantId: string) => ({ state: 'APPROVED' as const, core: { tenantId } }) as unknown as Parameters<typeof conventionalTerm.execute>[1];

describe('every module registers and every catalogue entry validates against its module', () => {
  const registry = new ProductRegistry().register(murabahaScf).register(tawarruqPersonal).register(bnpl).register(embeddedLending).register(conventionalTerm);
  it.each(['bank-a', 'fintech-b'] as const)('%s', (tenant) => {
    for (const entry of expectOk(loadProductCatalogue(tenant)).entries) {
      const module = expectOk(registry.find(entry.productCode));
      const terms = module.validateTerms(entry.terms);
      expect(terms.ok, `${tenant}/${entry.productCode}: ${terms.ok ? '' : terms.error.detail}`).toBe(true);
      expect(module.descriptor.requiresBoardRuling).toBe(module.descriptor.family === 'ISLAMIC');
    }
  });
});

describe('embedded lending', () => {
  const entry = expectOk(entryFor(fintechB, 'embedded-lending', 'prg-0001', BigInt(T0)));
  const terms = expectOk(embeddedLending.validateTerms(entry.terms));
  const inputs = expectOk(resolvePricingInputs(entry.pricingRule, { principal: money(10_000_000n), tenorDays: 180, asOfEpochSeconds: BigInt(T0) }));
  const base = { tenantId: 'fintech-b', programmeId: 'prg-0001', counterpartyId: 'mer-1', requestedAmount: money(10_000_000n), requestedTenorDays: 180, asOf: at(T0), pricing: inputs };
  it('needs a partner, fixes the total, and lets the tenant permit revenue-linked collection', () => {
    expect(embeddedLending.quote(terms, base).ok).toBe(false);
    const q = expectOk(embeddedLending.quote(terms, { ...base, partnerRef: 'aggregator-01', preferences: { collection: 'REVENUE_LINKED' } }));
    // 100 000 × 14% × 180/365 = 6 904.11
    expect(q.profitAmount.minorUnits).toBe(690_411n); expect(q.totalPayable.minorUnits).toBe(10_690_411n); expect(q.collection).toBe('REVENUE_LINKED');
    const fixedOnly = { ...terms, collection: 'FIXED_INSTALMENTS' as const };
    const r = embeddedLending.quote(fixedOnly, { ...base, partnerRef: 'aggregator-01', preferences: { collection: 'REVENUE_LINKED' } });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('COLLECTION_MODE_NOT_PERMITTED');
    expect(expectOk(buildOffer(embeddedLending, q, at(T0))).apr.bp).toBeGreaterThan(1_400n); // flat 14% over 6 months compounds above the nominal
  });
  it('booking queues disbursement, bureau report and partner callback, once each', () => {
    const q = expectOk(embeddedLending.quote(terms, { ...base, partnerRef: 'aggregator-01' }));
    const ctx = { transactionId: 'txn-e1', merchantRef: 'mer-1', partnerRef: 'aggregator-01', bureauEnquiryRef: 'enq', consentId: 'cns', openedAt: at(T0), correlationId: 'c' };
    expect(embeddedLending.execute(terms, approved('fintech-b'), q, { ...ctx, partnerRef: 'someone-else' }).ok).toBe(false);
    const booked = expectOk(book(expectOk(embeddedLending.execute(terms, approved('fintech-b'), q, ctx)), at(T0 + 1)));
    expect(booked.outbox.events.map((e) => e.kind).sort()).toEqual(['BUREAU_REPORT', 'PARTNER_CALLBACK', 'PAYMENT_DISBURSE']);
  });
});

describe('conventional term loan', () => {
  const entry = expectOk(entryFor(fintechB, 'conventional-term', 'prg-0001', BigInt(T0)));
  const terms = expectOk(conventionalTerm.validateTerms(entry.terms));
  const benchmark = { code: 'SAIBOR-3M', rate: rate(560n, 'REDUCING'), asOfEpochSeconds: BigInt(T0), referenceId: 'pub-1' };
  const range = { productClass: 'PERSONAL', lowBp: 600n, medianBp: 900n, highBp: 1_500n, asOfEpochSeconds: BigInt(T0), referenceId: 'm' };
  const inputs = expectOk(resolvePricingInputs(entry.pricingRule, { principal: money(10_000_000n), tenorDays: 360, asOfEpochSeconds: BigInt(T0), benchmark, marketRange: range }));
  const base = { tenantId: 'fintech-b', programmeId: 'prg-0001', counterpartyId: 'app-1', requestedAmount: money(10_000_000n), requestedTenorDays: 360, asOf: at(T0), pricing: inputs, affordability: { monthlyIncome: money(3_000_000n), existingMonthlyObligations: money(0n) } };
  it('prices at benchmark + margin on a reducing balance, with the admin fee in the APR', () => {
    const q = expectOk(conventionalTerm.quote(terms, base));
    expect(q.rateSnapshot.rate.bp).toBe(1_160n); expect(q.rateSnapshot.source).toBe('RATE_PUBLISHER'); expect(q.months).toBe(12);
    expect(q.fees[0]?.amount.minorUnits).toBe(50_000n);
    const offer = expectOk(buildOffer(conventionalTerm, q, at(T0)));
    expect(offer.apr.bp).toBeGreaterThan(1_160n); expect(offer.disclosure.lines.map((l) => l.code)).toEqual(['PRINCIPAL', 'INTEREST']);
  });
  it('refuses over the deduction cap and disburses once with the bureau report', () => {
    expect(conventionalTerm.quote(terms, { ...base, affordability: { monthlyIncome: money(1_000_000n), existingMonthlyObligations: money(600_000n) } }).ok).toBe(false);
    const q = expectOk(conventionalTerm.quote(terms, base));
    const d = expectOk(disburse(expectOk(conventionalTerm.execute(terms, approved('fintech-b'), q, { transactionId: 'txn-c1', applicantRef: 'app-1', bureauEnquiryRef: 'enq', consentId: 'cns', openedAt: at(T0), correlationId: 'c' })), at(T0 + 1)));
    expect(eventsOfKind(d.outbox, 'PAYMENT_DISBURSE')).toHaveLength(1); expect(eventsOfKind(d.outbox, 'BUREAU_REPORT')).toHaveLength(1);
  });
});
