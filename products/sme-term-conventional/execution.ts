/**
 * Between approval and booking: a draft that knows which bureau enquiry,
 * consent and registry check it rests on, then one disbursement — after the
 * programme guarantee is issued, where the term sheet requires it. The
 * disbursement and the bureau report are outbox events, keyed on the
 * transaction, so neither can happen twice or not at all.
 */

import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { type Outbox, emptyOutbox, enqueue } from '@sanad/core/outbox/outbox.ts';
import { type TsaInstant, isStrictlyLater } from '@sanad/core/time/tsa.ts';

import type { SmeConventionalQuote } from './pricing.ts';
import type { SmeConventionalTerms } from './terms.ts';

export interface SmeExecutionContext {
  readonly transactionId: string;
  /** The enterprise, by reference. Never its registration number or a signatory's identifier. */
  readonly applicantRef: string;
  /** The commercial bureau enquiry the approval rested on. */
  readonly bureauEnquiryRef: string;
  readonly consentId: string;
  /** The business-registry verification of the enterprise and its signatories. */
  readonly businessRegistryRef: string;
  readonly openedAt: TsaInstant;
  readonly correlationId: string;
}

export interface SmeCore extends SmeExecutionContext {
  readonly tenantId: string;
  readonly quote: SmeConventionalQuote;
  readonly guaranteeRequired: boolean;
}

export interface Draft { readonly state: 'DRAFT'; readonly core: SmeCore }
export interface Disbursed { readonly state: 'DISBURSED'; readonly core: SmeCore; readonly guaranteeRef?: string; readonly disbursedAt: TsaInstant; readonly outbox: Outbox }

export function open(terms: SmeConventionalTerms, tenantId: string, quote: SmeConventionalQuote, context: SmeExecutionContext): Result<Draft> {
  if (context.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a commercial bureau enquiry on record');
  if (context.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without the consent the bureau enquiry ran under');
  if (context.businessRegistryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUSINESS_REGISTRY_CHECK_REQUIRED', 'No approval without the registry check of the enterprise and its signatories');
  return ok({ state: 'DRAFT', core: { ...context, tenantId, quote, guaranteeRequired: terms.guarantee?.requiredBeforeDisbursement === true } });
}

export function disburse(t: Draft, at: TsaInstant, guaranteeRef?: string): Result<Disbursed> {
  if (!isStrictlyLater(at, t.core.openedAt)) return reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', 'Disbursement is attested after opening');
  if (t.core.guaranteeRequired && (guaranteeRef === undefined || guaranteeRef.trim().length === 0)) return reject('OP-DETERMINACY', 'GUARANTEE_NOT_ISSUED', 'The term sheet requires the programme guarantee to be issued before disbursement');
  const key = `txn:${t.core.transactionId}`;
  const base = { tenantId: t.core.tenantId, subjectRef: t.core.transactionId, correlationId: t.core.correlationId };
  const one = enqueue(emptyOutbox(), { ...base, eventId: `${key}:disburse`, kind: 'PAYMENT_DISBURSE', idempotencyKey: `${key}:disburse`, payload: { beneficiaryRef: t.core.applicantRef, minorUnits: String(t.core.quote.financingAmount.minorUnits), currency: t.core.quote.financingAmount.currency } });
  if (!one.ok) return one;
  const two = enqueue(one.value, { ...base, eventId: `${key}:bureau`, kind: 'BUREAU_REPORT', idempotencyKey: `${key}:bureau`, payload: { facilityRef: t.core.transactionId, event: 'OPENED', minorUnits: String(t.core.quote.totalPayable.minorUnits) } });
  if (!two.ok) return two;
  return ok({ state: 'DISBURSED', core: t.core, ...(guaranteeRef === undefined ? {} : { guaranteeRef }), disbursedAt: at, outbox: two.value });
}
