import { ok, reject } from '../../core/kernel/result.js';
import { emptyOutbox, enqueue } from '../../core/outbox/outbox.js';
import { isStrictlyLater } from '../../core/time/tsa.js';


















export function open(core) {
  if (core.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a bureau enquiry on record (B-3)');
  if (core.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without the consent the enquiry ran under');
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
