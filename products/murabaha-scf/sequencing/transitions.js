



















import { appendLeg } from '../legs/leg.js';
import { ok, reject } from '../../../core/kernel/result.js';

import { isStrictlyLater } from '../../../core/time/tsa.js';
import { verifyDistinctParties, verifyNoBuyBack } from '../parties/distinctness.js';
import { evaluateGates } from './gates.js';


















/**
 * Everything a gate-guarded transition needs, and nothing it does not. The
 * evidence set and the observed instant are supplied by the caller; this module
 * performs no lookups.
 */







// -- Origination --------------------------------------------------------------

export function submit(t) {
  return { state: 'TRADE_VALIDATION', core: t.core };
}

export function rejectTrade(t, reasons) {
  return { state: 'REJECTED', core: t.core, reasons };
}

export function reserveLimit(t, reservationId) {
  return { state: 'LIMIT_RESERVED', core: t.core, reservationId };
}

// -- Legs up to the purchase --------------------------------------------------

export function executeWaad(
  t,
  leg,
  ctx,
) {
  const legs = appendLeg([], leg);
  if (!legs.ok) return legs;
  const distinct = verifyDistinctParties(ctx.definition, legs.value);
  if (!distinct.ok) return distinct;
  return ok({
    state: 'WAAD_EXECUTED',
    core: t.core,
    reservationId: t.reservationId,
    legs: legs.value,
  });
}

export function executePurchase(
  t,
  leg,
  ctx,
) {
  const legs = appendLeg(t.legs, leg);
  if (!legs.ok) return legs;
  const distinct = verifyDistinctParties(ctx.definition, legs.value);
  if (!distinct.ok) return distinct;
  return ok({
    state: 'PURCHASE_EXECUTED',
    core: t.core,
    reservationId: t.reservationId,
    legs: legs.value,
  });
}

// -- The three gates ----------------------------------------------------------

/** GATE 1. Ownership evidence must be valid before the state can advance. */
export function acquireOwnership(
  t,
  ctx,
) {
  const evaluation = gateEvaluation(t.core.riskPeriodRequiredSeconds, t.legs, ctx);
  const gate = requireSatisfied(evaluation, 'GATE_1_OWNERSHIP');
  if (!gate.ok) return gate;

  return ok({
    state: 'OWNERSHIP_ACQUIRED',
    core: t.core,
    reservationId: t.reservationId,
    legs: t.legs,
    ownershipEvidenceIds: gate.value.dischargedBy,
  });
}

/** GATE 2. Possession evidence must be valid before the state can advance. */
export function confirmPossession(
  t,
  ctx,
) {
  const evaluation = gateEvaluation(t.core.riskPeriodRequiredSeconds, t.legs, ctx);

  const ownership = requireSatisfied(evaluation, 'GATE_1_OWNERSHIP');
  if (!ownership.ok) return ownership;
  const possession = requireSatisfied(evaluation, 'GATE_2_POSSESSION');
  if (!possession.ok) return possession;

  const startAt = evaluation.riskPeriodStartAt;
  if (startAt === undefined) {
    return reject(
      'SH-06',
      'RISK_PERIOD_START_UNDETERMINED',
      'Possession is evidenced but the attested moment it began could not be determined',
      { transactionId: t.core.transactionId },
    );
  }

  return ok({
    state: 'POSSESSION_CONFIRMED',
    core: t.core,
    reservationId: t.reservationId,
    legs: t.legs,
    ownershipEvidenceIds: t.ownershipEvidenceIds,
    possessionEvidenceIds: possession.value.dischargedBy,
    riskPeriodStartAt: startAt,
  });
}

/**
 * GATE 3. The sale offer.
 *
 * Reachable only from `PossessionConfirmed`, and only once the institution has
 * genuinely held the goods at its own risk for the interval the Board set — as
 * measured between two attested instants, not against this server's clock.
 */
