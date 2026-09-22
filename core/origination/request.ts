/**
 * The origination request, and maker–checker.
 *
 * A request is an *instruction to originate*. It is reviewed, and a second
 * person approves it. What that approval buys is the right to open a
 * transaction in `DRAFT` — and nothing else.
 *
 * This is the load-bearing distinction in this file, so it is worth stating
 * plainly. In a conventional loan origination system, a checker's approval is
 * the moment the credit exists: approve, and it books. Here it is not. An
 * approved request produces a transaction at the very start of the sequence,
 * which must then validate the trade, reserve limit, execute a purchase,
 * evidence ownership, evidence possession, hold the goods at risk for the
 * Board's interval, and only then offer a sale.
 *
 * A checker cannot shorten that. `approve()` returns an approval, not a
 * transaction, and the only thing an approval can be converted into is
 * `Draft`. There is no function in this module that returns any later state,
 * so "the checker approved it, book it" is not an expressible instruction
 * (SH-05, BR-D10).
 *
 * Four eyes means four eyes: the approver must be a different principal from
 * the maker, and that is checked here rather than trusted to a screen that
 * happens not to show the button.
 */

import { type Result, ok, reject } from '../kernel/result.ts';
import type { Money } from '../kernel/money.ts';
import type { TsaInstant } from '../time/tsa.ts';
import {
  CHANNEL_POLICIES,
  type InitiatorIdentification,
  type OriginationChannel,
  verifyIdentification,
} from './channel.ts';
import type { Draft, TradeReference, TransactionCore } from '../sequencing/state.ts';

export type RequestState =
  | 'KEYING'
  | 'AWAITING_REVIEW'
  | 'RETURNED_TO_MAKER'
  | 'APPROVED'
  | 'WITHDRAWN'
  | 'REJECTED';

export interface Principal {
  readonly principalId: string;
  readonly tenantId: string;
}

export interface OriginationRequestCore {
  readonly requestId: string;
  readonly tenantId: string;
  readonly programmeId: string;
  readonly counterpartyId: string;
  readonly channel: OriginationChannel;
  readonly identification: InitiatorIdentification;
  /** The real trade. There is no request without one (BR-D01). */
  readonly tradeReference: TradeReference;
  readonly requestedAmount: Money;
  readonly requestedTenorDays: number;
  readonly correlationId: string;
  readonly raisedAt: TsaInstant;
}

export interface Keying {
  readonly state: 'KEYING';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
}

export interface AwaitingReview {
  readonly state: 'AWAITING_REVIEW';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly submittedAt: TsaInstant;
}

export interface ReturnedToMaker {
  readonly state: 'RETURNED_TO_MAKER';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly reviewer: Principal;
  readonly note: string;
}

export interface Approved {
  readonly state: 'APPROVED';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  /** Necessarily a different principal from the maker. */
  readonly checker: Principal;
  readonly approvedAt: TsaInstant;
}

export interface Rejected {
  readonly state: 'REJECTED';
  readonly core: OriginationRequestCore;
  readonly reviewer: Principal;
  readonly reasonCode: string;
}

export interface Withdrawn {
  readonly state: 'WITHDRAWN';
  readonly core: OriginationRequestCore;
}

export type OriginationRequest =
  | Keying
  | AwaitingReview
  | ReturnedToMaker
  | Approved
  | Rejected
  | Withdrawn;

// -- Raising ------------------------------------------------------------------

export function raise(params: {
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
}): Result<Keying> {
  const { core, maker } = params;

  const identified = verifyIdentification(core.channel, core.identification);
  if (!identified.ok) return identified;

  if (maker.tenantId !== core.tenantId) {
    return reject(
      'OP-DETERMINACY',
      'PRINCIPAL_TENANT_MISMATCH',
      'A principal may not raise a request in another tenant',
      { requestId: core.requestId },
    );
  }

  if (core.requestedAmount.minorUnits <= 0n) {
    return reject('SH-03', 'REQUESTED_AMOUNT_NOT_POSITIVE', 'A request must name a positive amount');
  }

  if (core.requestedTenorDays <= 0) {
    return reject('SH-03', 'TENOR_NOT_DETERMINATE', 'A request must name a determinate tenor');
  }

  return ok({ state: 'KEYING', core, maker });
}

