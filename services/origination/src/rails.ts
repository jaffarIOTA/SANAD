/**
 * Which rail configuration is in force for a tenant at a moment: the approved
 * RAILS revision effective then, else the checked-in file. Same shape as the
 * product catalogue resolver; the caller learns which answered.
 */

import { ADAPTER_CATALOGUE } from '../../../adapters/catalogue.ts';
import { type TenantCode, catalogueForTenant, loadRailsConfiguration } from '../../../config/loader.ts';
import { type RailsConfiguration, parseRailsConfiguration } from '../../../core/config/rails.ts';
import type { Result } from '../../../core/kernel/result.ts';

import { databaseUrlFromEnvironment, sharedPool, tenantUuidByCode } from './credentials.ts';

export interface ResolvedRails {
  readonly rails: Result<RailsConfiguration>;
  readonly source: 'REVISION' | 'FILE';
  readonly revisionId?: string;
  readonly revisionSummary?: string;
}

export async function resolveRailsConfiguration(tenant: TenantCode, asOfEpochSeconds: bigint): Promise<ResolvedRails> {
  const url = databaseUrlFromEnvironment();
  if (url === undefined) return { rails: loadRailsConfiguration(tenant, ADAPTER_CATALOGUE), source: 'FILE' };
  const pool = sharedPool(url);
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const r = await pool.query<{ id: string; payload: unknown; summary: string }>(
    'select id, payload, summary from config.effective_revision($1::uuid, $2, to_timestamp($3::bigint))',
    [tenantUuid, 'RAILS', asOfEpochSeconds.toString()],
  );
  const row = r.rows[0];
  if (row === undefined) return { rails: loadRailsConfiguration(tenant, ADAPTER_CATALOGUE), source: 'FILE' };
  const catalogue = catalogueForTenant(tenant, ADAPTER_CATALOGUE);
  if (!catalogue.ok) return { rails: catalogue, source: 'REVISION', revisionId: row.id, revisionSummary: row.summary };
  return { rails: parseRailsConfiguration(row.payload, catalogue.value), source: 'REVISION', revisionId: row.id, revisionSummary: row.summary };
}
