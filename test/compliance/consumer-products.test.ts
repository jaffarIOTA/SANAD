/**
 * Adversarial cases for the consumer product modules (CLAUDE.md §11).
 * Each attempts a prohibited outcome and passes only when the attempt fails.
 */
import { describe, expect, it } from 'vitest';

import { loadProductCatalogue } from '@sanad/config/loader.ts';
import { money } from '@sanad/core/kernel/money.ts';
import { expectOk } from '@sanad/core/kernel/result.ts';
import { emptyOutbox, enqueue, eventsOfKind } from '@sanad/core/outbox/outbox.ts';
import { entryFor } from '@sanad/core/products/catalogue.ts';
import { buildOffer } from '@sanad/core/products/offer.ts';
import { resolvePricingInputs } from '@sanad/core/pricing/quotation.ts';
import { rate } from '@sanad/core/pricing/rate.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { bnpl } from '@sanad/products/bnpl/index.ts';
import { book } from '@sanad/products/bnpl/execution.ts';
import { tawarruqPersonal } from '@sanad/products/tawarruq-personal/index.ts';
import { disburse, purchaseCommodity, realiseProceeds, sellToCustomer, transferTitle } from '@sanad/products/tawarruq-personal/execution.ts';

const at = (s: number) => tsaInstant({ verified: true, genTimeEpochSeconds: BigInt(s), tokenDigest: `t${String(s)}`, authorityId: 'test' });
const T0 = 1_790_000_000;
const bankA = expectOk(loadProductCatalogue('bank-a'));
const fintechB = expectOk(loadProductCatalogue('fintech-b'));
const tawTerms = expectOk(tawarruqPersonal.validateTerms(expectOk(entryFor(bankA, 'tawarruq-personal', 'prg-0001', BigInt(T0))).terms));
const bnplTerms = expectOk(bnpl.validateTerms(expectOk(entryFor(fintechB, 'bnpl', 'prg-0001', BigInt(T0))).terms));
const benchmark = { code: 'SAIBOR-3M', rate: rate(560n, 'REDUCING'), asOfEpochSeconds: BigInt(T0), referenceId: 'pub-1' };
const range = { productClass: 'PERSONAL', lowBp: 600n, medianBp: 900n, highBp: 1_400n, asOfEpochSeconds: BigInt(T0), referenceId: 'm' };
const tawRule = expectOk(entryFor(bankA, 'tawarruq-personal', 'prg-0001', BigInt(T0))).pricingRule;
const inputs = (principal: bigint, months: number) => expectOk(resolvePricingInputs(tawRule, { principal: money(principal), tenorDays: months * 30, asOfEpochSeconds: BigInt(T0), benchmark, marketRange: range }));
const tawRequest = (principal: bigint, months: number, income: bigint, obligations = 0n) => ({
  tenantId: 'bank-a', programmeId: 'prg-0001', counterpartyId: 'app-1', requestedAmount: money(principal), requestedTenorDays: months * 30, asOf: at(T0),
  pricing: inputs(principal, months), affordability: { monthlyIncome: money(income), existingMonthlyObligations: money(obligations) },
});
const approved = { state: 'APPROVED' as const, core: { tenantId: 'bank-a' } } as unknown as Parameters<typeof tawarruqPersonal.execute>[1];

describe('quote a benchmark-linked product with a stale or missing publisher rate', () => {
  it('is refused, never priced on a default', () => {
    const r = resolvePricingInputs(tawRule, { principal: money(1_000_000n), tenorDays: 360, asOfEpochSeconds: BigInt(T0) });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('BENCHMARK_UNAVAILABLE');
  });
});

