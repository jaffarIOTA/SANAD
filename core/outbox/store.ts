/**
 * The durable side of the outbox: events written in the same transaction as
 * the state change that caused them, claimed by a worker under a lease, and
 * marked as delivered or dead. This is the port; PostgreSQL implements it in
 * production and a Map in development and tests.
 */

import type { OutboxEvent } from './outbox.ts';

export type DeliveryState = 'PENDING' | 'DELIVERED' | 'DEAD';

export interface OutboxRow {
  readonly event: OutboxEvent;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly nextAttemptAtEpochSeconds: bigint;
  readonly lastError?: string;
  readonly deliveryRef?: string;
}

export interface OutboxStore {
  /** Idempotent on (tenant, kind, idempotencyKey): a second append of the same effect is a no-op. */
  append(events: readonly OutboxEvent[]): Promise<void>;
  /** Pending rows due at or before `nowEpochSeconds`, leased to this worker for `leaseSeconds`. */
  claim(nowEpochSeconds: bigint, limit: number, leaseSeconds: number): Promise<readonly OutboxRow[]>;
  markDelivered(eventId: string, deliveryRef: string): Promise<void>;
  markRetry(eventId: string, nextAttemptAtEpochSeconds: bigint, error: string): Promise<void>;
  markDead(eventId: string, error: string): Promise<void>;
  /** For the operations view. */
  rows(): Promise<readonly OutboxRow[]>;
}

export function inMemoryOutboxStore(): OutboxStore {
  const rows = new Map<string, OutboxRow & { leasedUntil?: bigint }>();
  const keyOf = (e: OutboxEvent) => `${e.tenantId}\u0000${e.kind}\u0000${e.idempotencyKey}`;
  const seen = new Set<string>();
  return {
    append(events) {
      for (const event of events) {
        const k = keyOf(event);
        if (seen.has(k)) continue;
        seen.add(k);
        rows.set(event.eventId, { event, state: 'PENDING', attempts: 0, nextAttemptAtEpochSeconds: 0n });
      }
      return Promise.resolve();
    },
    claim(now, limit, leaseSeconds) {
      const due = [...rows.values()]
        .filter(
          (r) =>
            r.state === 'PENDING' &&
            r.nextAttemptAtEpochSeconds <= now &&
            (r.leasedUntil === undefined || r.leasedUntil <= now),
        )
        .slice(0, limit);
      for (const r of due) rows.set(r.event.eventId, { ...r, leasedUntil: now + BigInt(leaseSeconds) });
      return Promise.resolve(due);
    },
    markDelivered(eventId, deliveryRef) {
      const r = rows.get(eventId);
      if (r) rows.set(eventId, { ...r, state: 'DELIVERED', attempts: r.attempts + 1, deliveryRef });
      return Promise.resolve();
    },
    markRetry(eventId, next, error) {
      const r = rows.get(eventId);
      if (r) rows.set(eventId, { ...r, attempts: r.attempts + 1, nextAttemptAtEpochSeconds: next, lastError: error });
      return Promise.resolve();
    },
    markDead(eventId, error) {
      const r = rows.get(eventId);
      if (r) rows.set(eventId, { ...r, state: 'DEAD', attempts: r.attempts + 1, lastError: error });
      return Promise.resolve();
    },
    rows() {
      return Promise.resolve([...rows.values()].map(({ leasedUntil: _l, ...r }) => r));
    },
  };
}

/** One pass of the worker: claim what is due, dispatch each, record the outcome. Returns what happened, for logs and tests. */
export async function runOutboxPass(
  store: OutboxStore,
  dispatch: (
    event: OutboxEvent,
    attempt: number,
  ) => Promise<
    | { readonly kind: 'DELIVERED'; readonly deliveryRef: string }
    | { readonly kind: 'RETRY'; readonly afterSeconds: number; readonly reason: string }
    | { readonly kind: 'DEAD'; readonly reason: string }
  >,
  nowEpochSeconds: bigint,
  options: { readonly limit?: number; readonly leaseSeconds?: number } = {},
): Promise<readonly { readonly eventId: string; readonly kind: string; readonly outcome: string }[]> {
  const claimed = await store.claim(nowEpochSeconds, options.limit ?? 50, options.leaseSeconds ?? 60);
  const results: { eventId: string; kind: string; outcome: string }[] = [];
  for (const row of claimed) {
    const outcome = await dispatch(row.event, row.attempts + 1);
    if (outcome.kind === 'DELIVERED') await store.markDelivered(row.event.eventId, outcome.deliveryRef);
    else if (outcome.kind === 'RETRY')
      await store.markRetry(row.event.eventId, nowEpochSeconds + BigInt(outcome.afterSeconds), outcome.reason);
    else await store.markDead(row.event.eventId, outcome.reason);
    results.push({ eventId: row.event.eventId, kind: row.event.kind, outcome: outcome.kind });
  }
  return results;
}
