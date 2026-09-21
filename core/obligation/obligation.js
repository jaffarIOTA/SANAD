import {
  compare,
  equals,
  isNegative,
  subtract,
  sum
} from "../kernel/money.js";
import { ok, reject } from "../kernel/result.js";
function createObligation(params) {
  const check = validateSchedule(params.instalments, params.pricing.salePriceAmount);
  if (!check.ok) return check;
  return ok({
    obligationId: params.obligationId,
    tenantId: params.tenantId,
    transactionId: params.transactionId,
    totalAmount: params.pricing.salePriceAmount,
    instalments: params.instalments,
    waivedAmount: { minorUnits: 0n, currency: params.pricing.salePriceAmount.currency },
    paidAmount: { minorUnits: 0n, currency: params.pricing.salePriceAmount.currency }
  });
}
function reschedule(obligation, newInstalments) {
  const payable = amountPayable(obligation);
  const check = validateSchedule(newInstalments, payable);
  if (!check.ok) return check;
  return ok({ ...obligation, instalments: newInstalments });
}
function applyEarlySettlementRelief(obligation, waiver, revisedInstalments, basis) {
  if (isNegative(waiver)) {
    return reject("SH-02", "WAIVER_NEGATIVE", "A waiver cannot increase what is owed", {
      configKey: basis.configKey
    });
  }
  const payableBefore = amountPayable(obligation);
  if (compare(waiver, payableBefore) > 0) {
    return reject(
      "SH-02",
      "WAIVER_EXCEEDS_PAYABLE",
      "A waiver cannot exceed the amount still payable",
      { configKey: basis.configKey }
    );
  }
  const waived = {
    ...obligation,
    waivedAmount: sum([obligation.waivedAmount, waiver])
  };
  const check = validateSchedule(revisedInstalments, amountPayable(waived));
  if (!check.ok) return check;
  return ok({ ...waived, instalments: revisedInstalments });
}
function applyPayment(obligation, payment) {
  if (isNegative(payment)) {
    return reject("OP-DETERMINACY", "PAYMENT_NEGATIVE", "A payment cannot be negative");
  }
  const updated = { ...obligation, paidAmount: sum([obligation.paidAmount, payment]) };
  if (compare(updated.paidAmount, obligation.totalAmount) > 0) {
    return reject(
      "OP-DETERMINACY",
      "OVERPAYMENT",
      "Payments received exceed the fixed total; route to operations rather than absorbing it",
      { obligationId: obligation.obligationId }
    );
  }
  return ok(updated);
}
function amountPayable(o) {
  return subtract(o.totalAmount, o.waivedAmount);
}
function outstanding(o) {
  return subtract(amountPayable(o), o.paidAmount);
}
function validateSchedule(instalments, mustEqual) {
  if (instalments.length === 0) {
    return reject("SH-03", "SCHEDULE_EMPTY", "The schedule must be determinate at execution");
  }
  for (const i of instalments) {
    if (isNegative(i.amount)) {
      return reject("SH-03", "INSTALMENT_NEGATIVE", "An instalment cannot be negative", {
        instalmentNo: i.instalmentNo
      });
    }
    if (i.dueDateGregorian.length === 0 || i.dueDateHijri.length === 0) {
      return reject(
        "SH-03",
        "INSTALMENT_DATE_INDETERMINATE",
        "Each instalment carries a due date in both calendars",
        { instalmentNo: i.instalmentNo }
      );
    }
  }
  const scheduled = sum(
    instalments.map((i) => i.amount),
    mustEqual.currency
  );
  if (!equals(scheduled, mustEqual)) {
    const increases = compare(scheduled, mustEqual) > 0;
    return reject(
      "SH-02",
      increases ? "SCHEDULE_INCREASES_TOTAL" : "SCHEDULE_ALTERS_TOTAL",
      increases ? "The instalments sum to more than the fixed total; an executed obligation never increases" : "The instalments do not sum to the amount payable",
      {
        scheduledMinorUnits: String(scheduled.minorUnits),
        payableMinorUnits: String(mustEqual.minorUnits)
      }
    );
  }
  return ok(true);
}
export {
  amountPayable,
  applyEarlySettlementRelief,
  applyPayment,
  createObligation,
  outstanding,
  reschedule
};
