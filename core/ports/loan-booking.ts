/**
 * Booking an approved, disbursed loan in the institution's loan system (UAE
 * M6): the loan system creates the customer if it does not hold one, creates
 * the loan contract on Sanad's terms, and returns the loan account number.
 *
 * A port: capability-named, vendor-free. It is for rate-priced products and,
 * under ADR 0007, SME Tawarruq (its deferred price stays the contract's figure);
 * never for Murabaha, whose obligations are booked account-shaped through
 * CoreBankingProvider (CLAUDE.md §2).
 * The rate and APR are Sanad's — the loan system is told them, never asked;
 * an adapter refuses a booking whose echoed rate differs. Unavailability is a
 * typed outcome, never a throw; a booking that did not happen records nothing.
 */
import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';
import type { RailOutcome } from './rail.ts';

export interface LoanBookingRequest {
  readonly tenantId: string;
  /** Sanad's application id: the loan system's external reference. */
  readonly applicationId: string;
  readonly borrower: {
    readonly legalNameEn: string;
    /** The business's registration (trade licence) reference. Sent to the loan system, never logged. */
    readonly registrationRef: string;
  };
  /** The institution's product code in the loan system, from the tenant's configuration. */
  readonly productCode: string;
  readonly principal: Money;
  /** Sanad's nominal annual rate, integer basis points. */
  readonly rateBp: bigint;
  /** Computed by core/pricing/apr.ts; told to the loan system for reconciliation, never replaced by its figure. */
  readonly aprBp: bigint;
  readonly numberOfPayments: number;
  /** yyyy-mm-dd. */
  readonly firstPaymentDate: string;
  readonly paymentDay: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface LoanBooking {
  /** The loan system's account (contract) number, as staff and statements show it. */
  readonly loanAccountNumber: string;
  /** The loan system's internal reference for the contract. */
  readonly contractRef: string;
  /** The loan system's reference for the customer. */
  readonly customerRef: string;
}

export interface LoanBookingPort {
  readonly source: 'LIVE' | 'FIXTURE';
  bookLoan(request: LoanBookingRequest): Promise<Result<RailOutcome<LoanBooking>>>;
}
