/**
 * Core banking port.
 *
 * The core holds party, accounts, ledger, payments and the instalment schedule.
 * It does not hold the contract logic, and its lending intelligence is
 * deliberately unused — that concentrates the Islamic structure where the Board
 * can inspect it, and it is the precondition for selling this platform to an
 * institution that runs a different core (SDD §3.9, NFR-14).
 *
 * No vendor name, DTO, identifier scheme or terminology appears in this file or
 * anywhere else in `core/`. Replacing the core banking platform is implementing
 * this interface (AP-04).
 *
 * Read `BookObligationRequest` carefully: it carries a fixed total and a
 * schedule. It carries nothing else. If a core banking API requires a
 * rate-shaped field, the adapter supplies a structural equivalent and records it
 * as a known deviation in its own directory; the concept does not cross into the
 * domain model (SDD §6.9).
 */

import type { Money } from '../kernel/money.ts';
import type { Result } from '../kernel/result.ts';

/** Opaque handles. The shape of a vendor's identifier is the vendor's business. */
export interface PartyRef {
  readonly value: string;
}
export interface AccountRef {
  readonly value: string;
}
export interface BookingRef {
  readonly value: string;
}
export interface SettlementRef {
  readonly value: string;
}
export interface PostingRef {
  readonly value: string;
}

/** Mandatory on every external write. A double-booked Murabaha is an incident. */
export interface IdempotencyKey {
  readonly value: string;
}

export type AccountPurpose =
  | 'SETTLEMENT' // paying the seller
  | 'COLLECTION' // collecting the fixed total at maturity
  /** Segregated. Late amounts land here and never touch revenue (SH-13). */
  | 'CHARITY_LIABILITY'
  /** The institution genuinely holds goods between purchase and sale. */
  | 'GOODS_INVENTORY';

/**
 * Party data crossing into the core.
 *
 * Restricted attributes — national identifiers, identity assertions — move by
 * reference, resolved inside the trust boundary by the adapter. They are never
 * fields on a domain object that could end up in a log line, a trace span or an
 * error message (CLAUDE.md §10, RC-05).
 */
export interface PartyDetails {
  readonly tenantId: string;
  readonly counterpartyId: string;
  readonly registrationNumber: string;
  readonly legalNameAr: string;
  readonly legalNameEn: string;
  readonly legalForm: string;
  /** Pointer into restricted storage. Not the value. */
  readonly restrictedAttributesRef?: string;
}

export interface ObligationInstalment {
  readonly instalmentNo: number;
  readonly dueDateGregorian: string;
  readonly dueDateHijri: string;
  readonly amount: Money;
}

export interface BookObligationRequest {
  readonly tenantId: string;
  readonly transactionId: string;
  readonly partyRef: PartyRef;
  readonly collectionAccount: AccountRef;
  /** The fixed total. It does not change, so there is nothing to recompute. */
  readonly totalAmount: Money;
  /** Disclosed separately because the Murabaha's validity depends on it. */
  readonly costAmount: Money;
  readonly profitAmount: Money;
  readonly instalments: readonly ObligationInstalment[];
  readonly maturityDateGregorian: string;
  readonly maturityDateHijri: string;
  readonly correlationId: string;
}

export interface SettlementInstruction {
  readonly tenantId: string;
  readonly transactionId: string;
  readonly fromAccount: AccountRef;
  readonly beneficiaryPartyRef: PartyRef;
  readonly amount: Money;
  readonly valueDateGregorian: string;
  readonly remittanceReference: string;
  readonly correlationId: string;
}

export interface CharityPostingRequest {
  readonly tenantId: string;
  readonly transactionId: string;
  /** Must resolve to a CHARITY_LIABILITY account. The adapter asserts it. */
  readonly account: AccountRef;
  readonly amount: Money;
  readonly reasonCode: string;
  readonly correlationId: string;
}

export interface ExposureView {
  readonly partyRef: PartyRef;
  readonly totalOutstanding: Money;
  readonly facilityCount: number;
  readonly worstArrearsDays: number;
}

export type LifecycleEventType =
  | 'PAYMENT_RECEIVED'
  | 'PAYMENT_RETURNED'
  | 'INSTALMENT_DUE'
  | 'ARREARS_OPENED'
  | 'ARREARS_CLEARED'
  | 'OBLIGATION_CLOSED';

export interface LifecycleEvent {
  readonly eventId: string;
  readonly type: LifecycleEventType;
  readonly tenantId: string;
  readonly transactionId: string;
  readonly amount?: Money;
  readonly occurredAtEpochSeconds: bigint;
  readonly correlationId: string;
}

export type LifecycleHandler = (event: LifecycleEvent) => Promise<void>;
export type Unsubscribe = () => void;

export interface CoreBankingProvider {
  resolveOrCreateParty(party: PartyDetails, key: IdempotencyKey): Promise<Result<PartyRef>>;

  resolveAccount(partyRef: PartyRef, purpose: AccountPurpose): Promise<Result<AccountRef>>;

  /** Exactly once, with idempotent retry and nightly reconciliation (BR-D12). */
  bookObligation(
    request: BookObligationRequest,
    key: IdempotencyKey,
  ): Promise<Result<BookingRef>>;

  instructSettlement(
    instruction: SettlementInstruction,
    key: IdempotencyKey,
  ): Promise<Result<SettlementRef>>;

  /**
   * Post a late amount to the segregated charity liability. There is no
   * counterpart method that posts to income, in this interface or in any
   * implementation of it.
   */
  postCharityLiability(
    request: CharityPostingRequest,
    key: IdempotencyKey,
  ): Promise<Result<PostingRef>>;

  fetchExposure(partyRef: PartyRef): Promise<Result<ExposureView>>;

  subscribeLifecycle(handler: LifecycleHandler): Unsubscribe;
}