describe('exceed a tenant deduction ratio', () => {
  it('refuses with the citation attached', () => {
    // 50 000 over 12 months at ~10.1% → ~4 400/month against 10 000 income = 44% > 33.33%
    const r = tawarruqPersonal.quote(tawTerms, tawRequest(5_000_000n, 12, 1_000_000n));
    expect(r.ok).toBe(false); if (!r.ok) { expect(r.error.reason).toBe('DEDUCTION_RATIO_EXCEEDED'); expect(String(r.error.context?.['citation'])).toContain('Responsible Lending'); }
    expect(tawarruqPersonal.quote(tawTerms, tawRequest(5_000_000n, 12, 2_000_000n)).ok).toBe(true);
  });
  it('a term sheet without a citation for the threshold does not parse', () => {
    const raw = expectOk(entryFor(bankA, 'tawarruq-personal', 'prg-0001', BigInt(T0))).terms as Record<string, unknown>;
    const r = tawarruqPersonal.validateTerms({ ...raw, affordability: { maxDeductionPerTenThousand: 3333, citation: '' } });
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.reason).toBe('TERMS_CITATION_REQUIRED');
  });
});

describe('present an offer whose APR was not computed by core/pricing/apr.ts', () => {
  it('is not an Offer: the constructor is the only source and it stamps the authority', () => {
    const q = expectOk(tawarruqPersonal.quote(tawTerms, tawRequest(5_000_000n, 12, 2_000_000n)));
    const offer = expectOk(buildOffer(tawarruqPersonal, q, at(T0)));
    expect(offer.apr.computedBy).toBe('core/pricing/apr.ts');
    // The module's own quote carries no APR-shaped field.
    expect(Object.keys(q).filter((k) => /apr/i.test(k))).toEqual([]);
    expect(offer.apr.bp).toBeGreaterThan(q.rateSnapshot.rate.bp); // fees and compounding lift APR above the nominal
  });
});

describe('the Tawarruq sequence cannot be reordered', () => {
  const q = expectOk(tawarruqPersonal.quote(tawTerms, tawRequest(5_000_000n, 12, 2_000_000n)));
  const ctx = { transactionId: 'txn-t1', applicantRef: 'app-1', bureauEnquiryRef: 'enq-1', consentId: 'cns-1', openedAt: at(T0), correlationId: 'c' };
  const lot = { lotRef: 'lot-1', commodityCode: 'LME-AL', quantity: '10', unit: 'MT', price: money(5_000_000n), confirmedAtEpochSeconds: BigInt(T0 + 1) };

  it('approve without a bureau enquiry or consent is refused', () => {
    expect(tawarruqPersonal.execute(tawTerms, approved, q, { ...ctx, bureauEnquiryRef: '' }).ok).toBe(false);
    expect(tawarruqPersonal.execute(tawTerms, approved, q, { ...ctx, consentId: ' ' }).ok).toBe(false);
  });
  it('the customer is sold a commodity only after the institution bought it; onward sale only after title; one disbursement with the bureau report beside it', () => {
    const draft = expectOk(tawarruqPersonal.execute(tawTerms, approved, q, ctx));
    // @ts-expect-error — a DRAFT cannot be sold to the customer: the transition does not accept it
    expect(sellToCustomer(draft, 'doc-1', at(T0 + 2)).ok).toBe(false);
    const bought = expectOk(purchaseCommodity(draft, lot, at(T0 + 1)));
    expect(purchaseCommodity(draft, { ...lot, price: money(4_999_999n) }, at(T0 + 1)).ok).toBe(false); // not the cost quoted
    const sold = expectOk(sellToCustomer(bought, 'doc-1', at(T0 + 2)));
    // @ts-expect-error — proceeds cannot be realised before title passes
    expect(realiseProceeds(sold, { saleRef: 's', proceeds: money(5_000_000n) }, at(T0 + 3)).ok).toBe(false);
    const titled = expectOk(transferTitle(sold, 'tr-1', at(T0 + 3)));
    expect(transferTitle(sold, 'tr-1', at(T0 + 2)).ok).toBe(false); // not strictly later
    const realised = expectOk(realiseProceeds(titled, { saleRef: 's', proceeds: money(5_000_000n) }, at(T0 + 4)));
    const disbursed = expectOk(disburse(realised, at(T0 + 5)));
    expect(eventsOfKind(disbursed.outbox, 'PAYMENT_DISBURSE')).toHaveLength(1);
    expect(eventsOfKind(disbursed.outbox, 'BUREAU_REPORT')).toHaveLength(1);
    // disburse twice on one idempotency key: the outbox refuses the second
    const again = enqueue(disbursed.outbox, disbursed.outbox.events[0]!);
    expect(again.ok).toBe(false); if (!again.ok) expect(again.error.reason).toBe('DUPLICATE_SIDE_EFFECT');
  });
  it('agency is a board decision: a tenant whose board forbids it cannot sell on as agent', () => {
    const noAgency = { ...tawTerms, agencyPermitted: false };
    const draft = expectOk(tawarruqPersonal.execute(noAgency, approved, q, ctx));
    const titled = expectOk(transferTitle(expectOk(sellToCustomer(expectOk(purchaseCommodity(draft, lot, at(T0 + 1))), 'd', at(T0 + 2))), 'tr', at(T0 + 3)));
    const r = realiseProceeds(titled, { saleRef: 's', proceeds: money(5_000_000n), agencyRef: 'agency-1' }, at(T0 + 4));
    expect(r.ok).toBe(false); if (!r.ok) expect(r.error.control).toBe('SH-18');
  });
});

