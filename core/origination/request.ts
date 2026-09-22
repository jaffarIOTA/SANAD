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
  | 'AWAITING_SERVICING_RESPONSE'
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

/**
 * What the servicing platform said.
 *
 * An input to the institution's decision, recorded verbatim. It speaks to
 * credit capacity — limits, exposure, account standing — and to nothing else.
 * It has no view on whether goods were bought, possessed and held at risk,
 * and it is not consulted about that, because those are gates rather than
 * opinions.
 */
export interface ServicingOutcome {
  readonly decision: 'APPROVED' | 'DECLINED' | 'REFERRED';
  /** The servicing platform's own reference, for reconciliation. */
  readonly reference: string;
  readonly reasonCode?: string;
  readonly respondedAt: TsaInstant;
}

export interface AwaitingServicingResponse {
  readonly state: 'AWAITING_SERVICING_RESPONSE';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly submittedAt: TsaInstant;
}

export interface AwaitingReview {
  readonly state: 'AWAITING_REVIEW';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly submittedAt: TsaInstant;
  /** Absent where the channel does not consult the servicing platform. */
  readonly servicing?: ServicingOutcome;
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
  readonly servicing?: ServicingOutcome;
  /**
   * Set where the institution approved despite the servicing platform
   * declining. A credit judgement the institution is entitled to make, and
   * one it has to own in writing — so the justification is recorded on the
   * request rather than in someone's inbox.
   *
   * This overrides a *recommendation*. No field here, and no field anywhere,
   * overrides a sequencing gate.
   */
  readonly contraryToServicing?: { readonly justification: string };
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
  | AwaitingServicingResponse
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

/**
 * Submit.
 *
 * Where the channel consults the servicing platform, this lands in
 * `AWAITING_SERVICING_RESPONSE` and a human sees nothing yet. Where it does
 * not, it goes straight to review. The return type is the union, so a caller
 * has to handle both rather than assuming the shorter path.
 */
export function submitForReview(
  request: Keying,
  at: TsaInstant,
): Result<AwaitingServicingResponse | AwaitingReview> {
  const policy = CHANNEL_POLICIES[request.core.channel];

  if (policy.requiresServicingDecision) {
    return ok({
      state: 'AWAITING_SERVICING_RESPONSE',
      core: request.core,
      maker: request.maker,
      submittedAt: at,
    });
  }

  return ok({
    state: 'AWAITING_REVIEW',
    core: request.core,
    maker: request.maker,
    submittedAt: at,
  });
}

/**
 * Record what the servicing platform said, and put the request in front of a
 * human.
 *
 * Note what this does *not* do. A servicing approval does not approve the
 * request, and a servicing decline does not reject it. Both outcomes land in
 * the same place — `AWAITING_REVIEW` — because the institution decides, with
 * the platform's answer in front of it. Auto-approving on a servicing yes
 * would collapse two stages into one and remove the institution from its own
 * credit decision.
 */
export function recordServicingOutcome(
  request: AwaitingServicingResponse,
  outcome: ServicingOutcome,
): Result<AwaitingReview> {
  if (outcome.reference.trim().length === 0) {
    return reject(
      'OP-DETERMINACY',
      'SERVICING_REFERENCE_MISSING',
      'A servicing response must carry the platform’s own reference, so the two records can be reconciled',
      { requestId: request.core.requestId },
    );
  }
  if (outcome.decision !== 'APPROVED' && (outcome.reasonCode ?? '').trim().length === 0) {
    return reject(
      'OP-DETERMINACY',
      'SERVICING_REASON_MISSING',
      'A servicing decline or referral must say why; the reviewer needs it and so does the counterparty',
      { requestId: request.core.requestId, decision: outcome.decision },
    );
  }

  return ok({
    state: 'AWAITING_REVIEW',
    core: request.core,
    maker: request.maker,
    submittedAt: request.submittedAt,
    servicing: outcome,
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
  /**
   * Required only where the servicing platform declined. Approving against a
   * decline is a credit judgement the institution may make and must own in
   * writing.
   */
  contraryJustification?: string,
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

  const policy2 = CHANNEL_POLICIES[request.core.channel];
  if (policy2.requiresServicingDecision && request.servicing === undefined) {
    return reject(
      'OP-DETERMINACY',
      'SERVICING_RESPONSE_NOT_RECEIVED',
      'This channel consults the servicing platform before a human decides, and no response has been recorded',
      { requestId: request.core.requestId, channel: request.core.channel },
    );
  }

  const declined = request.servicing?.decision === 'DECLINED';
  const justification = (contraryJustification ?? '').trim();

  if (declined && justification.length === 0) {
    return reject(
      'OP-DETERMINACY',
      'CONTRARY_APPROVAL_UNJUSTIFIED',
      'The servicing platform declined. Approving anyway is permitted, and requires a recorded justification',
      { requestId: request.core.requestId },
    );
  }
  if (!declined && justification.length > 0) {
    return reject(
      'OP-DETERMINACY',
      'CONTRARY_JUSTIFICATION_NOT_APPLICABLE',
      'A contrary justification was supplied but the servicing platform did not decline',
      { requestId: request.core.requestId },
    );
  }

  return ok({
    state: 'APPROVED',
    core: request.core,
    maker: request.maker,
    checker,
    approvedAt: at,
    ...(request.servicing === undefined ? {} : { servicing: request.servicing }),
    ...(declined ? { contraryToServicing: { justification } } : {}),
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