export function submitForReview(request: Keying, at: TsaInstant): Result<AwaitingReview> {
  return ok({
    state: 'AWAITING_REVIEW',
    core: request.core,
    maker: request.maker,
    submittedAt: at,
  });
}

// -- Review -------------------------------------------------------------------

/**
 * Approve the request.
 *
 * The approver must be a different principal from the maker. Where the channel
 * does not require four eyes, this transition is still the one that produces an
 * approval — the caller passes the same principal only where policy allows it,
 * and policy is consulted here rather than assumed.
 */
export function approve(
  request: AwaitingReview,
  checker: Principal,
  at: TsaInstant,
): Result<Approved> {
  if (checker.tenantId !== request.core.tenantId) {
    return reject(
      'OP-DETERMINACY',
      'PRINCIPAL_TENANT_MISMATCH',
      'A principal may not approve a request in another tenant',
      { requestId: request.core.requestId },
    );
  }

  const policy = CHANNEL_POLICIES[request.core.channel];
  if (policy.requiresFourEyes && checker.principalId === request.maker.principalId) {
    return reject(
      'OP-DETERMINACY',
      'FOUR_EYES_VIOLATED',
      'The principal who raised a request cannot be the one who approves it',
      { requestId: request.core.requestId, channel: request.core.channel },
    );
  }

  return ok({
    state: 'APPROVED',
    core: request.core,
    maker: request.maker,
    checker,
    approvedAt: at,
  });
}

export function returnToMaker(
  request: AwaitingReview,
  reviewer: Principal,
  note: string,
): Result<ReturnedToMaker> {
  if (note.trim().length === 0) {
    return reject(
      'OP-DETERMINACY',
      'RETURN_WITHOUT_REASON',
      'Returning a request to its maker requires saying what needs changing',
      { requestId: request.core.requestId },
    );
  }
  return ok({
    state: 'RETURNED_TO_MAKER',
    core: request.core,
    maker: request.maker,
    reviewer,
    note,
  });
}

export function rejectRequest(
  request: AwaitingReview,
  reviewer: Principal,
  reasonCode: string,
): Result<Rejected> {
  if (reasonCode.trim().length === 0) {
    return reject(
      'OP-DETERMINACY',
      'REJECTION_WITHOUT_REASON_CODE',
      'A rejection names a reason code from the catalogue; the counterparty is owed an explanation',
      { requestId: request.core.requestId },
    );
  }
  return ok({ state: 'REJECTED', core: request.core, reviewer, reasonCode });
}

export function reopen(request: ReturnedToMaker): Keying {
  return { state: 'KEYING', core: request.core, maker: request.maker };
}

export function withdraw(request: Keying | AwaitingReview | ReturnedToMaker): Withdrawn {
  return { state: 'WITHDRAWN', core: request.core };
}

// -- What an approval actually buys -------------------------------------------

/**
 * Convert an approved request into a transaction at the **start** of the
 * sequence.
 *
 * Note the return type. `Draft` is the first state of the transaction state
 * machine; from here the only legal move is `submit`, and after that trade
 * validation, limit reservation, the wa'd, the purchase, ownership evidence,
 * possession evidence and the Board's risk-holding interval — in that order,
 * each enforced by a transition that only accepts its predecessor.
 *
 * There is no variant of this function that returns anything later, and no
 * parameter that says "skip to". A checker's signature authorises opening a
 * file, not executing a sale.
 */
export function openTransaction(
  request: Approved,
  core: TransactionCore,
): Result<Draft> {
  if (core.tenantId !== request.core.tenantId) {
    return reject(
      'OP-DETERMINACY',
      'TENANT_MISMATCH',
      'The transaction and the request it came from must belong to one tenant',
      { requestId: request.core.requestId },
    );
  }
  if (core.counterpartyId !== request.core.counterpartyId) {
    return reject(
      'OP-DETERMINACY',
      'COUNTERPARTY_MISMATCH',
      'The transaction must be for the counterparty the request named',
      { requestId: request.core.requestId },
    );
  }
  if (core.tradeReference.invoiceUuid !== request.core.tradeReference.invoiceUuid) {
    return reject(
      'SH-10',
      'TRADE_REFERENCE_SUBSTITUTED',
      'The trade on the transaction is not the trade that was approved',
      { requestId: request.core.requestId },
    );
  }

  return ok({ state: 'DRAFT', core });
}
