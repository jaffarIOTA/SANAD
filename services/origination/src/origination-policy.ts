/**
 * The origination policy in force for a tenant at a moment: the approved
 * ORIGINATION_POLICY revision, else the checked-in file. Partner and agent
 * entitlements, approval tiers, expiries and SLAs all live in it.
 */

import { type TenantCode, loadOriginationPolicy } from '../../../config/loader.ts';
import type { Result } from '../../../core/kernel/result.ts';
import { type OriginationPolicy, parseOriginationPolicy } from '../../../core/origination/policy.ts';

import { databaseUrlFromEnvironment, sharedPool, tenantUuidByCode } from './credentials.ts';

export interface ResolvedOriginationPolicy {
  readonly policy: Result<OriginationPolicy>;
  readonly source: 'REVISION' | 'FILE';
  readonly revisionId?: string;
  readonly revisionSummary?: string;
}

export async function resolveOriginationPolicy(
  tenant: TenantCode,
  asOfEpochSeconds: bigint,
): Promise<ResolvedOriginationPolicy> {
  const url = databaseUrlFromEnvironment();
  if (url === undefined) return { policy: loadOriginationPolicy(tenant), source: 'FILE' };
  const pool = sharedPool(url);
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const r = await pool.query<{ id: string; payload: unknown; summary: string }>(
    'select id, payload, summary from config.effective_revision($1::uuid, $2, to_timestamp($3::bigint))',
    [tenantUuid, 'ORIGINATION_POLICY', asOfEpochSeconds.toString()],
  );
  const row = r.rows[0];
  if (row === undefined) return { policy: loadOriginationPolicy(tenant), source: 'FILE' };
  return {
    policy: parseOriginationPolicy(row.payload),
    source: 'REVISION',
    revisionId: row.id,
    revisionSummary: row.summary,
  };
}
