/**
 * The transaction aggregate, as a discriminated union of states.
 *
 * Every state is a distinct type. A transition is a function that accepts one
 * specific state type and returns another, which means an illegal transition is
 * not a runtime check that could be skipped — it is an expression that does not
 * typecheck. There is no function anywhere in this codebase whose parameter is
 * `PurchaseExecuted` and whose result is `SaleOffered`, so there is no code path
 * for an override to override (SH-05, SDD §3.5.3, §6.5.2).
 *
 * States follow SDD §5.5.1.
 */

import type { MurabahaPricing } from '../pricing/murabaha.ts';
import type { ContractLeg } from '../legs/leg.ts';
import type { Rejection } from '@sanad/core/kernel/result.ts';
import type { StructureCode } from '../structures/definition.ts';
import type { TsaInstant } from '@sanad/core/time/tsa.ts';

/** A real trade. There is no drawdown against a cash amount alone (BR-D01). */
import type { TradeReference } from '@sanad/core/origination/trade-reference.ts';
export type { TradeReference };

/**
 * Identity and the parameters in force at inception. Everything here is
 * snapshotted: a later change to the Board's parameters or to credit policy
 * cannot retroactively change what an executed transaction was executed under
 * (SDD §3.11.2, §5.7).
 */
export interface TransactionCore {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly programmeId: string;
  readonly counterpartyId: string;

  readonly structureCode: StructureCode;
  readonly structureDefinitionId: string;
  readonly structureVersion: number;

  /** The approval this executed under. Snapshotted, not referenced live. */
  readonly shariahApprovalId: string;
  /** The Board's interval, as it stood at inception. */
  readonly riskPeriodRequiredSeconds: number;

  readonly pricing: MurabahaPricing;
  readonly tenorDays: number;
  /** Both calendars stored. Never converted at read time (NFR-08). */
  readonly maturityDateGregorian: string;
  readonly maturityDateHijri: string;

  readonly tradeReference: TradeReference;

  /** The decision record that authorised the limit this drawdown consumes. */
  readonly decisionId: string;
  readonly creditPolicyVersion: string;

  readonly correlationId: string;
}

interface WithCore {
  readonly core: TransactionCore;
}

interface WithLegs extends WithCore {
  readonly legs: readonly ContractLeg[];
}

export interface Draft extends WithCore {
  readonly state: 'DRAFT';
}

export interface TradeValidation extends WithCore {
  readonly state: 'TRADE_VALIDATION';
}

export interface Rejected extends WithCore {
  readonly state: 'REJECTED';
  readonly reasons: readonly Rejection[];
}

export interface LimitReserved extends WithCore {
  readonly state: 'LIMIT_RESERVED';
  readonly reservationId: string;
}

export interface WaadExecuted extends WithLegs {
  readonly state: 'WAAD_EXECUTED';
  readonly reservationId: string;
}

export interface PurchaseExecuted extends WithLegs {
  readonly state: 'PURCHASE_EXECUTED';
  readonly reservationId: string;
}

export interface OwnershipAcquired extends WithLegs {
  readonly state: 'OWNERSHIP_ACQUIRED';
  readonly reservationId: string;
  readonly ownershipEvidenceIds: readonly string[];
}

export interface PossessionConfirmed extends WithLegs {
  readonly state: 'POSSESSION_CONFIRMED';
  readonly reservationId: string;
  readonly ownershipEvidenceIds: readonly string[];
  readonly possessionEvidenceIds: readonly string[];
  /** Attested. The interval is measured from here. */
  readonly riskPeriodStartAt: TsaInstant;
}

export interface SaleOffered extends WithLegs {
  readonly state: 'SALE_OFFERED';
  readonly reservationId: string;
  readonly riskPeriodStartAt: TsaInstant;
  /** Attested, and necessarily later than riskPeriodStartAt + the interval. */
  readonly saleOfferedAt: TsaInstant;
  readonly offerExpiresAtEpochSeconds: bigint;
}

export interface OfferLapsed extends WithLegs {
  readonly state: 'OFFER_LAPSED';
}

export interface Unwind extends WithLegs {
  readonly state: 'UNWIND';
  /** What happened to goods already acquired. Documented, never implicit. */
  readonly goodsDisposition: string;
}

export interface ExecutedState extends WithLegs {
  readonly state: 'EXECUTED';
  readonly acceptedAt: TsaInstant;
}

export interface Active extends WithLegs {
  readonly state: 'ACTIVE';
  readonly obligationId: string;
  readonly bookingRef: string;
}

export interface Settled extends WithLegs {
  readonly state: 'SETTLED';
  readonly obligationId: string;
}

export interface Delinquent extends WithLegs {
  readonly state: 'DELINQUENT';
  readonly obligationId: string;
  readonly daysPastDue: number;
}

export interface Hardship extends WithLegs {
  readonly state: 'HARDSHIP';
  readonly obligationId: string;
  readonly caseId: string;
}

export interface Rescheduled extends WithLegs {
  readonly state: 'RESCHEDULED';
  readonly obligationId: string;
}

export interface WrittenOff extends WithLegs {
  readonly state: 'WRITTEN_OFF';
  readonly obligationId: string;
}

export interface Resolved extends WithLegs {
  readonly state: 'RESOLVED';
  readonly obligationId: string;
}

export type Transaction =
  | Draft
  | TradeValidation
  | Rejected
  | LimitReserved
  | WaadExecuted
  | PurchaseExecuted
  | OwnershipAcquired
  | PossessionConfirmed
  | SaleOffered
  | OfferLapsed
  | Unwind
  | ExecutedState
  | Active
  | Settled
  | Delinquent
  | Hardship
  | Rescheduled
  | WrittenOff
  | Resolved;

export type TransactionStateName = Transaction['state'];

/** States from which no further transition exists. */
export const TERMINAL_STATES: ReadonlySet<TransactionStateName> = new Set<TransactionStateName>([
  'REJECTED',
  'SETTLED',
  'WRITTEN_OFF',
  'UNWIND',
]);
