/**
 * The payment instructions a Wasl transaction causes (W4a), as outbox events:
 * written in the same database transaction as the step that causes them and
 * dispatched afterwards by the outbox worker (core/outbox/dispatch.ts), each
 * with an idempotency key the payments rail honours, so a retry is the same
 * payment and never a second one.
 *
 *   - Paying the seller: when the purchase executes, the institution owes the
 *     anchor the cost of the goods. A `PAYMENT_DISBURSE` to the anchor's
 *     settlement account, through the institution's payments hub.
 *   - Collecting an instalment: a `BILL_PRESENT` to SADAD, one bill per
 *     instalment presentation, payable by the distributor.
 *
 * Keys: `wasl:<transaction>:seller[:R<n>]` and
 * `wasl:<transaction>:collect:I<n>[:R<n>]` — a new attempt after a rejection
 * or a return is a new key; the same attempt retried is the same key.
 */
import type { WaslParties } from '@sanad/config/loader.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import type { OutboxEvent } from '@sanad/core/outbox/outbox.ts';
import type { Money } from '@sanad/core/kernel/money.ts';
import type { TransactionCore } from '@sanad/products/murabaha-scf/sequencing/state.ts';

const attemptSuffix = (attempt: number): string => (attempt > 0 ? `:R${String(attempt)}` : '');

/** The payment of the cost to the anchor that issued the invoice, for this transaction's programme. */
export function sellerSettlement(
  parties: WaslParties,
  transactionRef: string,
  core: TransactionCore,
  attempt: number,
): Result<OutboxEvent> {
  const programme = parties.programmes.find((p) => p.programmeId === core.programmeId);
  if (programme === undefined)
    return reject(
      'OP-DETERMINACY',
      'PROGRAMME_NOT_CONFIGURED',
      'The transaction names a programme that is not configured',
    );
  // The seller on the purchase is the invoice's issuer; the programme's anchor is who is paid, and they must agree.
  if (programme.anchor.registrationNo !== core.tradeReference.issuerCr)
    return reject('SH-08', 'SELLER_IS_NOT_THE_ANCHOR', 'The invoice was not issued by this programme’s anchor');
  const key = `wasl:${transactionRef}:seller${attemptSuffix(attempt)}`;
  const cost = core.pricing.costAmount;
  return ok({
    eventId: key,
    tenantId: core.tenantId,
    kind: 'PAYMENT_DISBURSE',
    subjectRef: transactionRef,
    idempotencyKey: key,
    payload: {
      rail: 'PAYMENTS_HUB',
      beneficiaryRef: `anchor:${programme.anchor.registrationNo}`,
      beneficiaryIban: programme.anchor.settlementIban,
      minorUnits: cost.minorUnits.toString(),
      currency: cost.currency,
      reason: 'MURABAHA_PURCHASE',
    },
    correlationId: core.correlationId,
  });
}

/** One instalment presented to SADAD for the distributor to pay: the bill number names the transaction and instalment. */
export function instalmentBill(
  transactionRef: string,
  core: TransactionCore,
  payerRef: string,
  instalment: { readonly sequenceNumber: number; readonly dueDateGregorian: string; readonly outstanding: Money },
  attempt: number,
): OutboxEvent {
  const key = `wasl:${transactionRef}:collect:I${String(instalment.sequenceNumber)}${attemptSuffix(attempt)}`;
  return {
    eventId: key,
    tenantId: core.tenantId,
    kind: 'BILL_PRESENT',
    // SADAD's bill number: one per instalment, the same across re-presentations of it.
    subjectRef: `${transactionRef}-I${String(instalment.sequenceNumber)}`,
    idempotencyKey: key,
    payload: {
      payerRef,
      minorUnits: instalment.outstanding.minorUnits.toString(),
      currency: instalment.outstanding.currency,
      dueDateGregorian: instalment.dueDateGregorian,
    },
    correlationId: core.correlationId,
  };
}