describe('BNPL', () => {
  const request = (basket: bigint, outstanding = 0n) => ({ tenantId: 'fintech-b', programmeId: 'prg-0001', counterpartyId: 'app-2', requestedAmount: money(basket), requestedTenorDays: 120, asOf: at(T0), pricing: { profitAmount: money(0n) }, affordability: { outstandingSameClass: money(outstanding) } });
  it('the consumer pays the basket and nothing more; the APR is zero and the platform still computed it', () => {
    const q = expectOk(bnpl.quote(bnplTerms, request(100_001n)));
    expect(q.schedule.filter((f) => f.direction === 'REPAYMENT').reduce((s, f) => s + f.amount.minorUnits, 0n)).toBe(100_001n);
    expect(q.merchantFee.amount.minorUnits).toBe(4_000n); expect(q.fees).toEqual([]);
    const offer = expectOk(buildOffer(bnpl, q, at(T0)));
    expect(offer.apr.bp).toBe(0n); expect(offer.apr.computedBy).toBe('core/pricing/apr.ts');
    expect(offer.disclosure.fees).toEqual([]);
  });
  it('refuses a consumer-side cost and a basket over the tenant consumer limit', () => {
    expect(bnpl.quote(bnplTerms, { ...request(100_000n), pricing: { profitAmount: money(1n) } }).ok).toBe(false);
    const r = bnpl.quote(bnplTerms, request(100_000n, 450_000n));
    expect(r.ok).toBe(false); if (!r.ok) { expect(r.error.reason).toBe('BNPL_CONSUMER_LIMIT_EXCEEDED'); expect(String(r.error.context?.['citation'])).toContain('BNPL'); }
  });
  it('books nothing without the bureau, and booking carries the bureau-reporting event', () => {
    const q = expectOk(bnpl.quote(bnplTerms, request(100_000n)));
    const bApproved = { state: 'APPROVED' as const, core: { tenantId: 'fintech-b' } } as unknown as Parameters<typeof bnpl.execute>[1];
    const ctx = { transactionId: 'txn-b1', applicantRef: 'app-2', merchantRef: 'mer-1', bureauEnquiryRef: 'enq-9', consentId: 'cns-9', openedAt: at(T0), correlationId: 'c' };
    expect(bnpl.execute(bnplTerms, bApproved, q, { ...ctx, bureauEnquiryRef: '' }).ok).toBe(false);
    const booked = expectOk(book(expectOk(bnpl.execute(bnplTerms, bApproved, q, ctx)), at(T0 + 1)));
    expect(eventsOfKind(booked.outbox, 'BUREAU_REPORT')).toHaveLength(1);
    expect(eventsOfKind(booked.outbox, 'PAYMENT_DISBURSE')[0]?.payload['minorUnits']).toBe('96000'); // basket less the merchant discount
  });
});

describe('the outbox', () => {
  it('refuses an effect without a key', () => {
    expect(enqueue(emptyOutbox(), { eventId: 'e', tenantId: 't', kind: 'NOTIFICATION', subjectRef: 's', idempotencyKey: '', payload: {}, correlationId: 'c' }).ok).toBe(false);
  });
});
