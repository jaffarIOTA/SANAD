/**
 * The segregated charity liability ledger.
 *
 * Late payment amounts, non-compliant income identified by review and incidental
 * impermissible receipts all post here and nowhere else. There is no function in
 * this module that returns a revenue posting, no account class other than the
 * one below, and no mapping table a later change could quietly extend — the
 * chart-of-accounts mapping is enforced in accounting configuration so that no
 * code change can route these amounts to income (SH-13, SDD §5.4.5).
 *
 * Two conditions gate a late amount, and both matter:
 *   - it applies only where the counterparty is able but unwilling to pay; an
 *     assessment of inability routes to hardship and suspends charges (SH-14);
 *   - the amount is compensation held for disbursement, never the institution's.
 */

import { isNegative, isPositive } from '../../../core/kernel/money.js';
import { ok, reject } from '../../../core/kernel/result.js';


/**
 * The only account class this module can produce. Not a union with one member
 * today and two tomorrow — widening it is the defect.
 */
 




































/**
 * Post a late payment amount.
 *
 * Returns a charity ledger entry or a rejection. It cannot return anything that
 * a general ledger would recognise as revenue, because no such type is in scope.
 */
export function postLateAmount(request) {
  if (request.assessment === 'UNABLE') {
    return reject(
      'SH-14',
      'HARDSHIP_SUSPENDS_LATE_AMOUNTS',
      'The counterparty is assessed as unable to pay; the case belongs in the hardship process and late amounts are suspended',
      { transactionId: request.transactionId },
    );
  }
  if (isNegative(request.amount) || !isPositive(request.amount)) {
    return reject('OP-DETERMINACY', 'LATE_AMOUNT_NOT_POSITIVE', 'A late amount must be positive');
  }
  if (request.computationBasisConfigKey.length === 0) {
    return reject(
      'SH-13',
      'NO_COMPUTATION_BASIS',
      'A late amount must name the Board-approved basis on which it was computed',
      { transactionId: request.transactionId },
    );
  }

  return ok({
    entryId: request.entryId,
    tenantId: request.tenantId,
    transactionId: request.transactionId,
    accountClass: 'CHARITY_LIABILITY',
    amount: request.amount,
    reason: 'LATE_PAYMENT',
    computationBasisConfigKey: request.computationBasisConfigKey,
    shariahApprovalId: request.shariahApprovalId,
    recordedAt: request.recordedAt,
  });
}

/**
 * Disburse to a Board-approved recipient. The recipient register is tenant
 * configuration owned by the Board; this function will not accept a recipient
 * that is not on the register it was handed.
 */
export function disburse(
  entry,
  recipientId,
  approvedRecipients,
  disbursementRef,
) {
  if (!approvedRecipients.includes(recipientId)) {
    return reject(
      'SH-13',
      'RECIPIENT_NOT_APPROVED',
      'Disbursement is only to recipients on the Board-approved register',
      { recipientId },
    );
  }
  if (entry.disbursementRef !== undefined) {
    return reject('SH-13', 'ALREADY_DISBURSED', 'This entry has already been disbursed', {
      entryId: entry.entryId,
    });
  }
  return ok({ ...entry, disbursementRef });
}
