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

import type { PresentedDocument } from '@sanad/core/documents/checklist.ts';
import type { OriginationRequest } from '@sanad/core/origination/request.ts';
import { tsaInstant } from '@sanad/core/time/tsa.ts';
import { decodeRequest, encodeRequest } from '@sanad/origination/codec.ts';
import { sharedPool, tenantUuidByCode } from '@sanad/origination/credentials.ts';
import { type IdempotencyStore, inMemoryIdempotencyStore } from '@sanad/origination/idempotency.ts';
import { postgresIdempotencyStore } from '@sanad/origination/idempotency-postgres.ts';

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

/**
 * The partner API's idempotency ledger: the database's when one is
 * configured (migration 0006), so a replay is recognised after a restart and
 * across processes; this process's memory otherwise. The ledger's table keys
 * on the tenant's uuid and the API's principal carries the tenant's code, so
 * the code is translated here, at the boundary.
 */
export function idempotencyLedger(env: Readonly<Record<string, string | undefined>> = process.env): IdempotencyStore {
  const pool = persistencePool(env);
  if (pool === undefined) return inMemoryIdempotencyStore();
  const durable = postgresIdempotencyStore(pool);
  const uuid = (code: string): Promise<string> => tenantUuidByCode(pool, code);
  return {
    reserve: async (p) => durable.reserve({ ...p, tenantId: await uuid(p.tenantId) }),
    complete: async (p) => durable.complete({ ...p, tenantId: await uuid(p.tenantId) }),
    release: async (p) => durable.release({ ...p, tenantId: await uuid(p.tenantId) }),
  };
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

export interface PersistedDocument {
  readonly requestId: string;
  /** Position among the request's documents, in the order presented. */
  readonly position: number;
  readonly document: PresentedDocument;
}

/** Every document presented against the tenant's requests, in the order presented (`evidence.presented_document`, migration 0012). */
export async function loadDocuments(pool: Pool, tenantCode: string): Promise<readonly PersistedDocument[]> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const { rows } = await pool.query<{
    request_id: string;
    position: number;
    document_type: string;
    validation_status: PresentedDocument['validationStatus'];
    captured_at_epoch: string;
    captured_tsa_digest: string;
    captured_tsa_authority: string;
  }>(
    `select request_id, position, document_type, validation_status,
            captured_at_epoch::text, captured_tsa_digest, captured_tsa_authority
       from evidence.presented_document
      where tenant_id = $1::uuid
      order by request_id, position`,
    [tenant],
  );
  return rows.map((r) => ({
    requestId: r.request_id,
    position: r.position,
    document: {
      documentType: r.document_type,
      validationStatus: r.validation_status,
      // Rebuilt through the one function allowed to establish an attested instant.
      capturedAt: tsaInstant({
        verified: true,
        genTimeEpochSeconds: BigInt(r.captured_at_epoch),
        tokenDigest: r.captured_tsa_digest,
        authorityId: r.captured_tsa_authority,
      }),
    },
  }));
}

/** Appends. The table refuses an update, and a position already written is left as it was. */
export async function saveDocuments(
  pool: Pool,
  tenantCode: string,
  documents: readonly PersistedDocument[],
  presentedBy: string,
): Promise<void> {
  if (documents.length === 0) return;
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const d of documents) {
      await client.query(
        `insert into evidence.presented_document
           (tenant_id, request_id, document_type, validation_status, captured_at_epoch, captured_tsa_digest, captured_tsa_authority, position, correlation_id, created_by)
         values ($1::uuid, $2, $3, $4, $5::bigint, $6, $7, $8, $9, $10)
         on conflict (tenant_id, request_id, position) do nothing`,
        [
          tenant,
          d.requestId,
          d.document.documentType,
          d.document.validationStatus,
          d.document.capturedAt.epochSeconds.toString(),
          d.document.capturedAt.tokenDigest,
          d.document.capturedAt.authorityId,
          d.position,
          d.requestId,
          presentedBy,
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

/** Upserts each record in one transaction: either the whole change is durable or none of it is. */
export async function saveRequests(
  pool: Pool,
  tenantCode: string,
  records: readonly PersistedRequest[],
): Promise<void> {
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
