import { isNegative, isPositive } from "../kernel/money.js";
import { ok, reject } from "../kernel/result.js";
function postLateAmount(request) {
  if (request.assessment === "UNABLE") {
    return reject(
      "SH-14",
      "HARDSHIP_SUSPENDS_LATE_AMOUNTS",
      "The counterparty is assessed as unable to pay; the case belongs in the hardship process and late amounts are suspended",
      { transactionId: request.transactionId }
    );
  }
  if (isNegative(request.amount) || !isPositive(request.amount)) {
    return reject("OP-DETERMINACY", "LATE_AMOUNT_NOT_POSITIVE", "A late amount must be positive");
  }
  if (request.computationBasisConfigKey.length === 0) {
    return reject(
      "SH-13",
      "NO_COMPUTATION_BASIS",
      "A late amount must name the Board-approved basis on which it was computed",
      { transactionId: request.transactionId }
    );
  }
  return ok({
    entryId: request.entryId,
    tenantId: request.tenantId,
    transactionId: request.transactionId,
    accountClass: "CHARITY_LIABILITY",
    amount: request.amount,
    reason: "LATE_PAYMENT",
    computationBasisConfigKey: request.computationBasisConfigKey,
    shariahApprovalId: request.shariahApprovalId,
    recordedAt: request.recordedAt
  });
}
function disburse(entry, recipientId, approvedRecipients, disbursementRef) {
  if (!approvedRecipients.includes(recipientId)) {
    return reject(
      "SH-13",
      "RECIPIENT_NOT_APPROVED",
      "Disbursement is only to recipients on the Board-approved register",
      { recipientId }
    );
  }
  if (entry.disbursementRef !== void 0) {
    return reject("SH-13", "ALREADY_DISBURSED", "This entry has already been disbursed", {
      entryId: entry.entryId
    });
  }
  return ok({ ...entry, disbursementRef });
}
export {
  disburse,
  postLateAmount
};
