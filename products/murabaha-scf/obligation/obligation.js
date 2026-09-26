/**
 * The obligation and its schedule.
 *
 * The total is fixed at execution. No subsequent event increases it — not
 * default, not rescheduling, not extension (SH-02, BR-E01). Rescheduling moves
 * dates and re-splits amounts; the sum must equal the original total exactly, and
 * a payload that does not is rejected here *and* by a deferred database
 * constraint, because a single layer of enforcement is a single point of failure.
 *
 * The one permitted movement is downward: *ibra'*, the waiver on early
 * settlement, applied in exactly the form the Board ruled and reconciled with the
 * regulatory requirement. Its basis is configuration, never a formula in code
 * (BR-E06). A waiver reduces what is owed, which is the opposite of riba, so the
 * invariant is one-directional rather than "the total never changes".
 */

import {

  compare,
  equals,
  isNegative,
  subtract,
  sum,
} from '../../../core/kernel/money.js';
import { ok, reject } from '../../../core/kernel/result.js';






















export function createObligation(params





) {
  const check = validateSchedule(params.instalments, params.pricing.salePriceAmount);
  if (!check.ok) return check;

  return ok({
    obligationId: params.obligationId,
    tenantId: params.tenantId,
    transactionId: params.transactionId,
    totalAmount: params.pricing.salePriceAmount,
    instalments: params.instalments,
    waivedAmount: { minorUnits: 0n, currency: params.pricing.salePriceAmount.currency },
    paidAmount: { minorUnits: 0n, currency: params.pricing.salePriceAmount.currency },
  });
}

/**
 * Reschedule: new dates, new splits, same total.
 *
 * This function has no parameter through which a new total could be supplied.
 * The only total in scope is the one already on the obligation.
 */
export function reschedule(
  obligation,
  newInstalments,
) {
  const payable = amountPayable(obligation);
  const check = validateSchedule(newInstalments, payable);
  if (!check.ok) return check;

  return ok({ ...obligation, instalments: newInstalments });
}

/**
 * Early settlement relief. The amount and its basis come from tenant
 * configuration that the Board set; this function only enforces that a waiver
 * reduces and never increases, and that the result stays non-negative.
 */
export function applyEarlySettlementRelief(
  obligation,
  waiver,
  /**
   * The re-cut schedule. Required rather than derived: how the remaining amount
   * is redistributed is the institution's policy, and the platform's job is to
   * check the arithmetic, not to invent the method.
   */
  revisedInstalments,
  basis,
) {
  if (isNegative(waiver)) {
    return reject('SH-02', 'WAIVER_NEGATIVE', 'A waiver cannot increase what is owed', {
      configKey: basis.configKey,
    });
  }
  const payableBefore = amountPayable(obligation);
  if (compare(waiver, payableBefore) > 0) {
    return reject(
      'SH-02',
      'WAIVER_EXCEEDS_PAYABLE',
      'A waiver cannot exceed the amount still payable',
      { configKey: basis.configKey },
    );
  }

  const waived = {
    ...obligation,
    waivedAmount: sum([obligation.waivedAmount, waiver]),
  };

  const check = validateSchedule(revisedInstalments, amountPayable(waived));
  if (!check.ok) return check;

  return ok({ ...waived, instalments: revisedInstalments });
}

/** Payments reduce the balance and never change the total. */
export function applyPayment(obligation, payment) {
  if (isNegative(payment)) {
    return reject('OP-DETERMINACY', 'PAYMENT_NEGATIVE', 'A payment cannot be negative');
  }
  const updated = { ...obligation, paidAmount: sum([obligation.paidAmount, payment]) };
  if (compare(updated.paidAmount, obligation.totalAmount) > 0) {
    return reject(
      'OP-DETERMINACY',
      'OVERPAYMENT',
      'Payments received exceed the fixed total; route to operations rather than absorbing it',
      { obligationId: obligation.obligationId },
    );
  }
  return ok(updated);
}

/** Total, less anything waived. What the schedule must sum to. */
export function amountPayable(o) {
  return subtract(o.totalAmount, o.waivedAmount);
}

export function outstanding(o) {
  return subtract(amountPayable(o), o.paidAmount);
}

// -----------------------------------------------------------------------------

function validateSchedule(
  instalments,
  mustEqual,
) {
  if (instalments.length === 0) {
    return reject('SH-03', 'SCHEDULE_EMPTY', 'The schedule must be determinate at execution');
  }

  for (const i of instalments) {
    if (isNegative(i.amount)) {
      return reject('SH-03', 'INSTALMENT_NEGATIVE', 'An instalment cannot be negative', {
        instalmentNo: i.instalmentNo,
      });
    }
    if (i.dueDateGregorian.length === 0 || i.dueDateHijri.length === 0) {
      return reject(
        'SH-03',
        'INSTALMENT_DATE_INDETERMINATE',
        'Each instalment carries a due date in both calendars',
        { instalmentNo: i.instalmentNo },
      );
    }
  }

  const scheduled = sum(
    instalments.map((i) => i.amount),
    mustEqual.currency,
  );

  if (!equals(scheduled, mustEqual)) {
    const increases = compare(scheduled, mustEqual) > 0;
    return reject(
      'SH-02',
      increases ? 'SCHEDULE_INCREASES_TOTAL' : 'SCHEDULE_ALTERS_TOTAL',
      increases
        ? 'The instalments sum to more than the fixed total; an executed obligation never increases'
        : 'The instalments do not sum to the amount payable',
      {
        scheduledMinorUnits: String(scheduled.minorUnits),
        payableMinorUnits: String(mustEqual.minorUnits),
      },
    );
  }

  return ok(true);
}
