 function _optionalChain(ops) { let lastAccessLHS = undefined; let value = ops[0]; let i = 1; while (i < ops.length) { const op = ops[i]; const fn = ops[i + 1]; i += 2; if ((op === 'optionalAccess' || op === 'optionalCall') && value == null) { return undefined; } if (op === 'access' || op === 'optionalAccess') { lastAccessLHS = value; value = fn(value); } else if (op === 'call' || op === 'optionalCall') { value = fn((...args) => value.call(lastAccessLHS, ...args)); lastAccessLHS = undefined; } } return value; }/**
 * Between approval and booking: a draft that knows which bureau enquiry,
 * consent and registry check it rests on, then one disbursement — after the
 * programme guarantee is issued, where the term sheet requires it. The
 * disbursement and the bureau report are outbox events, keyed on the
 * transaction, so neither can happen twice or not at all.
 */

import { ok, reject } from '../../core/kernel/result.js';
import { emptyOutbox, enqueue } from '../../core/outbox/outbox.js';
import { isStrictlyLater } from '../../core/time/tsa.js';


























export function open(terms, tenantId, quote, context) {
  if (context.bureauEnquiryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUREAU_ENQUIRY_REQUIRED', 'No approval without a commercial bureau enquiry on record');
  if (context.consentId.trim().length === 0) return reject('OP-DETERMINACY', 'CONSENT_MISSING', 'No approval without the consent the bureau enquiry ran under');
  if (context.businessRegistryRef.trim().length === 0) return reject('OP-DETERMINACY', 'BUSINESS_REGISTRY_CHECK_REQUIRED', 'No approval without the registry check of the enterprise and its signatories');
  return ok({ state: 'DRAFT', core: { ...context, tenantId, quote, guaranteeRequired: _optionalChain([terms, 'access', _ => _.guarantee, 'optionalAccess', _2 => _2.requiredBeforeDisbursement]) === true } });
}

export function disburse(t, at, guaranteeRef) {
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
