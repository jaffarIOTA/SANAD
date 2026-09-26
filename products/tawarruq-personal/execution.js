/**
 * The Tawarruq sequence, as a state machine whose transitions accept only
 * their predecessor. Ownership before sale; title before onward sale;
 * proceeds before disbursement; one disbursement.
 */

import { ok, reject } from '../../core/kernel/result.js';

import { emptyOutbox, enqueue } from '../../core/outbox/outbox.js';

import { isStrictlyLater } from '../../core/time/tsa.js';



























// Belt and braces: the types already make a skipped step uncallable; at runtime a
// missing predecessor instant is refused rather than thrown.
const later = (a, b, what) =>
  b === undefined
    ? reject('OP-CHAIN', 'PREDECESSOR_MISSING', `${what} has no attested predecessor step`)
    : isStrictlyLater(a, b) ? ok(true) : reject('OP-CHAIN', 'TIMESTAMPS_NOT_MONOTONIC', `${what} must be attested strictly after the step before it`);

export function open(core) {
  if (core.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a bureau enquiry on record (T-5)');
  if (core.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without the consent the bureau enquiry ran under');
  return ok({ state: 'DRAFT', core });
}

export function purchaseCommodity(t, lot, at) {
  const check = later(at, t.core.openedAt, 'The purchase'); if (!check.ok) return check;
  if (lot.price.minorUnits !== t.core.quote.commodityCost.minorUnits) {
    return reject('SH-03', 'COMMODITY_COST_MISMATCH', 'The lot bought is not the cost the customer was quoted', { lot: String(lot.price.minorUnits), quoted: String(t.core.quote.commodityCost.minorUnits) });
  }
  return ok({ state: 'COMMODITY_PURCHASED', core: t.core, lot, purchasedAt: at });
}

export function sellToCustomer(t, saleDocumentRef, at) {
  const check = later(at, t.purchasedAt, 'The sale'); if (!check.ok) return check;
  if (saleDocumentRef.length === 0) return reject('OP-DETERMINACY', 'SALE_DOCUMENT_REQUIRED', 'The deferred sale is a signed instrument');
  return ok({ state: 'SOLD_TO_CUSTOMER', core: t.core, lot: t.lot, purchasedAt: t.purchasedAt, soldAt: at, saleDocumentRef });
}

export function transferTitle(t, transferRef, at) {
  const check = later(at, t.soldAt, 'Title transfer'); if (!check.ok) return check;
  return ok({ state: 'TITLE_TRANSFERRED', core: t.core, lot: t.lot, soldAt: t.soldAt, transferRef, transferredAt: at });
}

export function realiseProceeds(t, sale, at) {
  const check = later(at, t.transferredAt, 'The onward sale'); if (!check.ok) return check;
  if (sale.agencyRef !== undefined && !t.core.agency.permitted) {
    return reject('SH-18', 'AGENCY_NOT_PERMITTED', 'This tenant\'s board does not permit the institution to sell on as agent');
  }
  return ok({ state: 'PROCEEDS_REALISED', core: t.core, lot: t.lot, saleRef: sale.saleRef, proceeds: sale.proceeds, realisedAt: at });
}

/** Queues the disbursement and the bureau report. One each, keyed on the transaction. */
export function disburse(t, at) {
  const check = later(at, t.realisedAt, 'Disbursement'); if (!check.ok) return check;
  const key = `txn:${t.core.transactionId}`;
  const base = { tenantId: t.core.tenantId, subjectRef: t.core.transactionId, correlationId: t.core.correlationId };
  const first = enqueue(emptyOutbox(), { ...base, eventId: `${key}:disburse`, kind: 'PAYMENT_DISBURSE', idempotencyKey: `${key}:disburse`, payload: { beneficiaryRef: t.core.applicantRef, minorUnits: String(t.proceeds.minorUnits), currency: t.proceeds.currency } });
  if (!first.ok) return first;
  const both = enqueue(first.value, { ...base, eventId: `${key}:bureau`, kind: 'BUREAU_REPORT', idempotencyKey: `${key}:bureau`, payload: { facilityRef: t.core.transactionId, event: 'OPENED', minorUnits: String(t.core.quote.deferredSalePrice.minorUnits) } });
  if (!both.ok) return both;
  return ok({ state: 'DISBURSED', core: t.core, proceeds: t.proceeds, disbursedAt: at, outbox: both.value });
}
