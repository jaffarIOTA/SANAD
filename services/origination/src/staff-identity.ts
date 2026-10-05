/**
 * The staff identity configuration in force for a tenant at a moment: the
 * approved STAFF_IDENTITY revision, else the checked-in file. The deployment
 * profile comes from the environment: anything but development is DEPLOYED,
 * where a development stand-in provider does not parse at all.
 */

import { type TenantCode, loadStaffIdentity } from '../../../config/loader.ts';
import { type DeploymentProfile, type StaffIdentityConfiguration, parseStaffIdentity } from '../../../core/config/staff-identity.ts';
import type { Result } from '../../../core/kernel/result.ts';

import { databaseUrlFromEnvironment, sharedPool, tenantUuidByCode } from './credentials.ts';

export function deploymentProfile(env: Readonly<Record<string, string | undefined>> = process.env): DeploymentProfile {
  return env['NODE_ENV'] === 'production' || env['SANAD_DEPLOYMENT_PROFILE'] === 'DEPLOYED' ? 'DEPLOYED' : 'DEVELOPMENT';
}

export interface ResolvedStaffIdentity {
  readonly identity: Result<StaffIdentityConfiguration>;
  readonly source: 'REVISION' | 'FILE';
  readonly profile: DeploymentProfile;
  readonly revisionId?: string;
  readonly revisionSummary?: string;
}

export async function resolveStaffIdentity(tenant: TenantCode, asOfEpochSeconds: bigint): Promise<ResolvedStaffIdentity> {
  const profile = deploymentProfile();
  const url = databaseUrlFromEnvironment();
  if (url === undefined) return { identity: loadStaffIdentity(tenant, profile), source: 'FILE', profile };
  const pool = sharedPool(url);
  const tenantUuid = await tenantUuidByCode(pool, tenant);
  const r = await pool.query<{ id: string; payload: unknown; summary: string }>(
    'select id, payload, summary from config.effective_revision($1::uuid, $2, to_timestamp($3::bigint))',
    [tenantUuid, 'STAFF_IDENTITY', asOfEpochSeconds.toString()],
  );
  const row = r.rows[0];
  if (row === undefined) return { identity: loadStaffIdentity(tenant, profile), source: 'FILE', profile };
  return { identity: parseStaffIdentity(row.payload, profile), source: 'REVISION', profile, revisionId: row.id, revisionSummary: row.summary };
}
