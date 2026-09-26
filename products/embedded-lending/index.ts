/**
 * Embedded lending: partner-originated, amount-first, fixed total, collected
 * as instalments or as a holdback on partner-routed revenue where permitted.
 */

import type { Approved } from '@sanad/core/origination/request.ts';
import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type Outbox, emptyOutbox, enqueue } from '@sanad/core/outbox/outbox.ts';
import type { Disclosure, ProductModule, Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import { cashFlows, flatInstalments, type Schedule } from '@sanad/core/pricing/schedule.ts';
import { type TsaInstant, isStrictlyLater } from '@sanad/core/time/tsa.ts';

export type CollectionMode = 'FIXED_INSTALMENTS' | 'REVENUE_LINKED';

export interface EmbeddedTerms {
  readonly collection: CollectionMode;
  /** Share of partner-routed revenue swept, per ten thousand. Only for REVENUE_LINKED. */
  readonly holdbackPerTenThousand: number;
  readonly maxAmount: Money;
  readonly maxTenorDays: number;
  readonly instalmentIntervalDays: number;
}

export interface EmbeddedQuote extends Quote {
  readonly productCode: 'embedded-lending';
  readonly collection: CollectionMode;
  readonly profitAmount: Money;
  readonly partnerRef: string;
  readonly schedule_: Schedule;
}

export interface EmbeddedExecutionContext {
  readonly transactionId: string;
  readonly merchantRef: string;
  readonly partnerRef: string;
  readonly bureauEnquiryRef: string;
  readonly consentId: string;
  readonly openedAt: TsaInstant;
  readonly correlationId: string;
}

export interface EmbeddedCore { readonly transactionId: string; readonly tenantId: string; readonly merchantRef: string; readonly partnerRef: string; readonly quote: EmbeddedQuote; readonly bureauEnquiryRef: string; readonly consentId: string; readonly openedAt: TsaInstant; readonly correlationId: string }
export interface Draft { readonly state: 'DRAFT'; readonly core: EmbeddedCore }
export interface Booked { readonly state: 'BOOKED'; readonly core: EmbeddedCore; readonly bookedAt: TsaInstant; readonly outbox: Outbox }

const KEYS = new Set(['collection', 'holdbackPerTenThousand', 'maxAmountMinorUnits', 'maxTenorDays', 'instalmentIntervalDays']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function parseEmbeddedTerms(raw: unknown): Result<EmbeddedTerms> {
  if (!isRecord(raw)) return reject('OP-DETERMINACY', 'TERMS_MALFORMED', 'Embedded lending terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in embedded lending terms', { keys: unknown.join(',') });
  const collection = raw['collection'];
  if (collection !== 'FIXED_INSTALMENTS' && collection !== 'REVENUE_LINKED') return reject('OP-DETERMINACY', 'TERMS_COLLECTION', 'collection is FIXED_INSTALMENTS or REVENUE_LINKED');
  const holdback = raw['holdbackPerTenThousand'] ?? 0;
  if (typeof holdback !== 'number' || !Number.isInteger(holdback) || holdback < 0 || holdback > 10_000) return reject('OP-DETERMINACY', 'TERMS_HOLDBACK', 'holdbackPerTenThousand is an integer in [0, 10000]');
  if (collection === 'REVENUE_LINKED' && holdback === 0) return reject('OP-DETERMINACY', 'TERMS_HOLDBACK_REQUIRED', 'Revenue-linked collection needs a holdback share');
  if (typeof raw['maxAmountMinorUnits'] !== 'string' || !/^\d+$/.test(raw['maxAmountMinorUnits'])) return reject('OP-DETERMINACY', 'TERMS_MAX_AMOUNT', 'maxAmountMinorUnits is an integer string');
  if (!isPosInt(raw['maxTenorDays']) || !isPosInt(raw['instalmentIntervalDays'])) return reject('OP-DETERMINACY', 'TERMS_TENOR', 'maxTenorDays and instalmentIntervalDays are positive integers');
  return ok({ collection, holdbackPerTenThousand: holdback, maxAmount: money(BigInt(raw['maxAmountMinorUnits'])), maxTenorDays: raw['maxTenorDays'], instalmentIntervalDays: raw['instalmentIntervalDays'] });
}

export function quoteEmbedded(terms: EmbeddedTerms, request: QuoteRequest): Result<EmbeddedQuote> {
  if (request.partnerRef === undefined || request.partnerRef.length === 0) return reject('OP-DETERMINACY', 'PARTNER_REQUIRED', 'Embedded finance is raised by an entitled partner (E-1)');
  if (request.pricing.profitAmount === undefined) return reject('SH-03', 'PROFIT_AMOUNT_REQUIRED', 'Priced by a profit amount fixed at inception');
  if (request.requestedAmount.minorUnits <= 0n) return reject('OP-DETERMINACY', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'The amount must be positive');
  if (request.requestedAmount.minorUnits > terms.maxAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_EXCEEDS_PRODUCT', 'Above the product maximum');
  if (request.requestedTenorDays > terms.maxTenorDays) return reject('OP-DETERMINACY', 'TENOR_EXCEEDS_PRODUCT', 'Tenor exceeds what this product allows');
  const preferred = request.preferences?.['collection'];
  if (preferred !== undefined && preferred !== 'FIXED_INSTALMENTS' && preferred !== 'REVENUE_LINKED') return reject('OP-DETERMINACY', 'COLLECTION_MODE_UNKNOWN', 'collection is FIXED_INSTALMENTS or REVENUE_LINKED');
  const collection: CollectionMode = preferred ?? 'FIXED_INSTALMENTS';
  if (collection === 'REVENUE_LINKED' && terms.collection !== 'REVENUE_LINKED') return reject('SH-18', 'COLLECTION_MODE_NOT_PERMITTED', 'This tenant does not permit revenue-linked collection (E-3)');
  const count = Math.max(1, Math.floor(request.requestedTenorDays / terms.instalmentIntervalDays));
  const schedule = flatInstalments(request.requestedAmount, request.pricing.profitAmount, count, terms.instalmentIntervalDays);
  if (!schedule.ok) return schedule;
  return ok({
    productCode: 'embedded-lending', financingAmount: request.requestedAmount, tenorDays: count * terms.instalmentIntervalDays,
    schedule: cashFlows(request.requestedAmount, schedule.value), fees: [], totalPayable: schedule.value.totalPayable, totalCostOfCredit: request.pricing.profitAmount,
    collection, profitAmount: request.pricing.profitAmount, partnerRef: request.partnerRef, schedule_: schedule.value,
  });
}

export function discloseEmbedded(q: EmbeddedQuote): Disclosure {
  return {
    financingAmount: q.financingAmount, tenorDays: q.tenorDays, instalmentCount: q.schedule_.instalments.length,
    ...(q.schedule_.instalments.every((i) => i.amount.minorUnits === q.schedule_.instalments[0]?.amount.minorUnits) && q.schedule_.instalments[0] !== undefined ? { instalmentAmount: q.schedule_.instalments[0].amount } : {}),
    totalCostOfCredit: q.totalCostOfCredit, totalPayable: q.totalPayable, fees: q.fees,
    lines: [
      { code: 'ADVANCE', labelEn: 'Advance', labelAr: 'المبلغ المقدَّم', amount: q.financingAmount },
      { code: 'PROFIT', labelEn: q.collection === 'REVENUE_LINKED' ? 'Fixed charge (collected from revenue)' : 'Fixed charge', labelAr: q.collection === 'REVENUE_LINKED' ? 'الرسم الثابت (يُحصَّل من الإيرادات)' : 'الرسم الثابت', amount: q.profitAmount },
      { code: 'TOTAL', labelEn: 'Total to repay', labelAr: 'إجمالي السداد', amount: add(q.financingAmount, q.profitAmount) },
    ],
  };
}

export function book(t: Draft, at: TsaInstant): Result<Booked> {
  if (!isStrictlyLater(at, t.core.openedAt)) return reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', 'Booking is attested after opening');
  const key = `txn:${t.core.transactionId}`;
  const base = { tenantId: t.core.tenantId, subjectRef: t.core.transactionId, correlationId: t.core.correlationId };
  const one = enqueue(emptyOutbox(), { ...base, eventId: `${key}:disburse`, kind: 'PAYMENT_DISBURSE', idempotencyKey: `${key}:disburse`, payload: { beneficiaryRef: t.core.merchantRef, minorUnits: String(t.core.quote.financingAmount.minorUnits), currency: t.core.quote.financingAmount.currency } });
  if (!one.ok) return one;
  const two = enqueue(one.value, { ...base, eventId: `${key}:bureau`, kind: 'BUREAU_REPORT', idempotencyKey: `${key}:bureau`, payload: { facilityRef: t.core.transactionId, event: 'OPENED', minorUnits: String(t.core.quote.totalPayable.minorUnits) } });
  if (!two.ok) return two;
  const three = enqueue(two.value, { ...base, eventId: `${key}:partner`, kind: 'PARTNER_CALLBACK', idempotencyKey: `${key}:partner`, payload: { partnerRef: t.core.partnerRef, event: 'BOOKED' } });
  if (!three.ok) return three;
  return ok({ state: 'BOOKED', core: t.core, bookedAt: at, outbox: three.value });
}

export const embeddedLending: ProductModule<EmbeddedTerms, EmbeddedQuote, EmbeddedExecutionContext, Draft> = {
  descriptor: { code: 'embedded-lending', nameEn: 'Embedded lending', nameAr: 'التمويل المدمج', journeyShape: 'AMOUNT_FIRST', family: 'CONVENTIONAL', consumer: false, requiresBoardRuling: false },
  validateTerms: parseEmbeddedTerms,
  quote: quoteEmbedded,
  disclose: discloseEmbedded,
  execute(_terms, approved: Approved, quote, context): Result<Draft> {
    if (context.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a bureau enquiry on record (E-4)');
    if (context.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without consent');
    if (context.partnerRef !== quote.partnerRef) return reject('OP-DETERMINACY', 'PARTNER_MISMATCH', 'The partner executing is not the partner that quoted');
    return ok({ state: 'DRAFT', core: { transactionId: context.transactionId, tenantId: approved.core.tenantId, merchantRef: context.merchantRef, partnerRef: context.partnerRef, quote, bureauEnquiryRef: context.bureauEnquiryRef, consentId: context.consentId, openedAt: context.openedAt, correlationId: context.correlationId } });
  },
};
