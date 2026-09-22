import { ok, reject } from "../kernel/result.js";
import {
  CHANNEL_POLICIES,
  verifyIdentification
} from "./channel.js";
function raise(params) {
  const { core, maker } = params;
  const identified = verifyIdentification(core.channel, core.identification);
  if (!identified.ok) return identified;
  if (maker.tenantId !== core.tenantId) {
    return reject(
      "OP-DETERMINACY",
      "PRINCIPAL_TENANT_MISMATCH",
      "A principal may not raise a request in another tenant",
      { requestId: core.requestId }
    );
  }
  if (core.requestedAmount.minorUnits <= 0n) {
    return reject("SH-03", "REQUESTED_AMOUNT_NOT_POSITIVE", "A request must name a positive amount");
  }
  if (core.requestedTenorDays <= 0) {
    return reject("SH-03", "TENOR_NOT_DETERMINATE", "A request must name a determinate tenor");
  }
  return ok({ state: "KEYING", core, maker });
}
function submitForReview(request, at) {
  const policy = CHANNEL_POLICIES[request.core.channel];
  if (policy.requiresServicingDecision) {
    return ok({
      state: "AWAITING_SERVICING_RESPONSE",
      core: request.core,
      maker: request.maker,
      submittedAt: at
    });
  }
  return ok({
    state: "AWAITING_REVIEW",
    core: request.core,
    maker: request.maker,
    submittedAt: at
  });
}
function recordServicingOutcome(request, outcome) {
  if (outcome.reference.trim().length === 0) {
    return reject(
      "OP-DETERMINACY",
      "SERVICING_REFERENCE_MISSING",
      "A servicing response must carry the platform\u2019s own reference, so the two records can be reconciled",
      { requestId: request.core.requestId }
    );
  }
  if (outcome.decision !== "APPROVED" && (outcome.reasonCode ?? "").trim().length === 0) {
    return reject(
      "OP-DETERMINACY",
      "SERVICING_REASON_MISSING",
      "A servicing decline or referral must say why; the reviewer needs it and so does the counterparty",
      { requestId: request.core.requestId, decision: outcome.decision }
    );
  }
  return ok({
    state: "AWAITING_REVIEW",
    core: request.core,
    maker: request.maker,
    submittedAt: request.submittedAt,
    servicing: outcome
  });
}
function approve(request, checker, at, contraryJustification) {
  if (checker.tenantId !== request.core.tenantId) {
    return reject(
      "OP-DETERMINACY",
      "PRINCIPAL_TENANT_MISMATCH",
      "A principal may not approve a request in another tenant",
      { requestId: request.core.requestId }
    );
  }
  const policy = CHANNEL_POLICIES[request.core.channel];
  if (policy.requiresFourEyes && checker.principalId === request.maker.principalId) {
    return reject(
      "OP-DETERMINACY",
      "FOUR_EYES_VIOLATED",
      "The principal who raised a request cannot be the one who approves it",
      { requestId: request.core.requestId, channel: request.core.channel }
    );
  }
  const policy2 = CHANNEL_POLICIES[request.core.channel];
  if (policy2.requiresServicingDecision && request.servicing === void 0) {
    return reject(
      "OP-DETERMINACY",
      "SERVICING_RESPONSE_NOT_RECEIVED",
      "This channel consults the servicing platform before a human decides, and no response has been recorded",
      { requestId: request.core.requestId, channel: request.core.channel }
    );
  }
  const declined = request.servicing?.decision === "DECLINED";
  const justification = (contraryJustification ?? "").trim();
  if (declined && justification.length === 0) {
    return reject(
      "OP-DETERMINACY",
      "CONTRARY_APPROVAL_UNJUSTIFIED",
      "The servicing platform declined. Approving anyway is permitted, and requires a recorded justification",
      { requestId: request.core.requestId }
    );
  }
  if (!declined && justification.length > 0) {
    return reject(
      "OP-DETERMINACY",
      "CONTRARY_JUSTIFICATION_NOT_APPLICABLE",
      "A contrary justification was supplied but the servicing platform did not decline",
      { requestId: request.core.requestId }
    );
  }
  return ok({
    state: "APPROVED",
    core: request.core,
    maker: request.maker,
    checker,
    approvedAt: at,
    ...request.servicing === void 0 ? {} : { servicing: request.servicing },
    ...declined ? { contraryToServicing: { justification } } : {}
  });
}
function returnToMaker(request, reviewer, note) {
  if (note.trim().length === 0) {
    return reject(
      "OP-DETERMINACY",
      "RETURN_WITHOUT_REASON",
      "Returning a request to its maker requires saying what needs changing",
      { requestId: request.core.requestId }
    );
  }
  return ok({
    state: "RETURNED_TO_MAKER",
    core: request.core,
    maker: request.maker,
    reviewer,
    note
  });
}
function rejectRequest(request, reviewer, reasonCode) {
  if (reasonCode.trim().length === 0) {
    return reject(
      "OP-DETERMINACY",
      "REJECTION_WITHOUT_REASON_CODE",
      "A rejection names a reason code from the catalogue; the counterparty is owed an explanation",
      { requestId: request.core.requestId }
    );
  }
  return ok({ state: "REJECTED", core: request.core, reviewer, reasonCode });
}
function reopen(request) {
  return { state: "KEYING", core: request.core, maker: request.maker };
}
function withdraw(request) {
  return { state: "WITHDRAWN", core: request.core };
}
function openTransaction(request, core) {
  if (core.tenantId !== request.core.tenantId) {
    return reject(
      "OP-DETERMINACY",
      "TENANT_MISMATCH",
      "The transaction and the request it came from must belong to one tenant",
      { requestId: request.core.requestId }
    );
  }
  if (core.counterpartyId !== request.core.counterpartyId) {
    return reject(
      "OP-DETERMINACY",
      "COUNTERPARTY_MISMATCH",
      "The transaction must be for the counterparty the request named",
      { requestId: request.core.requestId }
    );
  }
  if (core.tradeReference.invoiceUuid !== request.core.tradeReference.invoiceUuid) {
    return reject(
      "SH-10",
      "TRADE_REFERENCE_SUBSTITUTED",
      "The trade on the transaction is not the trade that was approved",
      { requestId: request.core.requestId }
    );
  }
  return ok({ state: "DRAFT", core });
}
export {
  approve,
  openTransaction,
  raise,
  recordServicingOutcome,
  rejectRequest,
  reopen,
  returnToMaker,
  submitForReview,
  withdraw
};
