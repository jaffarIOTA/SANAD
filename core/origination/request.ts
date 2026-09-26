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
import type { TradeReference } from './trade-reference.ts';
import {
  type ApprovalAuthority,
  type OriginationPolicy,
  authorityCovers,
  checkAgentEntitlement,
  checkPartnerEntitlement,
  isExpired,
  requiredAuthority,
} from './policy.ts';

export type RequestState =
  | 'KEYING'
  | 'AWAITING_SERVICING_RESPONSE'
  | 'AWAITING_REVIEW'
  | 'RETURNED_TO_MAKER'
  | 'APPROVED'
  | 'WITHDRAWN'
  | 'REJECTED'
  | 'EXPIRED'
  | 'PENDING_INFORMATION'
  | 'SERVICING_UNAVAILABLE';

export interface Principal {
  readonly principalId: string;
  readonly tenantId: string;
  /**
   * The approval authority this principal holds, per the tenant's approval
   * tiers. Absent means the lowest. This governs which *requests* a person
   * may approve — it is not, and cannot be made into, anything that touches a
   * sequencing gate.
   */
  readonly authority?: ApprovalAuthority;
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

/**
 * What changed on resubmission after a return (BRD MC-008/009).
 *
 * Carried on the request so the checker sees it beside the fields rather
 * than reconstructing it from memory. `material` means a field the tenant
 * lists in `revalidateOn` changed, so validation was re-run and any earlier
 * servicing answer was discarded.
 */
export interface ChangeSet {
  readonly fields: readonly string[];
  readonly material: boolean;
  readonly returnedNote: string;
  readonly resubmittedAt: TsaInstant;
}

/** One attempt to reach the servicing platform, and why it failed. */
export interface ServicingAttempt {
  readonly at: TsaInstant;
  readonly reason: string;
  /** Present when a named person resubmitted beyond the automatic attempts. */
  readonly manual?: { readonly by: Principal; readonly note: string };
}

export interface AwaitingServicingResponse {
  readonly state: 'AWAITING_SERVICING_RESPONSE';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly submittedAt: TsaInstant;
  readonly changes?: ChangeSet;
  /** Retained across a retry so the ledger is complete. */
  readonly attempts?: readonly ServicingAttempt[];
}

export interface AwaitingReview {
  readonly state: 'AWAITING_REVIEW';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly submittedAt: TsaInstant;
  /** Absent where the channel does not consult the servicing platform. */
  readonly servicing?: ServicingOutcome;
  readonly changes?: ChangeSet;
}

export type InformationSource = 'COUNTERPARTY' | 'PARTNER' | 'DOCUMENTS';

/**
 * Waiting on someone outside the institution (BRD §11 Pending Documents /
 * Pending Customer / Pending Partner; §16 "Additional Information").
 */
export interface PendingInformation {
  readonly state: 'PENDING_INFORMATION';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly submittedAt: TsaInstant;
  readonly requestedBy: Principal;
  readonly from: InformationSource;
  readonly items: readonly string[];
  readonly requestedAt: TsaInstant;
  readonly servicing?: ServicingOutcome;
  readonly changes?: ChangeSet;
}

/**
 * The servicing platform could not be reached (BRD §21). Not a decline: a
 * controlled pending state with a ledger of attempts, visible to operations,
 * retried automatically within policy and manually beyond it.
 */
export interface ServicingUnavailable {
  readonly state: 'SERVICING_UNAVAILABLE';
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  readonly submittedAt: TsaInstant;
  readonly attempts: readonly ServicingAttempt[];
  readonly changes?: ChangeSet;
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

/**
 * Timed out while waiting.
 *
 * A request nobody acted on within the tenant's configured interval. Terminal:
 * a stale request is re-raised, not revived, because the trade it names and
 * the limits it was checked against may no longer hold.
 */
export interface Expired {
  readonly state: 'EXPIRED';
  readonly core: OriginationRequestCore;
  readonly wasIn: 'AWAITING_SERVICING_RESPONSE' | 'AWAITING_REVIEW' | 'RETURNED_TO_MAKER' | 'PENDING_INFORMATION' | 'SERVICING_UNAVAILABLE';
  readonly expiredAt: TsaInstant;
}

export type OriginationRequest =
  | Keying
  | AwaitingServicingResponse
  | AwaitingReview
  | ReturnedToMaker
  | Approved
  | Rejected
  | Withdrawn
  | Expired
  | PendingInformation
  | ServicingUnavailable;

// -- Raising ------------------------------------------------------------------

export function raise(params: {
  readonly core: OriginationRequestCore;
  readonly maker: Principal;
  /**
   * The tenant's origination policy. When supplied, an agent or partner
   * initiator is checked against its entitlement — status, channel,
   * programme, per-request limit. Omitting it means no entitlement check,
   * which is only acceptable where the caller has already done one.
   */
  readonly policy?: OriginationPolicy;
}): Result<Keying> {
  const { core, maker, policy } = params;

  const identified = verifyIdentification(core.channel, core.identification);
  if (!identified.ok) return identified;

  if (policy !== undefined) {
    const id = core.identification;
    if (id.kind === 'AGENT') {
      const entitled = checkAgentEntitlement(policy, id, core);
      if (!entitled.ok) return entitled;
    } else if (id.kind === 'PARTNER_SYSTEM' || id.kind === 'AGGREGATOR_ON_BEHALF') {
      const entitled = checkPartnerEntitlement(policy, id, core);
      if (!entitled.ok) return entitled;
    }
  }

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
  /**
   * The tenant's origination policy. When supplied, the checker's held
   * authority must cover the tier the request's amount falls in.
   */
  originationPolicy?: OriginationPolicy,
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

  if (originationPolicy !== undefined) {
    const required = requiredAuthority(originationPolicy, request.core.requestedAmount);
    if (!authorityCovers(checker.authority, required)) {
      return reject(
        'OP-DETERMINACY',
        'APPROVAL_AUTHORITY_INSUFFICIENT',
        'This request needs a higher approval authority than the approver holds',
        { requestId: request.core.requestId, required, held: checker.authority ?? 'CHECKER' },
      );
    }
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

/**
 * Expire a request that has waited too long.
 *
 * Pure: the observed instant is an argument, attested like every instant with
 * effect, and the interval comes from the tenant's policy. Refuses if the
 * interval has not elapsed, so a caller cannot expire something early by
 * calling this — only the passage of attested time expires a request.
 */
export function expire(
  request: AwaitingServicingResponse | AwaitingReview | ReturnedToMaker | PendingInformation | ServicingUnavailable,
  policy: OriginationPolicy,
  observedAt: TsaInstant,
): Result<Expired> {
  const since =
    request.state === 'PENDING_INFORMATION' ? request.requestedAt.epochSeconds
    : 'submittedAt' in request ? request.submittedAt.epochSeconds
    : request.core.raisedAt.epochSeconds;
  if (!isExpired(policy, request.state, since, observedAt.epochSeconds)) {
    return reject(
      'OP-DETERMINACY',
      'REQUEST_NOT_YET_EXPIRED',
      'The configured interval has not elapsed for this request',
      { requestId: request.core.requestId, state: request.state },
    );
  }
  return ok({ state: 'EXPIRED', core: request.core, wasIn: request.state, expiredAt: observedAt });
}

// -- Information from outside the institution ---------------------------------

export function requestInformation(
  request: AwaitingReview,
  requestedBy: Principal,
  from: InformationSource,
  items: readonly string[],
  at: TsaInstant,
): Result<PendingInformation> {
  const named = items.map((i) => i.trim()).filter((i) => i.length > 0);
  if (named.length === 0) {
    return reject('OP-DETERMINACY', 'INFORMATION_REQUEST_EMPTY', 'Say what is needed; a request for nothing cannot be answered', { requestId: request.core.requestId });
  }
  return ok({
    state: 'PENDING_INFORMATION', core: request.core, maker: request.maker, submittedAt: request.submittedAt,
    requestedBy, from, items: named, requestedAt: at,
    ...(request.servicing === undefined ? {} : { servicing: request.servicing }),
    ...(request.changes === undefined ? {} : { changes: request.changes }),
  });
}

/** The information arrived. Back in front of a person; the earlier servicing answer stands. */
export function provideInformation(request: PendingInformation, _at: TsaInstant): AwaitingReview {
  return {
    state: 'AWAITING_REVIEW', core: request.core, maker: request.maker, submittedAt: request.submittedAt,
    ...(request.servicing === undefined ? {} : { servicing: request.servicing }),
    ...(request.changes === undefined ? {} : { changes: request.changes }),
  };
}

// -- The servicing platform could not be reached ------------------------------

export function recordServicingFailure(
  request: AwaitingServicingResponse | ServicingUnavailable,
  at: TsaInstant,
  reason: string,
): Result<ServicingUnavailable> {
  if (reason.trim().length === 0) {
    return reject('OP-DETERMINACY', 'SERVICING_FAILURE_WITHOUT_REASON', 'Record why the platform could not be reached', { requestId: request.core.requestId });
  }
  const prior = request.state === 'SERVICING_UNAVAILABLE' ? request.attempts : (request.attempts ?? []);
  return ok({
    state: 'SERVICING_UNAVAILABLE', core: request.core, maker: request.maker, submittedAt: request.submittedAt,
    attempts: [...prior, { at, reason }],
    ...(request.changes === undefined ? {} : { changes: request.changes }),
  });
}

/**
 * Try again.
 *
 * Automatically: only within the tenant's maximum attempts and after the
 * backoff. Manually: beyond the maximum, but only by a named person with a
 * note — which is what makes "manual resubmission controlled and auditable"
 * (BRD §21) true rather than aspirational. The full ledger travels with the
 * request either way.
 */
export function retryServicing(
  request: ServicingUnavailable,
  at: TsaInstant,
  policy: OriginationPolicy,
  manual?: { readonly by: Principal; readonly note: string },
): Result<AwaitingServicingResponse> {
  const lastAttempt = request.attempts[request.attempts.length - 1];
  if (manual === undefined) {
    if (request.attempts.length >= policy.servicingRetry.maxAttempts) {
      return reject('OP-DETERMINACY', 'SERVICING_RETRIES_EXHAUSTED', 'Automatic retries are exhausted; a named person must resubmit', { requestId: request.core.requestId, attempts: request.attempts.length });
    }
    if (lastAttempt !== undefined && at.epochSeconds - lastAttempt.at.epochSeconds < BigInt(policy.servicingRetry.backoffSeconds)) {
      return reject('OP-DETERMINACY', 'SERVICING_RETRY_TOO_SOON', 'The backoff interval has not elapsed', { requestId: request.core.requestId });
    }
  } else if (manual.note.trim().length === 0) {
    return reject('OP-DETERMINACY', 'MANUAL_RESUBMISSION_WITHOUT_NOTE', 'A manual resubmission must say why', { requestId: request.core.requestId });
  }
  const attempts = manual === undefined ? request.attempts : [...request.attempts, { at, reason: 'manual resubmission', manual }];
  return ok({
    state: 'AWAITING_SERVICING_RESPONSE', core: request.core, maker: request.maker, submittedAt: request.submittedAt,
    attempts,
    ...(request.changes === undefined ? {} : { changes: request.changes }),
  });
}

// -- Resubmission after a return, with a diff ---------------------------------

const FIELD_VALUES: Readonly<Record<string, (c: OriginationRequestCore) => string>> = {
  tradeReference: (c) => `${c.tradeReference.type}:${c.tradeReference.invoiceUuid ?? ''}:${c.tradeReference.issuerCr}:${c.tradeReference.recipientCr}`,
  requestedAmount: (c) => `${c.requestedAmount.currency}:${c.requestedAmount.minorUnits.toString()}`,
  counterpartyId: (c) => c.counterpartyId,
  programmeId: (c) => c.programmeId,
  requestedTenorDays: (c) => String(c.requestedTenorDays),
  channel: (c) => c.channel,
};

/**
 * The maker corrected a returned request and sends it back (MC-007/008/009).
 *
 * The identifier is preserved — a corrected request is the same request. The
 * diff is computed here, from the returned core against the revised one, so
 * the checker sees exactly what changed. A material change re-runs the
 * validations `raise()` performs and discards a servicing answer given to
 * different facts.
 */
export function resubmit(
  request: ReturnedToMaker,
  revised: OriginationRequestCore,
  at: TsaInstant,
  policy: OriginationPolicy,
): Result<AwaitingServicingResponse | AwaitingReview> {
  if (revised.requestId !== request.core.requestId || revised.tenantId !== request.core.tenantId) {
    return reject('OP-DETERMINACY', 'RESUBMISSION_CHANGES_IDENTITY', 'A resubmitted request keeps its identifier and tenant', { requestId: request.core.requestId });
  }
  if (revised.channel !== request.core.channel) {
    return reject('OP-DETERMINACY', 'RESUBMISSION_CHANGES_CHANNEL', 'A request cannot change the door it came through', { requestId: request.core.requestId });
  }
  const fields = Object.keys(FIELD_VALUES).filter((f) => FIELD_VALUES[f]?.(request.core) !== FIELD_VALUES[f]?.(revised));
  const material = fields.some((f) => policy.revalidateOn.includes(f));
  const changes: ChangeSet = { fields, material, returnedNote: request.note, resubmittedAt: at };

  // Re-validate as if raised afresh — identification, entitlement, positivity.
  const revalidated = raise({ core: revised, maker: request.maker, policy });
  if (!revalidated.ok) return revalidated;

  if (material && CHANNEL_POLICIES[revised.channel].requiresServicingDecision) {
    return ok({ state: 'AWAITING_SERVICING_RESPONSE', core: revised, maker: request.maker, submittedAt: at, changes });
  }
  return ok({ state: 'AWAITING_REVIEW', core: revised, maker: request.maker, submittedAt: at, changes });
}

export function reopen(request: ReturnedToMaker): Keying {
  return { state: 'KEYING', core: request.core, maker: request.maker };
}

/**
 * Withdraw a request.
 *
 * Accepts every state in which a request is still open, including
 * `AWAITING_SERVICING_RESPONSE` — a counterparty or partner may change its
 * mind while an external platform is still deliberating, and having to wait
 * for an answer you no longer want is a worse outcome than a late withdrawal.
 *
 * The states it does *not* accept are the decided ones, and that is the whole
 * control: `Approved`, `Rejected` and `Withdrawn` are absent from the
 * parameter type, so "withdraw an approved request" does not typecheck.
 * Reversing a decision is a different act with different evidence, and it is
 * not this function.
 */
export function withdraw(
  request: Keying | AwaitingServicingResponse | AwaitingReview | ReturnedToMaker | PendingInformation | ServicingUnavailable,
): Withdrawn {
  return { state: 'WITHDRAWN', core: request.core };
}

