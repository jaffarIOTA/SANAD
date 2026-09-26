import type { Approved } from '@sanad/core/origination/request.ts';
import { type Money, add, money } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type Outbox, emptyOutbox, enqueue } from '@sanad/core/outbox/outbox.ts';
import type { Disclosure, ProductModule, Quote, QuoteRequest } from '@sanad/core/products/module.ts';
import type { RateSnapshot } from '@sanad/core/pricing/rate.ts';
import { cashFlows, reducingBalanceMonthly, type Schedule } from '@sanad/core/pricing/schedule.ts';
import { type TsaInstant, isStrictlyLater } from '@sanad/core/time/tsa.ts';

export interface TermLoanTerms {
  readonly minMonths: number;
  readonly maxMonths: number;
  readonly maxAmount: Money;
  readonly adminFee: Money;
  readonly affordability: { readonly maxDeductionPerTenThousand: number; readonly citation: string };
}

export interface TermLoanQuote extends Quote {
  readonly productCode: 'conventional-term';
  readonly months: number;
  readonly monthlyInstalment: Money;
  readonly interestAmount: Money;
  readonly rateSnapshot: RateSnapshot;
  readonly schedule_: Schedule;
}

export interface TermLoanExecutionContext { readonly transactionId: string; readonly applicantRef: string; readonly bureauEnquiryRef: string; readonly consentId: string; readonly openedAt: TsaInstant; readonly correlationId: string }
export interface TermLoanCore { readonly transactionId: string; readonly tenantId: string; readonly applicantRef: string; readonly quote: TermLoanQuote; readonly bureauEnquiryRef: string; readonly consentId: string; readonly openedAt: TsaInstant; readonly correlationId: string }
export interface Draft { readonly state: 'DRAFT'; readonly core: TermLoanCore }
export interface Disbursed { readonly state: 'DISBURSED'; readonly core: TermLoanCore; readonly disbursedAt: TsaInstant; readonly outbox: Outbox }

