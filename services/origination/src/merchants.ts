/**
 * Merchants on PostgreSQL (`core.merchant`, migration 0012).
 *
 * One store, two readers: the workbench onboards, verifies, suspends and
 * closes; the checkout API asks whether a merchant may transact. Both read
 * the database, so a merchant suspended in the workbench is refused at the
 * next checkout call rather than at the next deployment.
 *
 * Every change of state is written with a chained audit event in the same
 * transaction: who, what it was, what it became. Every statement runs in the
 * tenant's scope (SR-003).
 */

import type { Pool } from 'pg';

import type { Merchant } from '../../../core/merchants/merchant.ts';

import { decodeJson, encodeJson } from './codec.ts';
import { tenantUuidByCode } from './credentials.ts';
import { inTenant } from './tenant-scope.ts';

const asText = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));
const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function loadMerchants(pool: Pool, tenantCode: string): Promise<readonly Merchant[]> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const { rows } = await inTenant(pool, tenant, (db) =>
    db.query<{ merchant: unknown }>(
      'select merchant from core.merchant where tenant_id = $1::uuid order by sequence asc',
      [tenant],
    ),
  );
  return rows.map((r) => decodeJson(asText(r.merchant)) as Merchant);
}

export async function findMerchant(pool: Pool, tenantCode: string, merchantId: string): Promise<Merchant | undefined> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const { rows } = await inTenant(pool, tenant, (db) =>
    db.query<{ merchant: unknown }>(
      'select merchant from core.merchant where tenant_id = $1::uuid and merchant_id = $2',
      [tenant, merchantId],
    ),
  );
  const row = rows[0];
  return row === undefined ? undefined : (decodeJson(asText(row.merchant)) as Merchant);
}

export interface MerchantChange {
  readonly merchant: Merchant;
  /** What happened, for the audit chain: MERCHANT_ONBOARDING_BEGUN, MERCHANT_VERIFIED, MERCHANT_SUSPENDED, … */
  readonly event: string;
  readonly actor: string;
  /** A uuid when the caller has one; otherwise the event is recorded against a fresh correlation. */
  readonly correlationId: string;
}

/** The row and its audit event, or neither. */
export async function saveMerchant(pool: Pool, tenantCode: string, change: MerchantChange): Promise<void> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const m = change.merchant;
  await inTenant(pool, tenant, async (db) => {
    const before = await db.query<{ status: string }>(
      'select status from core.merchant where tenant_id = $1::uuid and merchant_id = $2 for update',
      [tenant, m.core.merchantId],
    );
    await db.query(
      `insert into core.merchant (tenant_id, merchant_id, commercial_registration, status, merchant, correlation_id, created_by)
       values ($1::uuid, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (tenant_id, merchant_id) do update
         set status = excluded.status, merchant = excluded.merchant, updated_at = now()`,
      [
        tenant,
        m.core.merchantId,
        m.core.commercialRegistration,
        m.status,
        encodeJson(m),
        m.core.correlationId,
        change.actor,
      ],
    );
    // The audit subject is a uuid; a merchant's id is text. The subject is derived from it, deterministically.
    await db.query(
      `select audit.record_event($1::uuid, 'core.merchant', md5($1::text || ':' || $2)::uuid, $3,
                                 $4::jsonb, $5::jsonb, $6, coalesce($7::uuid, gen_random_uuid()))`,
      [
        tenant,
        m.core.merchantId,
        change.event,
        before.rows[0] === undefined ? null : JSON.stringify({ status: before.rows[0].status }),
        JSON.stringify({ merchantId: m.core.merchantId, status: m.status }),
        change.actor,
        isUuid(change.correlationId) ? change.correlationId : null,
      ],
    );
  });
}

export interface MerchantActivity {
  readonly state: string;
  readonly sessions: number;
}

/** How a merchant's checkout sessions stand, by state. Counts only; the sessions themselves are the checkout API's. */
export async function merchantActivity(
  pool: Pool,
  tenantCode: string,
  merchantId: string,
): Promise<readonly MerchantActivity[]> {
  const tenant = await tenantUuidByCode(pool, tenantCode);
  const { rows } = await inTenant(pool, tenant, (db) =>
    db.query<{ state: string; sessions: string }>(
      'select state, count(*)::text as sessions from core.checkout_session where tenant_id = $1::uuid and merchant_id = $2 group by state order by state',
      [tenant, merchantId],
    ),
  );
  return rows.map((r) => ({ state: r.state, sessions: Number.parseInt(r.sessions, 10) }));
}
