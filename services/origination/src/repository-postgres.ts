/**
 * The request repository on PostgreSQL (migration 0006).
 *
 * The state document is the engine's own; what is relational is what the
 * service queries by. Every statement is scoped by tenant and, for partner
 * reads, by partner — the absence of a row is the only answer a partner gets
 * about another partner's business.
 *
 * `pg` is the one vendor word in this file and it names a driver, not a
 * platform (ADR 0001).
 */

import { Pool, type PoolConfig } from 'pg';

import { decodeRequest, encodeRequest } from './codec.ts';
import type { Page, RequestRepository, StoredRequest } from './repository.ts';

interface Row {
  readonly request_id: string;
  readonly tenant_id: string;
  readonly partner_id: string;
  readonly request: unknown;
  readonly partner_reference: string | null;
  readonly sequence: string;
}

function toRecord(row: Row): StoredRequest {
  return {
    requestId: row.request_id,
    tenantId: row.tenant_id,
    partnerId: row.partner_id,
    request: decodeRequest(typeof row.request === 'string' ? row.request : JSON.stringify(row.request)),
    ...(row.partner_reference === null ? {} : { partnerReference: row.partner_reference }),
    sequence: Number.parseInt(row.sequence, 10),
  };
}

export function postgresRequestRepository(config: PoolConfig | Pool): RequestRepository & { close(): Promise<void> } {
  const pool = config instanceof Pool ? config : new Pool(config);

  return {
    nextRequestId(): Promise<string> {
      return Promise.resolve(crypto.randomUUID());
    },

    async save(record): Promise<void> {
      await pool.query(
        `insert into core.origination_request
           (tenant_id, request_id, partner_id, state, request, partner_reference, correlation_id, created_by)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
         on conflict (tenant_id, request_id) do update
           set state = excluded.state,
               request = excluded.request,
               partner_reference = excluded.partner_reference,
               updated_at = now()`,
        [
          record.tenantId,
          record.requestId,
          record.partnerId,
          record.request.state,
          encodeRequest(record.request),
          record.partnerReference ?? null,
          record.request.core.correlationId,
          record.partnerId,
        ],
      );
    },

    async find(tenantId, partnerId, requestId): Promise<StoredRequest | undefined> {
      const { rows } = await pool.query<Row>(
        `select request_id, tenant_id, partner_id, request, partner_reference, sequence::text
           from core.origination_request
          where tenant_id = $1 and partner_id = $2 and request_id = $3`,
        [tenantId, partnerId, requestId],
      );
      const row = rows[0];
      return row === undefined ? undefined : toRecord(row);
    },

    async list({ tenantId, partnerId, states, cursor, limit }): Promise<Page> {
      const before = cursor === undefined ? null : Number.parseInt(cursor, 10);
      const { rows } = await pool.query<Row>(
        `select request_id, tenant_id, partner_id, request, partner_reference, sequence::text
           from core.origination_request
          where tenant_id = $1 and partner_id = $2
            and ($3::text[] is null or state = any($3::text[]))
            and ($4::bigint is null or sequence < $4::bigint)
          order by sequence desc
          limit $5`,
        [tenantId, partnerId, states ?? null, Number.isFinite(before) ? before : null, limit + 1],
      );
      const items = rows.slice(0, limit).map(toRecord);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > limit && last !== undefined ? String(last.sequence) : null };
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
