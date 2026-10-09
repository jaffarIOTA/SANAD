/**
 * The staff identity configuration in force for a tenant at a moment: the
 * approved STAFF_IDENTITY revision, else the checked-in file. The deployment
 * profile comes from the environment: anything but development is DEPLOYED,
 * where a development stand-in provider does not parse at all.
 */

import { type TenantCode, loadStaffIdentity, loadTenantOnboarding } from '../../../config/loader.ts';
import {
  type DeploymentProfile,
  type StaffIdentityConfiguration,
  parseStaffIdentity,
} from '../../../core/config/staff-identity.ts';
import type { Result } from '../../../core/kernel/result.ts';

import { databaseUrlFromEnvironment, sharedPool, tenantUuidByCode } from './credentials.ts';
import { deploymentJurisdiction } from './jurisdiction.ts';

export function deploymentProfile(env: Readonly<Record<string, string | undefined>> = process.env): DeploymentProfile {
  return env['NODE_ENV'] === 'production' || env['SANAD_DEPLOYMENT_PROFILE'] === 'DEPLOYED'
    ? 'DEPLOYED'
    : 'DEVELOPMENT';
}

export interface ResolvedStaffIdentity {
  readonly identity: Result<StaffIdentityConfiguration>;
  readonly source: 'REVISION' | 'FILE';
  readonly profile: DeploymentProfile;
  readonly revisionId?: string;
  readonly revisionSummary?: string;
}

/** An institution a member of staff can sign in to through its identity provider. */
export interface SingleSignOnInstitution {
  readonly tenant: TenantCode;
  readonly nameEn: string;
  readonly nameAr: string;
}

/**
 * The institutions active in the deployment's jurisdiction whose staff
 * identity configuration in force uses OIDC, in the deployment's order. The
 * sign-in page lists these; the person's choice scopes which mappings apply,
 * and nothing else.
 */
export async function singleSignOnInstitutions(asOfEpochSeconds: bigint): Promise<readonly SingleSignOnInstitution[]> {
  const { activeTenants } = await deploymentJurisdiction();
  const out: SingleSignOnInstitution[] = [];
  for (const tenant of activeTenants) {
    const resolved = await resolveStaffIdentity(tenant, asOfEpochSeconds);
    if (!resolved.identity.ok || resolved.identity.value.provider.protocol !== 'OIDC') continue;
    const onboarding = loadTenantOnboarding(tenant);
    out.push({
      tenant,
      nameEn: onboarding.ok ? onboarding.value.legalNameEn : tenant,
      nameAr: onboarding.ok ? onboarding.value.legalNameAr : tenant,
    });
  }
  return out;
}

export async function resolveStaffIdentity(
  tenant: TenantCode,
  asOfEpochSeconds: bigint,
): Promise<ResolvedStaffIdentity> {
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
  return {
    identity: parseStaffIdentity(row.payload, profile),
    source: 'REVISION',
    profile,
    revisionId: row.id,
    revisionSummary: row.summary,
  };
}
