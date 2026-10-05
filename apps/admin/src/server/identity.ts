/**
 * The Staff identity area: the configuration in force and a proposed
 * replacement, checked by the production parser under the deployment profile
 * the configuration will run in before it may be proposed.
 */

import { type DeploymentProfile, MAX_SESSION_LIFETIME_SECONDS, STAFF_AUTHORITIES, type StaffAuthority, type StaffIdentityConfiguration, parseStaffIdentity } from '@sanad/core/config/staff-identity.ts';
import { type Result, ok, reject } from '@sanad/core/kernel/result.ts';
import { deploymentProfile, resolveStaffIdentity } from '@sanad/origination/staff-identity.ts';

export { MAX_SESSION_LIFETIME_SECONDS, STAFF_AUTHORITIES, deploymentProfile, resolveStaffIdentity };

export interface IdentityForm {
  readonly protocol: string;
  readonly issuer: string;
  readonly metadataUrl?: string;
  readonly clientId?: string;
  readonly groupsClaim: string;
  /** One mapping per line: `group = AUTHORITY`. */
  readonly mappingsText: string;
  readonly sessionLifetimeSeconds: string;
  readonly stepUpForApprovalSeconds?: string;
  readonly version: string;
}

export function mappingsToText(c: StaffIdentityConfiguration): string {
  return c.mappings.map((m) => `${m.group} = ${m.authority}`).join('\n');
}

/** The form as a configuration payload, parsed as production parses it. */
export function identityFromForm(f: IdentityForm, profile: DeploymentProfile): Result<{ readonly payload: unknown; readonly parsed: StaffIdentityConfiguration }> {
  const mappings: { group: string; authority: string }[] = [];
  for (const [i, line] of f.mappingsText.split('\n').entries()) {
    const t = line.trim();
    if (t === '' || t.startsWith('#')) continue;
    const m = /^(.+?)\s*=\s*([A-Z_]+)$/.exec(t);
    if (m === null) return reject('OP-DETERMINACY', 'IDENTITY_MAPPING_LINE', 'Each mapping line is `group = AUTHORITY`', { line: String(i + 1) });
    mappings.push({ group: (m[1] ?? '').trim(), authority: m[2] ?? '' });
  }
  const int = (s: string | undefined): number | undefined => (s === undefined || s.trim() === '' ? undefined : Number.parseInt(s, 10));
  const payload = {
    version: f.version,
    provider: { protocol: f.protocol, issuer: f.issuer, groupsClaim: f.groupsClaim, ...(f.metadataUrl === undefined ? {} : { metadataUrl: f.metadataUrl }), ...(f.clientId === undefined ? {} : { clientId: f.clientId }) },
    mappings,
    sessionLifetimeSeconds: int(f.sessionLifetimeSeconds),
    ...(int(f.stepUpForApprovalSeconds) === undefined ? {} : { stepUpForApprovalSeconds: int(f.stepUpForApprovalSeconds) }),
  };
  const parsed = parseStaffIdentity(payload, profile);
  if (!parsed.ok) return parsed;
  return ok({ payload, parsed: parsed.value });
}

export const isAuthority = (s: string): s is StaffAuthority => (STAFF_AUTHORITIES as readonly string[]).includes(s);
