/** The outbox store on PostgreSQL (migration 0008). Claims under a lease with `for update skip locked`. */

import { Pool, type PoolConfig } from 'pg';

import type { OutboxEvent } from '../../../core/outbox/outbox.ts';
import type { OutboxRow, OutboxStore } from '../../../core/outbox/store.ts';

interface Row {
  readonly tenant_id: string;
  readonly event_id: string;
  readonly kind: OutboxEvent['kind'];
  readonly subject_ref: string;
  readonly idempotency_key: string;
  readonly payload: Record<string, string>;
  readonly state: OutboxRow['state'];
  readonly attempts: number;
  readonly next_attempt_at: string;
  readonly last_error: string | null;
  readonly delivery_ref: string | null;
  readonly correlation_id: string;
}

const toRow = (r: Row): OutboxRow => ({
  event: {
    eventId: r.event_id,
    tenantId: r.tenant_id,
    kind: r.kind,
    subjectRef: r.subject_ref,
    idempotencyKey: r.idempotency_key,
    payload: r.payload,
    correlationId: r.correlation_id,
  },
  state: r.state,
  attempts: r.attempts,
  nextAttemptAtEpochSeconds: BigInt(Math.floor(new Date(r.next_attempt_at).getTime() / 1000)),
  ...(r.last_error === null ? {} : { lastError: r.last_error }),
  ...(r.delivery_ref === null ? {} : { deliveryRef: r.delivery_ref }),
});

export function postgresOutboxStore(config: PoolConfig | Pool): OutboxStore & { close(): Promise<void> } {
  const pool = config instanceof Pool ? config : new Pool(config);
  return {
    async append(events) {
      for (const e of events) {
        await pool.query(
          `insert into core.outbox_event (tenant_id, event_id, kind, subject_ref, idempotency_key, payload, correlation_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7) on conflict (tenant_id, kind, idempotency_key) do nothing`,
          [e.tenantId, e.eventId, e.kind, e.subjectRef, e.idempotencyKey, JSON.stringify(e.payload), e.correlationId],
        );
      }
    },
    async claim(now, limit, leaseSeconds) {
      const { rows } = await pool.query<Row>(
        `with due as (
           select tenant_id, event_id from core.outbox_event
            where state = 'PENDING' and next_attempt_at <= to_timestamp($1) and (leased_until is null or leased_until <= to_timestamp($1))
            order by next_attempt_at limit $2 for update skip locked)
         update core.outbox_event o set leased_until = to_timestamp($1) + make_interval(secs => $3)
           from due where o.tenant_id = due.tenant_id and o.event_id = due.event_id
         returning o.*`,
        [Number(now), limit, leaseSeconds],
      );
      return rows.map(toRow);
    },
    async markDelivered(eventId, deliveryRef) {
      await pool.query(
        `update core.outbox_event set state = 'DELIVERED', attempts = attempts + 1, delivery_ref = $2, leased_until = null where event_id = $1`,
        [eventId, deliveryRef],
      );
    },
    async markRetry(eventId, next, error) {
      await pool.query(
        `update core.outbox_event set attempts = attempts + 1, next_attempt_at = to_timestamp($2), last_error = $3, leased_until = null where event_id = $1`,
        [eventId, Number(next), error],
      );
    },
    async markDead(eventId, error) {
      await pool.query(
        `update core.outbox_event set state = 'DEAD', attempts = attempts + 1, last_error = $2, leased_until = null where event_id = $1`,
        [eventId, error],
      );
    },
    async rows() {
      const { rows } = await pool.query<Row>(`select * from core.outbox_event order by created_at`);
      return rows.map(toRow);
    },
    async close() {
      await pool.end();
    },
  };
}
