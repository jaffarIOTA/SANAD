/**
 * The workbench's request book on PostgreSQL (`core.origination_request`,
 * migrations 0006 and 0010).
 *
 * The store keeps its synchronous in-process working set, because every page
 * and route reads it synchronously; this module is what makes that set
 * durable. It loads the tenant's book once per process and writes back every
 * request the store marks as changed, before the response that reports the
 * change is sent.
 *
 * Enabled only when `SANAD_DATABASE_URL` is set. Without it the workbench
 * runs as it did, in memory, and says so.
 */

import type { Pool } from 'pg';

import type { OriginationRequest } from '@sanad/core/origination/request.ts';
import { decodeRequest, encodeRequest } from '@sanad/origination/codec.ts';
import { sharedPool, tenantUuidByCode } from '@sanad/origination/credentials.ts';

export interface PersistedRequest {
  readonly requestId: string;
  readonly request: OriginationRequest;
  /** The invoice's printed number. A display label; no decision reads it. */
  readonly invoiceNumber?: string;
  readonly partnerReference?: string;
}

/** The workbench persists only against an explicitly configured database, never the test fallback. */
export function persistenceUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  const url = env['SANAD_DATABASE_URL'];
  return url === undefined || url.trim().length === 0 ? undefined : url.trim();
}

export function persistencePool(env: Readonly<Record<string, string | undefined>> = process.env): Pool | undefined {
  const url = persistenceUrl(env);
  return url === undefined ? undefined : sharedPool(url);
}

/** Who the row belongs to for the partner feed: the partner on the partner channel, the workbench otherwise. */
function ownerOf(request: OriginationRequest): string {
  const id = request.core.identification;
  return id.kind === 'PARTNER_SYSTEM' ? id.partnerId : 'workbench';
}

interface Row {
  readonly request_id: string;
  readonly request: unknown;
  readonly partner_reference: string | null;
  readonly display: { readonly invoiceNumber?: unknown } | null;
}

/** The tenant's whole book, oldest first, so the store's sequence can be rebuilt in order. */
export async function loadRequests(pool: Pool, tenantCode: string): Promise<readonly PersistedRequest[]> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const { rows } = await pool.query<Row>(
    `select request_id, request, partner_reference, display
       from core.origination_request
      where tenant_id = $1::uuid
      order by sequence asc`,
    [tenant],
  );
  return rows.map((row) => {
    const invoiceNumber = row.display?.invoiceNumber;
    return {
      requestId: row.request_id,
      request: decodeRequest(typeof row.request === 'string' ? row.request : JSON.stringify(row.request)),
      ...(typeof invoiceNumber === 'string' ? { invoiceNumber } : {}),
      ...(row.partner_reference === null ? {} : { partnerReference: row.partner_reference }),
    };
  });
}

/** Upserts each record in one transaction: either the whole change is durable or none of it is. */
export async function saveRequests(pool: Pool, tenantCode: string, records: readonly PersistedRequest[]): Promise<void> {
  if (records.length === 0) return;
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const record of records) {
      const owner = ownerOf(record.request);
      await client.query(
        `insert into core.origination_request
           (tenant_id, request_id, partner_id, state, request, partner_reference, display, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9)
         on conflict (tenant_id, request_id) do update
           set state = excluded.state,
               request = excluded.request,
               partner_reference = excluded.partner_reference,
               display = excluded.display,
               updated_at = now()`,
        [
          tenant,
          record.requestId,
          owner,
          record.request.state,
          encodeRequest(record.request),
          record.partnerReference ?? null,
          JSON.stringify(record.invoiceNumber === undefined ? {} : { invoiceNumber: record.invoiceNumber }),
          record.request.core.correlationId,
          owner,
        ],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
