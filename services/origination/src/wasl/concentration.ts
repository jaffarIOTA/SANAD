/**
 * The concentration rules in force for an institution at a moment (Wasl W5a):
 * the approved CONCENTRATION revision effective then — proposed and approved
 * by two different administrators in Admin — else the checked-in file, else
 * no rule at all. Read at trade validation, so a rule takes effect from its
 * stated moment and no earlier.
 */
import type { Pool } from 'pg';

import { type TenantCode, loadWaslConcentration } from '@sanad/config/loader.ts';
import type { Result } from '@sanad/core/kernel/result.ts';
import {
  type ConcentrationPolicy,
  parseConcentrationPolicy,
} from '@sanad/products/murabaha-scf/limits/drawdown-limits.ts';

import { tenantUuidByCode } from '../credentials.ts';

export interface ResolvedConcentration {
  readonly policy: Result<ConcentrationPolicy>;
  readonly source: 'REVISION' | 'FILE';
  readonly revisionSummary?: string;
}

/** The policy in force and where it came from: an approved revision, or the checked-in file. */
export async function resolveConcentrationWithSource(
  pool: Pool | undefined,
  tenant: TenantCode,
  asOfEpochSeconds: bigint,
): Promise<ResolvedConcentration> {
  if (pool === undefined) return { policy: loadWaslConcentration(tenant), source: 'FILE' };
  const r = await pool.query<{ payload: unknown; summary: string }>(
    'select payload, summary from config.effective_revision($1::uuid, $2, to_timestamp($3::bigint))',
    [await tenantUuidByCode(pool, tenant), 'CONCENTRATION', asOfEpochSeconds.toString()],
  );
  const row = r.rows[0];
  return row === undefined
    ? { policy: loadWaslConcentration(tenant), source: 'FILE' }
    : { policy: parseConcentrationPolicy(row.payload), source: 'REVISION', revisionSummary: row.summary };
}

export async function resolveConcentration(
  pool: Pool | undefined,
  tenant: TenantCode,
  asOfEpochSeconds: bigint,
): Promise<Result<ConcentrationPolicy>> {
  return (await resolveConcentrationWithSource(pool, tenant, asOfEpochSeconds)).policy;
}