const KEYS = new Set(['minMonths', 'maxMonths', 'maxAmountMinorUnits', 'adminFeeMinorUnits', 'affordability']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

export function parseTermLoanTerms(raw: unknown): Result<TermLoanTerms> {
  if (!isRecord(raw)) return reject('OP-DETERMINACY', 'TERMS_MALFORMED', 'Term loan terms are an object');
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return reject('OP-DETERMINACY', 'TERMS_UNKNOWN_KEY', 'Unknown key in term loan terms', { keys: unknown.join(',') });
  if (!isPosInt(raw['minMonths']) || !isPosInt(raw['maxMonths']) || raw['minMonths'] > raw['maxMonths']) return reject('OP-DETERMINACY', 'TERMS_MONTHS', 'minMonths ≤ maxMonths');
  if (typeof raw['maxAmountMinorUnits'] !== 'string' || !/^\d+$/.test(raw['maxAmountMinorUnits'])) return reject('OP-DETERMINACY', 'TERMS_MAX_AMOUNT', 'maxAmountMinorUnits is an integer string');
  if (raw['adminFeeMinorUnits'] !== undefined && (typeof raw['adminFeeMinorUnits'] !== 'string' || !/^\d+$/.test(raw['adminFeeMinorUnits']))) return reject('OP-DETERMINACY', 'TERMS_FEE', 'adminFeeMinorUnits is an integer string');
  const aff = raw['affordability'];
  if (!isRecord(aff) || !isPosInt(aff['maxDeductionPerTenThousand']) || aff['maxDeductionPerTenThousand'] > 10_000) return reject('OP-DETERMINACY', 'TERMS_AFFORDABILITY', 'affordability.maxDeductionPerTenThousand is an integer in (0, 10000]');
  if (typeof aff['citation'] !== 'string' || aff['citation'].trim().length < 10) return reject('OP-DETERMINACY', 'TERMS_CITATION_REQUIRED', 'A regulatory threshold carries the regulation and article it comes from');
  return ok({ minMonths: raw['minMonths'], maxMonths: raw['maxMonths'], maxAmount: money(BigInt(raw['maxAmountMinorUnits'])), adminFee: money(raw['adminFeeMinorUnits'] === undefined ? 0n : BigInt(raw['adminFeeMinorUnits'] as string)), affordability: { maxDeductionPerTenThousand: aff['maxDeductionPerTenThousand'], citation: aff['citation'] } });
}

export function quoteTermLoan(terms: TermLoanTerms, request: QuoteRequest): Result<TermLoanQuote> {
  if (request.pricing.rate === undefined) return reject('PLAT-03', 'RATE_REQUIRED', 'A term loan is priced from a sourced rate (C-1)');
  if (request.requestedAmount.minorUnits <= 0n) return reject('OP-DETERMINACY', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'The amount must be positive');
  if (request.requestedAmount.minorUnits > terms.maxAmount.minorUnits) return reject('OP-LIMIT', 'AMOUNT_EXCEEDS_PRODUCT', 'Above the product maximum');
  const months = Math.round(request.requestedTenorDays / 30);
  if (months < terms.minMonths || months > terms.maxMonths) return reject('OP-DETERMINACY', 'TENOR_OUTSIDE_PRODUCT', 'Tenor outside what this product allows');
  const schedule = reducingBalanceMonthly(request.requestedAmount, { ...request.pricing.rate.rate, basis: 'REDUCING' }, months);
  if (!schedule.ok) return schedule;
  const s = schedule.value;
  const instalment = s.instalments[0]?.amount ?? money(0n);
  const a = request.affordability;
  if (a?.monthlyIncome === undefined || a.existingMonthlyObligations === undefined) return reject('OP-DETERMINACY', 'AFFORDABILITY_FACTS_MISSING', 'Income and existing obligations are required (C-3)');
  if (a.monthlyIncome.minorUnits <= 0n) return reject('OP-DETERMINACY', 'INCOME_NOT_POSITIVE', 'No income, no instalment');
  const deduction = (add(instalment, a.existingMonthlyObligations).minorUnits * 10_000n) / a.monthlyIncome.minorUnits;
  if (deduction > BigInt(terms.affordability.maxDeductionPerTenThousand)) return reject('OP-LIMIT', 'DEDUCTION_RATIO_EXCEEDED', 'The instalment would exceed the tenant\'s responsible-lending cap', { deductionPerTenThousand: String(deduction), cap: String(terms.affordability.maxDeductionPerTenThousand), citation: terms.affordability.citation });
  const fees = terms.adminFee.minorUnits > 0n ? [{ code: 'ADMIN', labelEn: 'Administration fee', labelAr: 'رسوم إدارية', amount: terms.adminFee, when: 'UPFRONT' as const }] : [];
  return ok({
    productCode: 'conventional-term', financingAmount: request.requestedAmount, tenorDays: months * 30, months,
    schedule: cashFlows(request.requestedAmount, s, fees.map((f) => f.amount)), fees,
    totalPayable: add(s.totalPayable, terms.adminFee), totalCostOfCredit: add(s.totalProfit, terms.adminFee),
    monthlyInstalment: instalment, interestAmount: s.totalProfit, rateSnapshot: request.pricing.rate, schedule_: s,
  });
}

export function discloseTermLoan(q: TermLoanQuote): Disclosure {
  return {
    financingAmount: q.financingAmount, tenorDays: q.tenorDays, instalmentCount: q.months, instalmentAmount: q.monthlyInstalment,
    totalCostOfCredit: q.totalCostOfCredit, totalPayable: q.totalPayable, fees: q.fees,
    lines: [
      { code: 'PRINCIPAL', labelEn: 'Loan amount', labelAr: 'مبلغ القرض', amount: q.financingAmount },
      { code: 'INTEREST', labelEn: 'Total interest', labelAr: 'إجمالي الفائدة', amount: q.interestAmount },
    ],
  };
}

export function disburse(t: Draft, at: TsaInstant): Result<Disbursed> {
  if (!isStrictlyLater(at, t.core.openedAt)) return reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', 'Disbursement is attested after opening');
  const key = `txn:${t.core.transactionId}`;
  const base = { tenantId: t.core.tenantId, subjectRef: t.core.transactionId, correlationId: t.core.correlationId };
  const one = enqueue(emptyOutbox(), { ...base, eventId: `${key}:disburse`, kind: 'PAYMENT_DISBURSE', idempotencyKey: `${key}:disburse`, payload: { beneficiaryRef: t.core.applicantRef, minorUnits: String(t.core.quote.financingAmount.minorUnits), currency: t.core.quote.financingAmount.currency } });
  if (!one.ok) return one;
  const two = enqueue(one.value, { ...base, eventId: `${key}:bureau`, kind: 'BUREAU_REPORT', idempotencyKey: `${key}:bureau`, payload: { facilityRef: t.core.transactionId, event: 'OPENED', minorUnits: String(t.core.quote.totalPayable.minorUnits) } });
  if (!two.ok) return two;
  return ok({ state: 'DISBURSED', core: t.core, disbursedAt: at, outbox: two.value });
}

export const conventionalTerm: ProductModule<TermLoanTerms, TermLoanQuote, TermLoanExecutionContext, Draft> = {
  descriptor: { code: 'conventional-term', nameEn: 'Term loan', nameAr: 'قرض لأجل', journeyShape: 'AMOUNT_FIRST', family: 'CONVENTIONAL', consumer: true, requiresBoardRuling: false },
  validateTerms: parseTermLoanTerms,
  quote: quoteTermLoan,
  disclose: discloseTermLoan,
  execute(_terms, approved: Approved, quote, context): Result<Draft> {
    if (context.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a bureau enquiry on record (C-4)');
    if (context.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without consent');
    return ok({ state: 'DRAFT', core: { transactionId: context.transactionId, tenantId: approved.core.tenantId, applicantRef: context.applicantRef, quote, bureauEnquiryRef: context.bureauEnquiryRef, consentId: context.consentId, openedAt: context.openedAt, correlationId: context.correlationId } });
  },
};
