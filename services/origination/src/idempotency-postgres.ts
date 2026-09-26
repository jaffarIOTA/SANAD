/**
 * The idempotency ledger on PostgreSQL (migration 0006).
 *
 * `reserve` is one `insert … on conflict do nothing returning`: atomic under
 * concurrency, as the port requires. A key that exists with the same
 * fingerprint and a recorded response replays; with a different fingerprint
 * conflicts; with no response yet is in flight.
 */

import { Pool, type PoolConfig } from 'pg';

import { decodeJson, encodeJson } from './codec.ts';
import type { IdempotencyStore, Reservation, StoredResponse } from './idempotency.ts';

export function postgresIdempotencyStore(config: PoolConfig | Pool): IdempotencyStore & { close(): Promise<void> } {
  const pool = config instanceof Pool ? config : new Pool(config);

  return {
    async reserve({ tenantId, partnerId, key, fingerprint }): Promise<Reservation> {
      const inserted = await pool.query(
        `insert into core.idempotency_key (tenant_id, partner_id, key, fingerprint, status)
         values ($1, $2, $3, $4, 'IN_FLIGHT')
         on conflict (tenant_id, partner_id, key) do nothing
         returning key`,
        [tenantId, partnerId, key, fingerprint],
      );
      if (inserted.rowCount === 1) return { kind: 'FRESH' };

      const { rows } = await pool.query<{ fingerprint: string; status: string; response: unknown }>(
        `select fingerprint, status, response from core.idempotency_key
          where tenant_id = $1 and partner_id = $2 and key = $3`,
        [tenantId, partnerId, key],
      );
      const row = rows[0];
      if (row === undefined) return { kind: 'IN_FLIGHT' };
      if (row.fingerprint !== fingerprint) return { kind: 'CONFLICT' };
      if (row.status !== 'COMPLETE' || row.response === null) return { kind: 'IN_FLIGHT' };
      const response = decodeJson(typeof row.response === 'string' ? row.response : JSON.stringify(row.response)) as StoredResponse;
      return { kind: 'REPLAY', response };
    },

    async complete({ tenantId, partnerId, key, response }): Promise<void> {
      await pool.query(
        `update core.idempotency_key
            set status = 'COMPLETE', response = $4::jsonb, completed_at = now()
          where tenant_id = $1 and partner_id = $2 and key = $3`,
        [tenantId, partnerId, key, encodeJson(response)],
      );
    },

    async release({ tenantId, partnerId, key }): Promise<void> {
      await pool.query(
        `delete from core.idempotency_key
          where tenant_id = $1 and partner_id = $2 and key = $3 and status = 'IN_FLIGHT'`,
        [tenantId, partnerId, key],
      );
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
