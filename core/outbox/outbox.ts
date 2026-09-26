/**
 * The transactional outbox (CLAUDE.md §2, §5, §11).
 *
 * Every external side effect — a disbursement, a bureau report, a partner
 * callback — is an event written in the same transaction as the state change
 * that caused it, and dispatched afterwards. Nothing is lost because the event
 * is durable; nothing is duplicated because each event carries an
 * idempotency key the receiving port honours, and the outbox itself refuses a
 * second event with the same key.
 *
 * This is the pure aggregate. Persistence and dispatch are the store's and
 * the worker's business.
 */

import { type Result, ok, reject } from '../kernel/result.ts';

export type OutboxKind =
  | 'PAYMENT_DISBURSE'
  | 'PAYMENT_COLLECT'
  | 'BUREAU_REPORT'
  | 'PARTNER_CALLBACK'
  | 'NOTIFICATION'
  | 'BILL_PRESENT';

export interface OutboxEvent {
  readonly eventId: string;
  readonly tenantId: string;
  readonly kind: OutboxKind;
  /** The aggregate this effect belongs to. */
  readonly subjectRef: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, string>>;
  readonly correlationId: string;
}

export interface Outbox {
  readonly events: readonly OutboxEvent[];
}

export const emptyOutbox = (): Outbox => ({ events: [] });

export function enqueue(outbox: Outbox, event: OutboxEvent): Result<Outbox> {
  if (event.idempotencyKey.trim().length === 0) {
    return reject('OP-DETERMINACY', 'SIDE_EFFECT_WITHOUT_KEY', 'Every external side effect carries an idempotency key');
  }
  const clash = outbox.events.find((e) => e.tenantId === event.tenantId && e.kind === event.kind && e.idempotencyKey === event.idempotencyKey);
  if (clash !== undefined) {
    return reject('OP-DETERMINACY', 'DUPLICATE_SIDE_EFFECT', 'An effect with this idempotency key is already queued; a second would be a duplicate', { kind: event.kind, idempotencyKey: event.idempotencyKey });
  }
  return ok({ events: [...outbox.events, event] });
}

export const eventsOfKind = (outbox: Outbox, kind: OutboxKind): readonly OutboxEvent[] => outbox.events.filter((e) => e.kind === kind);