export function offerSale(
  t,
  leg,
  offerExpiresAtEpochSeconds,
  ctx,
) {
  const evaluation = gateEvaluation(t.core.riskPeriodRequiredSeconds, t.legs, ctx);

  // All three, re-evaluated. Reaching this state is not a licence to skip the check.
  for (const gateId of ['GATE_1_OWNERSHIP', 'GATE_2_POSSESSION', 'GATE_3_RISK_PERIOD'] ) {
    const gate = requireSatisfied(evaluation, gateId);
    if (!gate.ok) return gate;
  }

  if (!isStrictlyLater(ctx.observedAt, t.riskPeriodStartAt)) {
    return reject('SH-06', 'SALE_NOT_AFTER_POSSESSION', 'The offer must be attested after possession', {
      transactionId: t.core.transactionId,
    });
  }

  const legs = appendLeg(t.legs, leg);
  if (!legs.ok) return legs;

  return ok({
    state: 'SALE_OFFERED',
    core: t.core,
    reservationId: t.reservationId,
    legs: legs.value,
    riskPeriodStartAt: t.riskPeriodStartAt,
    saleOfferedAt: ctx.observedAt,
    offerExpiresAtEpochSeconds,
  });
}

// -- Acceptance and beyond ----------------------------------------------------

export function acceptOffer(
  t,
  leg,
  ctx,
) {
  if (ctx.observedAt.epochSeconds > t.offerExpiresAtEpochSeconds) {
    return reject('SH-03', 'OFFER_EXPIRED', 'The offer has lapsed and must be reissued', {
      transactionId: t.core.transactionId,
    });
  }
  if (!isStrictlyLater(ctx.observedAt, t.saleOfferedAt)) {
    return reject(
      'SH-07',
      'ACCEPTANCE_NOT_AFTER_OFFER',
      'Acceptance is a separate act and must be attested strictly after the offer',
      { transactionId: t.core.transactionId },
    );
  }

  const legs = appendLeg(t.legs, leg);
  if (!legs.ok) return legs;

  const distinct = verifyDistinctParties(ctx.definition, legs.value);
  if (!distinct.ok) return distinct;
  const noBuyBack = verifyNoBuyBack(legs.value);
  if (!noBuyBack.ok) return noBuyBack;

  return ok({
    state: 'EXECUTED',
    core: t.core,
    legs: legs.value,
    acceptedAt: ctx.observedAt,
  });
}

export function lapseOffer(t, ctx) {
  if (ctx.observedAt.epochSeconds <= t.offerExpiresAtEpochSeconds) {
    return reject('SH-03', 'OFFER_STILL_LIVE', 'The offer has not yet expired', {
      transactionId: t.core.transactionId,
    });
  }
  return ok({ state: 'OFFER_LAPSED', core: t.core, legs: t.legs });
}

/**
 * Cancellation before the sale leg executes (BR-D14). The disposition of goods
 * already acquired is recorded, because the institution really does hold them.
 *
 * The parameter union deliberately stops at `OfferLapsed`: there is no unwind
 * from `EXECUTED`, because by then a contract exists.
 */
export function unwind(
  t,
  goodsDisposition,
) {
  if (goodsDisposition.trim().length === 0) {
    return reject(
      'OP-DETERMINACY',
      'GOODS_DISPOSITION_UNDOCUMENTED',
      'Unwinding an acquired position requires a documented disposition of the goods',
    );
  }
  return ok({ state: 'UNWIND', core: t.core, legs: t.legs, goodsDisposition });
}

export function bookObligation(
  t,
  obligationId,
  bookingRef,
) {
  return { state: 'ACTIVE', core: t.core, legs: t.legs, obligationId, bookingRef };
}

export function settle(t) {
  return { state: 'SETTLED', core: t.core, legs: t.legs, obligationId: t.obligationId };
}

// -- Shared -------------------------------------------------------------------

function gateEvaluation(
  riskPeriodRequiredSeconds,
  legs,
  ctx,
) {
  return evaluateGates({
    definition: ctx.definition,
    legs,
    evidence: ctx.evidence,
    riskPeriodRequiredSeconds,
    observedAt: ctx.observedAt,
  });
}

function requireSatisfied(
  evaluation,
  gateId,
) {
  const outcome = evaluation.gates.find((g) => g.gateId === gateId);
  if (outcome === undefined) {
    return reject('SH-05', 'GATE_NOT_DECLARED', 'The structure does not declare a required gate', {
      gateId,
    });
  }
  if (outcome.status !== 'SATISFIED') {
    return outcome.rejection !== undefined
      ? { ok: false, error: outcome.rejection }
      : reject('SH-05', 'GATE_UNSATISFIED', 'A sequencing gate is not satisfied', { gateId });
  }
  return ok({ dischargedBy: outcome.dischargedBy });
}
