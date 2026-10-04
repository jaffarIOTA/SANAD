/**
 * Which product catalogue is in force for a tenant at a moment.
 *
 * With a database: the approved configuration revision for the PRODUCTS area
 * effective at that moment (migration 0009), parsed by the same strict parser
 * as the file. Without one, or before any revision has been approved: the
 * tenant's checked-in catalogue file. The caller learns which answered.
 */

import { type TenantCode, loadProductCatalogue } from '../../../config/loader.ts';
import type { Result } from '../../../core/kernel/result.ts';
import { type ProductCatalogue, parseProductCatalogue } from '../../../core/products/catalogue.ts';
import { ISLAMIC_PRODUCT_CODES } from '../../../core/products/registry.ts';

import { databaseUrlFromEnvironment, sharedPool, tenantUuidByCode } from './credentials.ts';

export interface ResolvedCatalogue {
  readonly catalogue: Result<ProductCatalogue>;
  readonly source: 'REVISION' | 'FILE';
  readonly revisionId?: string;
  readonly revisionSummary?: string;
}

export async function resolveProductCatalogue(tenant: TenantCode, asOfEpochSeconds: bigint): Promise<ResolvedCatalogue> {
  const url = databaseUrlFromEnvironment();
  if (url === undefined) return { catalogue: loadProductCatalogue(tenant), source: 'FILE' };
  const pool = sharedPool(url);
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const r = await pool.query<{ id: string; payload: unknown; summary: string }>(
    'select id, payload, summary from config.effective_revision($1::uuid, $2, to_timestamp($3::bigint))',
    [tenantUuid, 'PRODUCTS', asOfEpochSeconds.toString()],
  );
  const row = r.rows[0];
  if (row === undefined) return { catalogue: loadProductCatalogue(tenant), source: 'FILE' };
  return { catalogue: parseProductCatalogue(row.payload, ISLAMIC_PRODUCT_CODES), source: 'REVISION', revisionId: row.id, revisionSummary: row.summary };
}
