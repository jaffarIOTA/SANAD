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

import { type Money, isNegative, isPositive } from '@sanad/core/kernel/money.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

/**
 * The only account class this module can produce. Not a union with one member
 * today and two tomorrow — widening it is the defect.
 */
export type NonIncomeAccountClass = 'CHARITY_LIABILITY';

export type CharitySourceReason =
  | 'LATE_PAYMENT'
  | 'NON_COMPLIANT_INCOME'
  | 'INCIDENTAL_IMPERMISSIBLE_RECEIPT';

/** The outcome of assessing a delinquent counterparty (BR-E04). */
export type AbilityAssessment = 'ABLE_BUT_UNWILLING' | 'UNABLE';

export interface CharityLedgerEntry {
  readonly entryId: string;
  readonly tenantId: string;
  readonly transactionId: string;
  /** Fixed. There is no other value this field can take. */
  readonly accountClass: NonIncomeAccountClass;
  readonly amount: Money;
  readonly reason: CharitySourceReason;
  /** The Board-approved basis on which the amount was computed. */
  readonly computationBasisConfigKey: string;
  readonly shariahApprovalId: string;
  readonly recordedAt: TsaInstant;
  /** Set on disbursement to a Board-approved recipient. */
  readonly disbursementRef?: string;
}

export interface LateAmountRequest {
  readonly entryId: string;
  readonly tenantId: string;
  readonly transactionId: string;
  readonly amount: Money;
  readonly assessment: AbilityAssessment;
  readonly computationBasisConfigKey: string;
  readonly shariahApprovalId: string;
  readonly recordedAt: TsaInstant;
}

/**
 * Post a late payment amount.
 *
 * Returns a charity ledger entry or a rejection. It cannot return anything that
 * a general ledger would recognise as revenue, because no such type is in scope.
 */
export function postLateAmount(request: LateAmountRequest): Result<CharityLedgerEntry> {
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
  entry: CharityLedgerEntry,
  recipientId: string,
  approvedRecipients: readonly string[],
  disbursementRef: string,
): Result<CharityLedgerEntry> {
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
