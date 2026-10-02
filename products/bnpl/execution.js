import { ok, reject } from '../../core/kernel/result.js';
import { emptyOutbox, enqueue } from '../../core/outbox/outbox.js';
import { isStrictlyLater } from '../../core/time/tsa.js';


import { BNPL_RULES } from './terms.js';

/**
 * What the Rules require to be true of the consumer before any dealing
 * (Art. 19(6), 20(3), 20(4)). Facts, from the identity rail and the applicant
 * snapshot; never typed by the consumer or the merchant.
 */










/** Art. 20(3). */
export const ART_20_3_MIN_AGE_HIJRI_YEARS = 18;

















export function open(core) {
  if (core.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a bureau enquiry on record (B-3)');
  if (core.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without the consent the enquiry ran under');
  const e = core.eligibility;
  if (e.identityVerificationRef.trim().length === 0) {
    return reject('OP-DETERMINACY', 'IDENTITY_NOT_VERIFIED', 'The consumer is identified through a reliable, independent source before any dealing', { citation: `${BNPL_RULES}, Art. 19(6)` });
  }
  if (!Number.isInteger(e.ageHijriYears) || e.ageHijriYears < ART_20_3_MIN_AGE_HIJRI_YEARS) {
    return reject('OP-DETERMINACY', 'BNPL_CONSUMER_UNDER_AGE', 'No transaction with a consumer under eighteen Hijri years', { citation: `${BNPL_RULES}, Art. 20(3)` });
  }
  if (!e.residentInKingdom && (e.nonResidentNonObjectionRef === undefined || e.nonResidentNonObjectionRef.trim().length === 0)) {
    return reject('OP-DETERMINACY', 'BNPL_CONSUMER_NON_RESIDENT', 'No transaction with a non-resident consumer without a SAMA written non-objection', { citation: `${BNPL_RULES}, Art. 20(4)` });
  }
  return ok({ state: 'DRAFT', core });
}

/** Booking settles the merchant (basket less discount) and reports the facility. One each. */
export function book(t, at) {
  if (!isStrictlyLater(at, t.core.openedAt)) return reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', 'Booking is attested after opening');
  const key = `txn:${t.core.transactionId}`;
  const base = { tenantId: t.core.tenantId, subjectRef: t.core.transactionId, correlationId: t.core.correlationId };
  const settle = t.core.quote.basket.minorUnits - t.core.quote.merchantFee.amount.minorUnits;
  const one = enqueue(emptyOutbox(), { ...base, eventId: `${key}:merchant`, kind: 'PAYMENT_DISBURSE', idempotencyKey: `${key}:merchant`, payload: { beneficiaryRef: t.core.merchantRef, minorUnits: String(settle), currency: t.core.quote.basket.currency } });
  if (!one.ok) return one;
  const two = enqueue(one.value, { ...base, eventId: `${key}:bureau`, kind: 'BUREAU_REPORT', idempotencyKey: `${key}:bureau`, payload: { facilityRef: t.core.transactionId, event: 'OPENED', minorUnits: String(t.core.quote.basket.minorUnits) } });
  if (!two.ok) return two;
  return ok({ state: 'BOOKED', core: t.core, bookedAt: at, outbox: two.value });
}
