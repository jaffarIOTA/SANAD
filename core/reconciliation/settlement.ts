/**
 * Partner settlement reconciliation for revenue-linked collection
 * (embedded lending, E-2).
 *
 * The partner routes the merchant's revenue and sweeps an agreed share to
 * the institution each period. Two things are reconciled: that the sweep
 * equals the agreed share of the reported revenue, and that what is applied
 * to the obligation never exceeds the fixed total. Under-sweeps are
 * exceptions for a person; over-collection is refunded through the outbox,
 * never kept, never silently netted.
 *
 * Pure. Integer arithmetic. The obligation's total is an input and is never
 * changed here.
 */

import { type Money, money } from '../kernel/money.ts';
import { type Result, ok, reject } from '../kernel/result.ts';
import { type Outbox, enqueue } from '../outbox/outbox.ts';
import { roundDiv } from '../pricing/rate.ts';

export interface SettlementLine {
  readonly settlementRef: string;
  readonly partnerRef: string;
  readonly merchantRef: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** The partner's reported gross revenue for the merchant in the period. */
  readonly grossRevenue: Money;
  /** What the partner actually swept. */
  readonly swept: Money;
}

export interface CollectionPosition {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly merchantRef: string;
  readonly partnerRef: string;
  readonly holdbackPerTenThousand: number;
  /** Fixed at inception. Never increases. */
  readonly totalPayable: Money;
  readonly collectedToDate: Money;
  readonly correlationId: string;
}

export type LineOutcome =
  | { readonly kind: 'APPLIED'; readonly applied: Money; readonly refunded: Money }
  | { readonly kind: 'SHORT'; readonly expected: Money; readonly swept: Money; readonly shortfall: Money }
  | { readonly kind: 'DUPLICATE' }
  | { readonly kind: 'FOREIGN'; readonly reason: string };

export interface Reconciliation {
  readonly position: CollectionPosition;
  readonly outbox: Outbox;
  readonly outcomes: readonly { readonly settlementRef: string; readonly outcome: LineOutcome }[];
  readonly settled: boolean;
}

export function reconcile(position: CollectionPosition, lines: readonly SettlementLine[], outbox: Outbox, seenRefs: ReadonlySet<string>): Result<Reconciliation> {
  if (position.collectedToDate.minorUnits > position.totalPayable.minorUnits) {
    return reject('OP-DETERMINACY', 'POSITION_OVER_COLLECTED', 'The position already shows more collected than is owed; a person must look before anything else is applied');
  }
  let collected = position.collectedToDate.minorUnits;
  let box = outbox;
  const seen = new Set(seenRefs);
  const outcomes: { settlementRef: string; outcome: LineOutcome }[] = [];

  for (const line of lines) {
    if (seen.has(line.settlementRef)) { outcomes.push({ settlementRef: line.settlementRef, outcome: { kind: 'DUPLICATE' } }); continue; }
    seen.add(line.settlementRef);
    if (line.partnerRef !== position.partnerRef || line.merchantRef !== position.merchantRef) {
      outcomes.push({ settlementRef: line.settlementRef, outcome: { kind: 'FOREIGN', reason: 'partner or merchant does not match the position' } });
      continue;
    }
    const expected = roundDiv(line.grossRevenue.minorUnits * BigInt(position.holdbackPerTenThousand), 10_000n);
    if (line.swept.minorUnits < expected) {
      outcomes.push({ settlementRef: line.settlementRef, outcome: { kind: 'SHORT', expected: money(expected, line.swept.currency), swept: line.swept, shortfall: money(expected - line.swept.minorUnits, line.swept.currency) } });
      // A short sweep is still money received: apply it, and let the exception carry the difference.
    }
    const remaining = position.totalPayable.minorUnits - collected;
    const applied = line.swept.minorUnits > remaining ? remaining : line.swept.minorUnits;
    const refunded = line.swept.minorUnits - applied;
    collected += applied;
    if (refunded > 0n) {
      const queued = enqueue(box, { eventId: `${position.transactionId}:refund:${line.settlementRef}`, tenantId: position.tenantId, kind: 'PAYMENT_DISBURSE', subjectRef: position.transactionId, idempotencyKey: `${position.transactionId}:refund:${line.settlementRef}`, payload: { beneficiaryRef: position.merchantRef, minorUnits: refunded.toString(), currency: line.swept.currency, reason: 'OVER_COLLECTION' }, correlationId: position.correlationId });
      if (!queued.ok) return queued;
      box = queued.value;
    }
    if (line.swept.minorUnits >= expected) outcomes.push({ settlementRef: line.settlementRef, outcome: { kind: 'APPLIED', applied: money(applied, line.swept.currency), refunded: money(refunded, line.swept.currency) } });
  }

  return ok({ position: { ...position, collectedToDate: money(collected, position.totalPayable.currency) }, outbox: box, outcomes, settled: collected === position.totalPayable.minorUnits });
}
