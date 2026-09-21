import { appendLeg } from "../legs/leg.js";
import { ok, reject } from "../kernel/result.js";
import { isStrictlyLater } from "../time/tsa.js";
import { verifyDistinctParties, verifyNoBuyBack } from "../parties/distinctness.js";
import { evaluateGates } from "./gates.js";
function submit(t) {
  return { state: "TRADE_VALIDATION", core: t.core };
}
function rejectTrade(t, reasons) {
  return { state: "REJECTED", core: t.core, reasons };
}
function reserveLimit(t, reservationId) {
  return { state: "LIMIT_RESERVED", core: t.core, reservationId };
}
function executeWaad(t, leg, ctx) {
  const legs = appendLeg([], leg);
  if (!legs.ok) return legs;
  const distinct = verifyDistinctParties(ctx.definition, legs.value);
  if (!distinct.ok) return distinct;
  return ok({
    state: "WAAD_EXECUTED",
    core: t.core,
    reservationId: t.reservationId,
    legs: legs.value
  });
}
function executePurchase(t, leg, ctx) {
  const legs = appendLeg(t.legs, leg);
  if (!legs.ok) return legs;
  const distinct = verifyDistinctParties(ctx.definition, legs.value);
  if (!distinct.ok) return distinct;
  return ok({
    state: "PURCHASE_EXECUTED",
    core: t.core,
    reservationId: t.reservationId,
    legs: legs.value
  });
}
function acquireOwnership(t, ctx) {
  const evaluation = gateEvaluation(t.core.riskPeriodRequiredSeconds, t.legs, ctx);
  const gate = requireSatisfied(evaluation, "GATE_1_OWNERSHIP");
  if (!gate.ok) return gate;
  return ok({
    state: "OWNERSHIP_ACQUIRED",
    core: t.core,
    reservationId: t.reservationId,
    legs: t.legs,
    ownershipEvidenceIds: gate.value.dischargedBy
  });
}
function confirmPossession(t, ctx) {
  const evaluation = gateEvaluation(t.core.riskPeriodRequiredSeconds, t.legs, ctx);
  const ownership = requireSatisfied(evaluation, "GATE_1_OWNERSHIP");
  if (!ownership.ok) return ownership;
  const possession = requireSatisfied(evaluation, "GATE_2_POSSESSION");
  if (!possession.ok) return possession;
  const startAt = evaluation.riskPeriodStartAt;
  if (startAt === void 0) {
    return reject(
      "SH-06",
      "RISK_PERIOD_START_UNDETERMINED",
      "Possession is evidenced but the attested moment it began could not be determined",
      { transactionId: t.core.transactionId }
    );
  }
  return ok({
    state: "POSSESSION_CONFIRMED",
    core: t.core,
    reservationId: t.reservationId,
    legs: t.legs,
    ownershipEvidenceIds: t.ownershipEvidenceIds,
    possessionEvidenceIds: possession.value.dischargedBy,
    riskPeriodStartAt: startAt
  });
}
function offerSale(t, leg, offerExpiresAtEpochSeconds, ctx) {
  const evaluation = gateEvaluation(t.core.riskPeriodRequiredSeconds, t.legs, ctx);
  for (const gateId of ["GATE_1_OWNERSHIP", "GATE_2_POSSESSION", "GATE_3_RISK_PERIOD"]) {
    const gate = requireSatisfied(evaluation, gateId);
    if (!gate.ok) return gate;
  }
  if (!isStrictlyLater(ctx.observedAt, t.riskPeriodStartAt)) {
    return reject("SH-06", "SALE_NOT_AFTER_POSSESSION", "The offer must be attested after possession", {
      transactionId: t.core.transactionId
    });
  }
  const legs = appendLeg(t.legs, leg);
  if (!legs.ok) return legs;
  return ok({
    state: "SALE_OFFERED",
    core: t.core,
    reservationId: t.reservationId,
    legs: legs.value,
    riskPeriodStartAt: t.riskPeriodStartAt,
    saleOfferedAt: ctx.observedAt,
    offerExpiresAtEpochSeconds
  });
}
function acceptOffer(t, leg, ctx) {
  if (ctx.observedAt.epochSeconds > t.offerExpiresAtEpochSeconds) {
    return reject("SH-03", "OFFER_EXPIRED", "The offer has lapsed and must be reissued", {
      transactionId: t.core.transactionId
    });
  }
  if (!isStrictlyLater(ctx.observedAt, t.saleOfferedAt)) {
    return reject(
      "SH-07",
      "ACCEPTANCE_NOT_AFTER_OFFER",
      "Acceptance is a separate act and must be attested strictly after the offer",
      { transactionId: t.core.transactionId }
    );
  }
  const legs = appendLeg(t.legs, leg);
  if (!legs.ok) return legs;
  const distinct = verifyDistinctParties(ctx.definition, legs.value);
  if (!distinct.ok) return distinct;
  const noBuyBack = verifyNoBuyBack(legs.value);
  if (!noBuyBack.ok) return noBuyBack;
  return ok({
    state: "EXECUTED",
    core: t.core,
    legs: legs.value,
    acceptedAt: ctx.observedAt
  });
}
function lapseOffer(t, ctx) {
  if (ctx.observedAt.epochSeconds <= t.offerExpiresAtEpochSeconds) {
    return reject("SH-03", "OFFER_STILL_LIVE", "The offer has not yet expired", {
      transactionId: t.core.transactionId
    });
  }
  return ok({ state: "OFFER_LAPSED", core: t.core, legs: t.legs });
}
function unwind(t, goodsDisposition) {
  if (goodsDisposition.trim().length === 0) {
    return reject(
      "OP-DETERMINACY",
      "GOODS_DISPOSITION_UNDOCUMENTED",
      "Unwinding an acquired position requires a documented disposition of the goods"
    );
  }
  return ok({ state: "UNWIND", core: t.core, legs: t.legs, goodsDisposition });
}
function bookObligation(t, obligationId, bookingRef) {
  return { state: "ACTIVE", core: t.core, legs: t.legs, obligationId, bookingRef };
}
function settle(t) {
  return { state: "SETTLED", core: t.core, legs: t.legs, obligationId: t.obligationId };
}
function gateEvaluation(riskPeriodRequiredSeconds, legs, ctx) {
  return evaluateGates({
    definition: ctx.definition,
    legs,
    evidence: ctx.evidence,
    riskPeriodRequiredSeconds,
    observedAt: ctx.observedAt
  });
}
function requireSatisfied(evaluation, gateId) {
  const outcome = evaluation.gates.find((g) => g.gateId === gateId);
  if (outcome === void 0) {
    return reject("SH-05", "GATE_NOT_DECLARED", "The structure does not declare a required gate", {
      gateId
    });
  }
  if (outcome.status !== "SATISFIED") {
    return outcome.rejection !== void 0 ? { ok: false, error: outcome.rejection } : reject("SH-05", "GATE_UNSATISFIED", "A sequencing gate is not satisfied", { gateId });
  }
  return ok({ dischargedBy: outcome.dischargedBy });
}
export {
  acceptOffer,
  acquireOwnership,
  bookObligation,
  confirmPossession,
  executePurchase,
  executeWaad,
  lapseOffer,
  offerSale,
  rejectTrade,
  reserveLimit,
  settle,
  submit,
  unwind
};
