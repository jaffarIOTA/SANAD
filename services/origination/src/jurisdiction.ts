/**
 * Which jurisdiction the deployment behaves as, and what follows from it
 * (ADR 0005). Administrators choose it in the Admin app under four eyes
 * (migration 0014); every app reads it from here and from nowhere else.
 *
 * With a database: `config.effective_deployment_jurisdiction()`. Without one
 * (development without a database, tests): `SANAD_JURISDICTION` if set to SA
 * or AE, otherwise SA — the platform's original jurisdiction.
 *
 * What follows: the jurisdiction profile (currency, regulator, calendars,
 * permitted rails), and which tenants are active — those onboarded under the
 * same jurisdiction. A tenant onboarded elsewhere is not rewritten; it is
 * simply not served by this deployment until the setting points at it.
 */

import {
  type TenantCode,
  TENANT_CODES,
  loadJurisdictionProfile,
  loadTenantOnboarding,
} from '../../../config/loader.ts';
import type { JurisdictionCode, JurisdictionProfile } from '../../../core/jurisdiction/profile.ts';
import type { Result } from '../../../core/kernel/result.ts';

import { databaseUrlFromEnvironment, sharedPool } from './credentials.ts';

const isJurisdiction = (v: unknown): v is JurisdictionCode => v === 'SA' || v === 'AE';

export async function resolveDeploymentJurisdiction(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<JurisdictionCode> {
  const url = databaseUrlFromEnvironment(env);
  if (url === undefined) {
    const fromEnv = env['SANAD_JURISDICTION']?.trim().toUpperCase();
    return isJurisdiction(fromEnv) ? fromEnv : 'SA';
  }
  const r = await sharedPool(url).query<{ j: string }>('select config.effective_deployment_jurisdiction() as j');
  const j = r.rows[0]?.j?.trim();
  return isJurisdiction(j) ? j : 'SA';
}

export interface DeploymentJurisdiction {
  readonly code: JurisdictionCode;
  readonly profile: Result<JurisdictionProfile>;
  /** Tenants onboarded under this jurisdiction, in the order the deployment lists them. */
  readonly activeTenants: readonly TenantCode[];
}

export function tenantsOf(code: JurisdictionCode): readonly TenantCode[] {
  return TENANT_CODES.filter((t) => {
    const onboarding = loadTenantOnboarding(t);
    return onboarding.ok && onboarding.value.jurisdiction === code;
  });
}

export async function deploymentJurisdiction(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<DeploymentJurisdiction> {
  const code = await resolveDeploymentJurisdiction(env);
  return { code, profile: loadJurisdictionProfile(code), activeTenants: tenantsOf(code) };
}

/** The tenant a screen should act for: the requested one if it is active here, else the first active tenant. */
export function activeTenantFor(requested: string | undefined, active: readonly TenantCode[]): TenantCode | undefined {
  if (requested !== undefined && (active as readonly string[]).includes(requested)) return requested as TenantCode;
  return active[0];
}

export interface DeploymentJurisdictionRevision {
  readonly id: string;
  readonly jurisdiction: JurisdictionCode;
  readonly summary: string;
  readonly status: 'PROPOSED' | 'APPROVED' | 'REJECTED';
  readonly proposedBy: string;
  readonly proposedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly rejectionReason: string | null;
}

export async function listDeploymentJurisdictionRevisions(): Promise<readonly DeploymentJurisdictionRevision[]> {
  const url = databaseUrlFromEnvironment();
  if (url === undefined) return [];
  const r = await sharedPool(url).query<{
    id: string;
    jurisdiction: string;
    summary: string;
    status: DeploymentJurisdictionRevision['status'];
    proposed_by: string;
    proposed_at: Date;
    decided_by: string | null;
    decided_at: Date | null;
    rejection_reason: string | null;
  }>('select * from config.list_deployment_jurisdiction_revisions()');
  return r.rows.map((x) => ({
    id: x.id,
    jurisdiction: (isJurisdiction(x.jurisdiction.trim()) ? x.jurisdiction.trim() : 'SA') as JurisdictionCode,
    summary: x.summary,
    status: x.status,
    proposedBy: x.proposed_by,
    proposedAt: x.proposed_at.toISOString(),
    decidedBy: x.decided_by,
    decidedAt: x.decided_at === null ? null : x.decided_at.toISOString(),
    rejectionReason: x.rejection_reason,
  }));
}

export async function deploymentJurisdictionLocked(): Promise<boolean> {
  const url = databaseUrlFromEnvironment();
  if (url === undefined) return false;
  const r = await sharedPool(url).query<{ locked: boolean }>(
    'select config.deployment_jurisdiction_locked() as locked',
  );
  return r.rows[0]?.locked === true;
}

export async function proposeDeploymentJurisdiction(p: {
  readonly jurisdiction: JurisdictionCode;
  readonly summary: string;
  readonly proposedBy: string;
  readonly correlationId: string;
}): Promise<string> {
  const url = databaseUrlFromEnvironment();
  if (url === undefined) throw new Error('no database: the deployment jurisdiction is chosen in the database');
  const r = await sharedPool(url).query<{ id: string }>(
    'select config.propose_deployment_jurisdiction($1, $2, $3, $4::uuid) as id',
    [p.jurisdiction, p.summary, p.proposedBy, p.correlationId],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error('the proposal returned no id');
  return id;
}

export async function decideDeploymentJurisdiction(p: {
  readonly revisionId: string;
  readonly approve: boolean;
  readonly decidedBy: string;
  readonly reason?: string;
  readonly correlationId: string;
}): Promise<void> {
  const url = databaseUrlFromEnvironment();
  if (url === undefined) throw new Error('no database');
  await sharedPool(url).query('select config.decide_deployment_jurisdiction($1::uuid, $2, $3, $4, $5::uuid)', [
    p.revisionId,
    p.approve,
    p.decidedBy,
    p.reason ?? null,
    p.correlationId,
  ]);
}
